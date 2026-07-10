// /api/buildset — Vercel 서버리스 (캠페인 + 광고세트 실제 생성)
// GitHub 리포에는 반드시 "api/buildset.js"(api 폴더 안)로 올리세요.
// 동작:
//   1) 캠페인: 신규 생성(campaign{...}) 또는 기존 사용(campaignId)
//   2) 광고세트: adsets[] 를 그 캠페인 아래에 각각 PAUSED 로 생성
// 요청(POST JSON): {
//   act,                         // 광고 계정(act_ 제거)
//   apply,                       // true=실제 생성, 아니면 dry-run(검증만)
//   campaign?: { name, objective, buyingType?, budgetMode('ABO'|'CBO'),
//                dailyBudget?(원, CBO), bidStrategy? },
//   campaignId?,                 // 기존 캠페인에 붙일 때
//   adsets: [ { name, optimizationGoal, billingEvent?, budgetMode,
//               dailyBudget?(원, ABO), bidStrategy?, bidAmount?(원),
//               targeting(obj), pixelId?, customEventType?, pageId?, startTime? } ]
// }
// 토큰은 clonead 와 동일(사용자 연동 토큰 우선 → 서버 META_TOKEN). @egnis.kr 로그인 필수.

const GRAPH = 'https://graph.facebook.com/v21.0';
const enc = encodeURIComponent;
const crypto = require('crypto');
const PROJECT_ID = 'cloop-sprint-adops';

let _certCache = null, _certAt = 0;
async function getCerts() {
  if (_certCache && (Date.now() - _certAt) < 3600000) return _certCache;
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  _certCache = await r.json(); _certAt = Date.now(); return _certCache;
}
async function verifyUser(req) {
  try {
    const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const m = /^Bearer (.+)$/.exec(auth); if (!m) return null;
    const parts = m[1].split('.'); if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.aud !== PROJECT_ID) return null;
    if (payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    if (!payload.email || !/@egnis\.kr$/i.test(payload.email)) return null;
    const certs = await getCerts(); const cert = certs[header.kid]; if (!cert) return null;
    const v = crypto.createVerify('RSA-SHA256'); v.update(parts[0] + '.' + parts[1]); v.end();
    if (!v.verify(crypto.createPublicKey(cert), Buffer.from(parts[2], 'base64url'))) return null;
    return payload;
  } catch (e) { return null; }
}
async function readJson(req) {
  if (req.body) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) {} }
  }
  return await new Promise(function (resolve) {
    let d = '';
    req.on('data', function (c) { d += c; });
    req.on('end', function () { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
    req.on('error', function () { resolve({}); });
  });
}
function friendlyErr(e) {
  if (!e) return '알 수 없는 오류';
  if (e.code === 200 || e.code === 190) return '광고 계정/토큰 권한 문제입니다 — 관리자에게 문의하세요.';
  if (e.code === 100) return (e.error_user_msg || e.message || '입력값 오류') + ' (필수 설정값을 확인하세요)';
  return e.error_user_msg || e.message || JSON.stringify(e);
}
async function gpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) { const err = new Error(friendlyErr(j.error)); err.meta = j.error; throw err; }
  return j;
}

// ODAX 목표만 허용 (레거시 목표는 거부됨)
const OBJECTIVES = ['OUTCOME_SALES', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_AWARENESS', 'OUTCOME_APP_PROMOTION'];
// 목표별 기본 최적화 목표
const DEFAULT_OPT = {
  OUTCOME_SALES: 'OFFSITE_CONVERSIONS', OUTCOME_TRAFFIC: 'LINK_CLICKS',
  OUTCOME_ENGAGEMENT: 'POST_ENGAGEMENT', OUTCOME_LEADS: 'OFFSITE_CONVERSIONS',
  OUTCOME_AWARENESS: 'REACH', OUTCOME_APP_PROMOTION: 'APP_INSTALLS'
};
// 픽셀 기반 전환 최적화(promoted_object 에 pixel 필요)
const NEEDS_PIXEL = { OFFSITE_CONVERSIONS: 1, VALUE: 1, LANDING_PAGE_VIEWS: 1 };
const BID_STRATS = ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS'];

function budgetStr(v) { // 원 단위 정수 문자열 (KRW=zero-decimal → 그대로)
  const n = Math.round(Number(v || 0));
  return (n > 0) ? String(n) : null;
}

module.exports = async function (req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST 요청만 허용' });
    const _user = await verifyUser(req);
    if (!_user) return res.status(401).json({ ok: false, error: '로그인이 필요합니다 — 회사 구글 계정(@egnis.kr)으로 로그인 후 사용하세요.' });

    // 토큰: 사용자 연동 토큰 우선 → 서버 META_TOKEN (clonead 와 동일)
    let token = null, tokenSource = 'personal';
    try {
      const _dbUrl = (process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
      const _dbSecret = process.env.FIREBASE_DB_SECRET || '';
      const _uid = _user.user_id || _user.sub || _user.uid;
      const _authQ = _dbSecret ? ('?auth=' + enc(_dbSecret)) : '';
      const _rec = await fetch(_dbUrl + '/meta_tokens/' + enc(_uid) + '.json' + _authQ).then(r => r.json());
      if (_rec && _rec.tokenEnc && _rec.iv && _rec.tag && (!_rec.expiresAt || _rec.expiresAt > Date.now()) && process.env.TOKEN_ENC_KEY) {
        const _k = crypto.createHash('sha256').update(process.env.TOKEN_ENC_KEY).digest();
        const _d = crypto.createDecipheriv('aes-256-gcm', _k, Buffer.from(_rec.iv, 'base64'));
        _d.setAuthTag(Buffer.from(_rec.tag, 'base64'));
        token = _d.update(_rec.tokenEnc, 'base64', 'utf8') + _d.final('utf8');
      }
    } catch (e) { token = null; }
    if (!token) { token = process.env.META_TOKEN; tokenSource = 'server'; }
    if (!token) return res.status(403).json({ ok: false, error: 'Meta 계정을 연동해야 광고를 만들 수 있습니다 — 좌측 하단에서 연동하세요.', needConnect: true });

    const b = await readJson(req);
    const act = String(b.act || '').replace(/^act_/, '').trim();
    const apply = b.apply === true;

    // 픽셀 목록 조회: { listPixels:true, act } → 이 계정에서 쓸 수 있는 픽셀 [{id,name}] (드롭다운용)
    if (b.listPixels === true) {
      if (!act) return res.status(400).json({ ok: false, error: '광고 계정(act)이 필요합니다' });
      try {
        const pj = await fetch(GRAPH + '/act_' + act + '/adspixels?fields=id,name&limit=100&access_token=' + enc(token)).then(function (r) { return r.json(); });
        const seen = {}, out = [];
        ((pj && pj.data) || []).forEach(function (p) { if (p && p.id && !seen[p.id]) { seen[p.id] = 1; out.push({ id: String(p.id), name: p.name || '' }); } });
        return res.status(200).json({ ok: true, pixels: out });
      } catch (e) { return res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
    }

    // 캠페인 목록 조회: { listCampaigns:true, act } → 이 계정의 캠페인 [{id,name,status,active}] (ⓑ 대상 선택용)
    if (b.listCampaigns === true) {
      if (!act) return res.status(400).json({ ok: false, error: '광고 계정(act)이 필요합니다' });
      try {
        const cj = await fetch(GRAPH + '/act_' + act + '/campaigns?fields=id,name,effective_status&limit=300&access_token=' + enc(token)).then(function (r) { return r.json(); });
        const out = ((cj && cj.data) || []).map(function (c) {
          const st = String(c.effective_status || '').toUpperCase();
          return { id: String(c.id), name: c.name || String(c.id), status: st, active: st === 'ACTIVE' };
        });
        return res.status(200).json({ ok: true, campaigns: out });
      } catch (e) { return res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
    }

    const campaignId = String(b.campaignId || '').trim();
    const campaign = b.campaign || null;
    const adsets = Array.isArray(b.adsets) ? b.adsets : [];

    // 캠페인만 생성 모드: 신규 campaign 만 넘기고 adsets 는 비움
    const campaignOnly = (b.campaignOnly === true) || (!!campaign && !campaignId && !adsets.length);
    if (!act) return res.status(400).json({ ok: false, error: '광고 계정(act)이 필요합니다' });
    if (!campaign && !campaignId) return res.status(400).json({ ok: false, error: 'campaign(신규) 또는 campaignId(기존) 중 하나는 필수' });
    if (!campaignOnly && !adsets.length) return res.status(400).json({ ok: false, error: '광고세트가 최소 1개 필요합니다' });
    if (campaignOnly && !campaign) return res.status(400).json({ ok: false, error: '캠페인만 생성하려면 신규 campaign 정보가 필요합니다' });

    // ── 캠페인 페이로드 구성 ──
    let campPayload = null;
    if (campaign) {
      const objective = OBJECTIVES.indexOf(String(campaign.objective || '')) >= 0 ? campaign.objective : 'OUTCOME_SALES';
      campPayload = {
        name: String(campaign.name || '').trim(),
        objective: objective,
        buying_type: campaign.buyingType || 'AUCTION',
        special_ad_categories: Array.isArray(campaign.specialAdCategories) ? campaign.specialAdCategories : [],
        status: 'PAUSED'
      };
      if (!campPayload.name) return res.status(400).json({ ok: false, error: '캠페인명을 입력하세요' });
      if (String(campaign.budgetMode) === 'CBO') {
        const db = budgetStr(campaign.dailyBudget);
        if (!db) return res.status(400).json({ ok: false, code: 'CBO_BUDGET_MISSING', error: 'CBO는 캠페인 일 예산이 필요합니다' });
        campPayload.daily_budget = db;
        campPayload.bid_strategy = BID_STRATS.indexOf(String(campaign.bidStrategy)) >= 0 ? campaign.bidStrategy : 'LOWEST_COST_WITHOUT_CAP';
      } else {
        // ABO(캠페인 예산 미사용): 메타가 is_adset_budget_sharing_enabled 명시를 요구 → false(예산 공유 안 함)
        campPayload.is_adset_budget_sharing_enabled = false;
      }
    }
    const isCBO = !!(campaign && String(campaign.budgetMode) === 'CBO');
    const objectiveEff = campaign ? campPayload.objective : (b.objective || 'OUTCOME_SALES');

    // 전환 목표인데 픽셀 미지정 → 계정의 픽셀을 자동 사용(마케터가 고를 필요 없게)
    let autoPixel = null;
    const _needPixelAny = adsets.some(function (a) { return NEEDS_PIXEL[String(a.optimizationGoal || DEFAULT_OPT[objectiveEff] || 'OFFSITE_CONVERSIONS')] && !a.pixelId; });
    if (_needPixelAny) {
      try {
        const pj = await fetch(GRAPH + '/act_' + act + '/adspixels?fields=id,name&access_token=' + enc(token)).then(function (r) { return r.json(); });
        const px = (pj && pj.data && pj.data[0]) || null;
        if (px && px.id) autoPixel = String(px.id);
      } catch (e) {}
    }

    // ── 광고세트 페이로드들 구성 + 검증 ──
    const adPayloads = []; const gaps = [];
    for (let i = 0; i < adsets.length; i++) {
      const a = adsets[i];
      const nm = String(a.name || '').trim();
      const optGoal = String(a.optimizationGoal || DEFAULT_OPT[objectiveEff] || 'OFFSITE_CONVERSIONS');
      const targeting = (a.targeting && typeof a.targeting === 'object') ? a.targeting : { geo_locations: { countries: ['KR'] } };
      if (!targeting.geo_locations || !((targeting.geo_locations.countries || []).length)) targeting.geo_locations = { countries: ['KR'] };
      // 어드밴티지+ 오디언스: 기본 OFF(0) — 정의한 연령/타게팅을 그대로 적용(제안 아님). true면 Meta 자동 확장 ON(1).
      targeting.targeting_automation = { advantage_audience: (a.advantageAudience === true ? 1 : 0) };
      // 노출위치: 기본 자동(어드밴티지+). 수동이면 플랫폼/포지션 지정(미지정 시 해당 플랫폼 전체 포지션).
      if (a.placements && a.placements.mode === 'manual') {
        var _pl = a.placements;
        if (Array.isArray(_pl.publisher_platforms) && _pl.publisher_platforms.length) targeting.publisher_platforms = _pl.publisher_platforms;
        if (Array.isArray(_pl.facebook_positions) && _pl.facebook_positions.length) targeting.facebook_positions = _pl.facebook_positions;
        if (Array.isArray(_pl.instagram_positions) && _pl.instagram_positions.length) targeting.instagram_positions = _pl.instagram_positions;
      }
      const p = {
        name: nm,
        optimization_goal: optGoal,
        billing_event: a.billingEvent || 'IMPRESSIONS',
        targeting: targeting,
        status: 'PAUSED'
      };
      if (a.startTime) p.start_time = a.startTime;
      // 전환/픽셀 필요 목표
      if (NEEDS_PIXEL[optGoal]) {
        const _pix = a.pixelId || autoPixel;
        if (!_pix) { gaps.push('[' + (nm || ('세트' + (i + 1))) + '] 이 계정에 전환 픽셀이 없습니다 — 픽셀을 먼저 설치하세요'); }
        else { p.promoted_object = { pixel_id: String(_pix), custom_event_type: a.customEventType || 'PURCHASE' }; if (a.pageId) p.promoted_object.page_id = String(a.pageId); }
      } else if (a.pageId) {
        p.promoted_object = { page_id: String(a.pageId) };
      }
      // 기여 설정(전환 목표): 기본 클릭 7일 + 조회 1일 + 참여(조회) 1일 = 1d_view_7d_click_1d_ev.
      // 요청에 attributionSpec 배열이 오면 그대로 사용(향후 UI 선택 대비).
      if (optGoal === 'OFFSITE_CONVERSIONS' || optGoal === 'VALUE') {
        p.attribution_spec = (Array.isArray(a.attributionSpec) && a.attributionSpec.length) ? a.attributionSpec : [
          { event_type: 'CLICK_THROUGH', window_days: 7 },
          { event_type: 'VIEW_THROUGH', window_days: 1 },
          { event_type: 'ENGAGED_VIDEO_VIEW', window_days: 1 }
        ];
      }
      // 예산: ABO 면 광고세트에, CBO 면 캠페인에(여기선 미포함)
      if (!isCBO) {
        const db = budgetStr(a.dailyBudget);
        if (!db) { gaps.push('[' + (nm || ('세트' + (i + 1))) + '] 광고세트 일 예산이 필요합니다(ABO)'); }
        else {
          p.daily_budget = db;
          p.bid_strategy = BID_STRATS.indexOf(String(a.bidStrategy)) >= 0 ? a.bidStrategy : 'LOWEST_COST_WITHOUT_CAP';
          if ((p.bid_strategy === 'LOWEST_COST_WITH_BID_CAP' || p.bid_strategy === 'COST_CAP')) {
            const ba = budgetStr(a.bidAmount);
            if (ba) p.bid_amount = ba; else gaps.push('[' + (nm || ('세트' + (i + 1))) + '] ' + p.bid_strategy + '는 bid_amount 가 필요합니다');
          }
        }
      }
      if (!nm) gaps.push('세트 ' + (i + 1) + ' 이름이 비어있습니다');
      adPayloads.push(p);
    }

    // ── dry-run: 검증 결과 + 페이로드 반환(생성 안 함) ──
    if (!apply) {
      return res.status(200).json({
        ok: gaps.length === 0, dryRun: true, gaps: gaps,
        tokenSource: tokenSource, budgetMode: isCBO ? 'CBO' : 'ABO', pixel: ((adPayloads[0] && adPayloads[0].promoted_object && adPayloads[0].promoted_object.pixel_id) || autoPixel || null),
        campaign: campPayload, campaignId: campaignId || null, adsets: adPayloads, count: adPayloads.length
      });
    }
    if (gaps.length) return res.status(422).json({ ok: false, code: 'GAPS', gaps: gaps, error: '생성 전 보완이 필요합니다:\n• ' + gaps.join('\n• ') });

    // ── 실제 생성 ──
    let campId = campaignId, createdCampaign = null;
    if (campaign) {
      const cj = await gpost(GRAPH + '/act_' + act + '/campaigns?access_token=' + enc(token), campPayload);
      campId = cj.id;
      if (!campId) throw new Error('캠페인 생성 실패');
      createdCampaign = { id: campId, name: campPayload.name };
    }

    const created = [], failed = [];
    for (let i = 0; i < adPayloads.length; i++) {
      const p = Object.assign({ campaign_id: campId }, adPayloads[i]);
      try {
        const aj = await gpost(GRAPH + '/act_' + act + '/adsets?access_token=' + enc(token), p);
        created.push({ id: aj.id, name: p.name });
      } catch (e) {
        failed.push({ name: p.name, error: String((e && e.message) || e) });
      }
    }

    return res.status(200).json({
      ok: failed.length === 0, tokenSource: tokenSource,
      campaign: createdCampaign, campaignId: campId,
      created: created, failed: failed, createdCount: created.length, failedCount: failed.length
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
