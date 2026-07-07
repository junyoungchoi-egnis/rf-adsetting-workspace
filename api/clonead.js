// /api/clonead — Vercel 서버리스 (소재를 대상 세트에 복제 생성 / 신규 소재 생성)
// GitHub 리포에는 반드시 "api/clonead.js"(api 폴더 안)로 올리세요.
// 두 가지 모드:
//  (A) 기존 복제: srcCreativeId 의 소재 스펙을 그대로 복사 + 링크 utm만 대상 기준으로 교정.
//  (B) 신규 생성: newSpec(페이지·에셋·문구·CTA·랜딩)으로 새 소재 스펙을 구성 + 링크 utm 교정.
// 공통: 새 소재 생성 → 대상 광고세트에 새 광고를 PAUSED 로 생성.
// 요청(POST JSON): { act, targetAdsetId, newName, utmCampaign, utmContent, apply,
//                    srcCreativeId?,  // (A)
//                    newSpec? }       // (B) {page_id, instagram_actor_id?, link, message, name, description, image_hash?, video_id?, cta?}
//   apply!==true 이면 dry-run. 토큰은 환경변수(META_TOKEN).

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
// 로그인된 회사(@egnis.kr) 사용자만 허용 — Firebase ID 토큰 검증
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
  // Meta 오류를 사람이 읽을 수 있는 메시지로
  if (!e) return '알 수 없는 오류';
  if (e.code === 10 || e.error_subcode === 1341012) return '이 소재의 페이지에 게시 권한이 없습니다 — 권한 있는 페이지의 소재를 쓰거나 관리자에게 페이지 권한을 요청하세요.';
  if (e.code === 200 || e.code === 190) return '광고 계정/토큰 권한 문제입니다 — 관리자에게 문의하세요.';
  return e.error_user_msg || e.message || JSON.stringify(e);
}
async function gget(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(friendlyErr(j.error));
  return j;
}
async function gpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(friendlyErr(j.error));
  return j;
}

function fixUtm(str, camp, cont) {
  if (!str) return str;
  let s = str;
  s = s.replace(/([?&]utm_campaign=)[^&#]*/i, '$1' + enc(camp));
  s = s.replace(/([?&]utm_content=)[^&#]*/i, '$1' + enc(cont));
  return s;
}
function stripEmpty(o) {
  if (o && typeof o === 'object') {
    Object.keys(o).forEach(function (k) {
      const v = o[k];
      if (v === undefined || v === null || v === '') { delete o[k]; }
      else if (typeof v === 'object') { stripEmpty(v); }
    });
  }
  return o;
}

// (A) 기존 소재 스펙 → 생성 가능한 clean 스펙 + 링크 utm 교정
function cleanFromSource(spec, utmCampaign, utmContent) {
  const clean = { page_id: spec.page_id };
  // instagram_actor_id 는 v22(2025)부터 지원 중단 → instagram_user_id 로 전송해야 IG 계정이 붙음.
  var _igSrc = spec.instagram_user_id || spec.instagram_actor_id;
  if (_igSrc) clean.instagram_user_id = _igSrc;
  if (spec.link_data) {
    const d = spec.link_data;
    clean.link_data = { link: fixUtm(d.link, utmCampaign, utmContent), message: d.message, name: d.name, description: d.description, image_hash: d.image_hash };
    if (d.call_to_action) {
      clean.link_data.call_to_action = { type: d.call_to_action.type, value: {} };
      if (d.call_to_action.value && d.call_to_action.value.link) {
        clean.link_data.call_to_action.value.link = fixUtm(d.call_to_action.value.link, utmCampaign, utmContent);
      }
    }
  }
  if (spec.video_data) {
    const v = spec.video_data;
    clean.video_data = { video_id: v.video_id, message: v.message, title: v.title, link_description: v.link_description, image_hash: v.image_hash };
    if (v.call_to_action) {
      clean.video_data.call_to_action = { type: v.call_to_action.type, value: {} };
      if (v.call_to_action.value && v.call_to_action.value.link) {
        clean.video_data.call_to_action.value.link = fixUtm(v.call_to_action.value.link, utmCampaign, utmContent);
      }
    }
  }
  return stripEmpty(clean);
}

// (B) newSpec(클라이언트 입력) → 생성 가능한 clean 스펙 + 링크 utm 교정
function cleanFromNew(ns, utmCampaign, utmContent) {
  if (!ns || !ns.page_id) return null;
  const link = fixUtm(ns.link || '', utmCampaign, utmContent);
  const cta = ns.cta ? { type: ns.cta, value: (link ? { link: link } : {}) } : null;
  const clean = { page_id: ns.page_id };
  // instagram_actor_id 지원 중단 → instagram_user_id 로 전송(선택된 IG가 실제로 붙게).
  var _igNew = ns.instagram_user_id || ns.instagram_actor_id;
  if (_igNew) clean.instagram_user_id = _igNew;
  if (ns.video_id) {
    clean.video_data = { video_id: ns.video_id, message: ns.message, title: ns.name, link_description: ns.description, image_hash: ns.image_hash };
    if (cta) clean.video_data.call_to_action = cta;
  } else {
    clean.link_data = { link: link, message: ns.message, name: ns.name, description: ns.description, image_hash: ns.image_hash };
    if (cta) clean.link_data.call_to_action = cta;
  }
  return stripEmpty(clean);
}

module.exports = async function (req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST 요청만 허용' });
    const _user = await verifyUser(req);
    if (!_user) return res.status(401).json({ ok: false, error: '로그인이 필요합니다 — 회사 구글 계정(@egnis.kr)으로 로그인 후 사용하세요.' });
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
    if (!token) return res.status(403).json({ ok: false, error: 'Meta 계정을 연동해야 광고를 생성할 수 있습니다 — 좌측 하단에서 연동하세요.', needConnect: true });

    const b = await readJson(req);
    const act = String(b.act || '').replace(/^act_/, '').trim();
    const srcCreativeId = String(b.srcCreativeId || '').trim();
    const targetAdsetId = String(b.targetAdsetId || '').trim();
    const newName = String(b.newName || '').trim();
    const utmCampaign = String(b.utmCampaign || '').trim();
    const utmContent = String(b.utmContent || '').trim();
    const newSpec = b.newSpec || null;
    const apply = b.apply === true;

    // 페이지별 연결 IG 조회: { pagesIg: [pageId,...] } → { [pageId]: { name, ig:{id,username} } }
    // 페이지 선택 시 그 페이지의 인스타그램 계정을 UI/자동첨부에 쓰기 위함.
    if (Array.isArray(b.pagesIg)) {
      const ids = b.pagesIg.map(String).filter(Boolean).slice(0, 300);
      const out = {};
      // Graph Batch API: 페이지별 개별 요청 → 접근 불가 페이지가 있어도 나머지는 정상 반환.
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const batch = chunk.map(id => ({ method: 'GET', relative_url: id + '?fields=name,picture{url},instagram_business_account{id,username,profile_picture_url},connected_instagram_account{id,username,profile_picture_url}' }));
        try {
          const r = await fetch(GRAPH + '/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'access_token=' + enc(token) + '&batch=' + enc(JSON.stringify(batch)) });
          const arr = await r.json();
          if (Array.isArray(arr)) arr.forEach((item, idx) => {
            if (!item || item.code !== 200 || !item.body) return;
            let p; try { p = JSON.parse(item.body); } catch (e) { return; }
            const ig = p.instagram_business_account || p.connected_instagram_account || null;
            const ppic = (p.picture && p.picture.data && p.picture.data.url) || '';
            if (ig && ig.id) out[chunk[idx]] = { name: p.name || '', pic: ppic, ig: { id: ig.id, username: ig.username || '', pic: ig.profile_picture_url || '' } };
            else if (ppic) out[chunk[idx]] = { name: p.name || '', pic: ppic, ig: null };
          });
        } catch (e) {}
      }
      return res.status(200).json({ ok: true, pagesIg: out });
    }

    // 비즈니스 소유 IG 전체 조회: { bizIg:true, act } → { bizIg:[{id,username}] }
    // 계정/페이지 연결과 무관하게 비즈니스가 소유한 모든 IG를 나열(전체 목록용). 타임아웃 가드.
    if (b.bizIg === true) {
      const seen = {}, out = [];
      const T = (u) => fetch(u, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => null);
      const drain = async (base) => { let url = base; for (let p = 0; p < 6 && url; p++) { const j = await T(url); if (!j || j.error) break; (j.data || []).forEach(g => { if (g && g.id && !seen[g.id]) { seen[g.id] = 1; out.push({ id: g.id, username: g.username || '', pic: g.profile_picture_url || '' }); } }); url = (j.paging && j.paging.next) || null; } };
      try {
        const ac = await T(GRAPH + '/act_' + act + '?fields=business&access_token=' + enc(token));
        const bid = ac && ac.business && ac.business.id;
        if (bid) {
          await drain(GRAPH + '/' + bid + '/owned_instagram_accounts?fields=id,username,profile_picture_url&limit=100&access_token=' + enc(token));
          await drain(GRAPH + '/' + bid + '/instagram_accounts?fields=id,username,profile_picture_url&limit=100&access_token=' + enc(token));
        }
      } catch (e) {}
      return res.status(200).json({ ok: true, bizIg: out });
    }

    // 페이지 게시권한 진단: { listPages:true } → 서버 토큰(rf API 시스템사용자)이 접근 가능한 페이지 + tasks.
    // tasks에 CREATE_CONTENT/MANAGE 있으면 그 페이지로 광고(게시) 생성 가능. 없으면 복제 시 code 10로 실패.
    if (b.listPages === true) {
      const out = []; const seen = {};
      let url = GRAPH + '/me/accounts?fields=id,name,tasks&limit=100&access_token=' + enc(token);
      for (let p = 0; p < 12 && url; p++) {
        const j = await fetch(url).then(function (r) { return r.json(); }).catch(function () { return null; });
        if (!j || j.error) break;
        (j.data || []).forEach(function (pg) {
          if (!pg || !pg.id || seen[pg.id]) return; seen[pg.id] = 1;
          const tasks = pg.tasks || [];
          const canPublish = tasks.indexOf('CREATE_CONTENT') >= 0 || tasks.indexOf('MANAGE') >= 0;
          out.push({ id: pg.id, name: pg.name || '', tasks: tasks, canPublish: canPublish });
        });
        url = (j.paging && j.paging.next) || null;
      }
      return res.status(200).json({ ok: true, pages: out });
    }

    // 복제 소스 온디맨드 검색: { searchAds:"<이름 일부>", act } → 활성·중지 무관하게 이름 매칭 광고 반환.
    // (동기화 스냅샷은 활성 광고만 담아 일시중지 소재가 복제 목록에 안 뜸 → 이 검색으로 찾아 srcCreativeId로 복제)
    if (typeof b.searchAds === 'string' && b.searchAds.trim()) {
      if (!act) return res.status(400).json({ ok: false, error: '검색: 광고 계정(act)이 필요합니다' });
      const q = b.searchAds.trim().slice(0, 100);
      const filt = JSON.stringify([
        { field: 'name', operator: 'CONTAIN', value: q },
        { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED'] }
      ]);
      const surl = GRAPH + '/act_' + act + '/ads?fields=name,effective_status,creative{id}&filtering=' + enc(filt) + '&limit=50&access_token=' + enc(token);
      try {
        const sr = await fetch(surl); const sj = await sr.json();
        if (sj.error) return res.status(200).json({ ok: false, error: friendlyErr(sj.error) });
        const out = (sj.data || []).map(function (a) { return { cid: (a.creative && a.creative.id) || '', name: a.name || '', status: a.effective_status || '' }; }).filter(function (a) { return a.cid; });
        return res.status(200).json({ ok: true, searchedAds: out });
      } catch (e) { return res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
    }

    // 실시간 메타 미리보기: { preview:true, act, previewSpec:{object_story_spec 내용}, previewFormats:[게재위치...] }
    // 생성하지 않고 generatepreviews 로 실제 렌더링 iframe(HTML)을 게재위치별로 반환.
    // 생성 검증(targetAdsetId/newName 등)과 무관하므로 초기 분기에서 바로 처리.
    if (b.preview === true && b.previewSpec && typeof b.previewSpec === 'object') {
      if (!act) return res.status(400).json({ ok: false, error: '미리보기: 광고 계정(act)이 필요합니다' });
      const oss = b.previewSpec;
      let specForPrev;
      if (oss.object_story_id) {
        // 기존 게시물(스토리) 소재
        specForPrev = { object_story_id: oss.object_story_id };
      } else {
        // instagram_actor_id 지원 중단 → instagram_user_id 로 정규화
        if (oss.instagram_actor_id && !oss.instagram_user_id) oss.instagram_user_id = oss.instagram_actor_id;
        delete oss.instagram_actor_id;
        // 명시 IG 없으면 페이지 연결 IG 자동 첨부(생성과 동일 동작) → IG 게재 미리보기 정상화
        if (oss.page_id && !oss.instagram_user_id) {
          try {
            const _pg = await gget(GRAPH + '/' + oss.page_id + '?fields=instagram_business_account,connected_instagram_account&access_token=' + enc(token));
            const _iid = (_pg && _pg.instagram_business_account && _pg.instagram_business_account.id)
                      || (_pg && _pg.connected_instagram_account && _pg.connected_instagram_account.id) || null;
            if (_iid) oss.instagram_user_id = _iid;
          } catch (e) {}
        }
        specForPrev = { object_story_spec: oss };
      }
      const fmts = (Array.isArray(b.previewFormats) ? b.previewFormats : []).map(String).filter(Boolean).slice(0, 8);
      if (!fmts.length) return res.status(400).json({ ok: false, error: '미리보기: previewFormats 가 필요합니다' });
      const previews = {};
      await Promise.all(fmts.map(async function (fmt) {
        try {
          const purl = GRAPH + '/act_' + act + '/generatepreviews?ad_format=' + enc(fmt)
                     + '&creative=' + enc(JSON.stringify(specForPrev)) + '&access_token=' + enc(token);
          const pr = await gget(purl);
          const body = (pr && pr.data && pr.data[0] && pr.data[0].body) || '';
          previews[fmt] = body ? { body: body } : { error: '이 게재위치는 미리보기를 만들 수 없습니다' };
        } catch (e) { previews[fmt] = { error: String((e && e.message) || e) }; }
      }));
      return res.status(200).json({ ok: true, previews: previews, instagramUserId: oss.instagram_user_id || null });
    }

    if (!act || !targetAdsetId || !newName || !utmCampaign || !utmContent) {
      return res.status(400).json({ ok: false, error: '필수값 누락 (act, targetAdsetId, newName, utmCampaign, utmContent)' });
    }
    if (!srcCreativeId && !newSpec) {
      return res.status(400).json({ ok: false, error: 'srcCreativeId 또는 newSpec 중 하나는 필수' });
    }

    let clean, newTags;
    if (srcCreativeId) {
      // (A) 기존 복제
      const cr = await gget(GRAPH + '/' + srcCreativeId + '?fields=name,object_type,url_tags,object_story_spec&access_token=' + enc(token));
      const spec = cr.object_story_spec;
      if (!spec || (!spec.link_data && !spec.video_data)) {
        return res.status(422).json({ ok: false, error: '인라인 소재 아님 (object_type=' + (cr.object_type || '?') + ')' });
      }
      clean = cleanFromSource(spec, utmCampaign, utmContent);
      newTags = fixUtm(cr.url_tags || '', utmCampaign, utmContent);
    } else {
      // (B) 신규 생성
      clean = cleanFromNew(newSpec, utmCampaign, utmContent);
      if (!clean) return res.status(422).json({ ok: false, error: 'newSpec 필수값 부족 (page_id 등)' });
      if (!clean.link_data && !clean.video_data) return res.status(422).json({ ok: false, error: 'newSpec 에 에셋(image_hash/video_id) 또는 링크 필요' });
      var _hasAsset = (clean.link_data && (clean.link_data.image_hash || clean.link_data.link)) || (clean.video_data && clean.video_data.video_id);
      if (!_hasAsset) return res.status(422).json({ ok: false, error: '에셋(이미지 해시·영상) 또는 랜딩 링크가 필요합니다' });
      // 플레이스홀더(<...>)가 그대로 넘어오면 = 클라이언트에서 에셋/랜딩이 실제로 선택·입력 안 됨.
      // (예: 영상 소재인데 video_id가 안 잡혀 image_hash에 '<애셋 미선택>'이 새어 들어감) → 메타에 잘못된 값 보내지 말고 명확히 차단.
      var _isPh = function (v) { return typeof v === 'string' && v.indexOf('<') >= 0; };
      if (clean.link_data && _isPh(clean.link_data.image_hash)) return res.status(422).json({ ok: false, code: 'ASSET_NOT_SELECTED', error: '소재(이미지)가 선택되지 않았습니다 — 이미지를 다시 고르거나, 영상 소재는 "복제(기존 소재)" 방식으로 만들어 주세요.' });
      if (clean.video_data && _isPh(clean.video_data.video_id)) return res.status(422).json({ ok: false, code: 'ASSET_NOT_SELECTED', error: '소재(영상)가 선택되지 않았습니다 — 영상을 다시 선택해 주세요.' });
      if (clean.link_data && _isPh(clean.link_data.link)) return res.status(422).json({ ok: false, code: 'LANDING_MISSING', error: '랜딩 URL이 입력되지 않았습니다.' });
      newTags = 'utm_campaign=' + enc(utmCampaign) + '&utm_content=' + enc(utmContent);
    }

    // ìì ìì¬ë ì¸ë¤ì¼ ì´ë¯¸ì§ê° íì â ìì¼ë©´ ììì ìë ì¸ë¤ì¼(image_url)ì ë¶ì¸ë¤.
    if (clean.video_data && clean.video_data.video_id && !clean.video_data.image_hash && !clean.video_data.image_url) {
      try {
        const th = await gget(GRAPH + '/' + clean.video_data.video_id + '/thumbnails?fields=uri,is_preferred&access_token=' + enc(token));
        const list = (th && th.data) || [];
        const pick = list.filter(function (x) { return x.is_preferred; })[0] || list[0];
        if (pick && pick.uri) clean.video_data.image_url = pick.uri;
        else { try { const _vp = await gget(GRAPH + '/' + clean.video_data.video_id + '?fields=picture&access_token=' + enc(token)); if (_vp && _vp.picture) clean.video_data.image_url = _vp.picture; } catch (e2) {} }
      } catch (e) {}
    }

    // 인스타그램 계정(광고 프로필) 자동 결정: 명시된 IG가 없으면 페이지에 연결된 IG를 사용.
    // → Meta의 "Instagram 계정 필드를 추가하세요" 경고 방지 + IG 게재 정상화.
    if (clean && clean.page_id && !clean.instagram_user_id) {
      try {
        const _pg = await gget(GRAPH + '/' + clean.page_id + '?fields=instagram_business_account,connected_instagram_account&access_token=' + enc(token));
        const _iid = (_pg && _pg.instagram_business_account && _pg.instagram_business_account.id)
                  || (_pg && _pg.connected_instagram_account && _pg.connected_instagram_account.id) || null;
        if (_iid) clean.instagram_user_id = _iid;
      } catch (e) {}
    }

    // 계정↔소재 최종 가드: 소재에 쓰인 이미지(image_hash)가 대상 광고계정(act)에 실제로
    // 존재하는지 확인. 다른 계정의 이미지로 생성 시도하면 생성 직전에 차단(오늘 목록 필터로
    // 완화했지만, 그걸 우회한 요청까지 서버에서 최종 차단). 이미지가 없는 소재(영상만/링크만)는 통과.
    var _imgHashes = [];
    if (clean.link_data && clean.link_data.image_hash) _imgHashes.push(String(clean.link_data.image_hash));
    if (clean.video_data && clean.video_data.image_hash) _imgHashes.push(String(clean.video_data.image_hash));
    if (_imgHashes.length) {
      var _uniq = _imgHashes.filter(function (h, i) { return _imgHashes.indexOf(h) === i; });
      try {
        const _ai = await gget(GRAPH + '/act_' + act + '/adimages?fields=hash&hashes=' + enc(JSON.stringify(_uniq)) + '&access_token=' + enc(token));
        const _own = {}; ((_ai && _ai.data) || []).forEach(function (x) { if (x && x.hash) _own[x.hash] = 1; });
        const _missing = _uniq.filter(function (h) { return !_own[h]; });
        if (_missing.length) {
          return res.status(409).json({
            ok: false, code: 'IMAGE_ACCOUNT_MISMATCH', missingHashes: _missing,
            error: '선택한 소재의 이미지가 이 광고 계정에 없습니다(다른 계정의 이미지). 다른 계정의 이미지로는 광고를 만들 수 없습니다 — 같은 계정의 소재를 고르거나, 대상 세트를 그 소재와 같은 계정으로 바꿔 주세요.'
          });
        }
      } catch (e) { /* 조회 실패 시엔 차단하지 않음(생성 단계에서 Meta가 최종 검증) */ }
    }

    if (!apply) {
      return res.status(200).json({ ok: true, dryRun: true, mode: srcCreativeId ? 'clone' : 'new', targetAdsetId: targetAdsetId, newName: newName, tokenSource: tokenSource, instagramUserId: clean.instagram_user_id || null, pageId: clean.page_id || null });
    }

    // 새 소재 생성
    const cpayload = { name: newName + (srcCreativeId ? ' [clone]' : ' [new]'), object_story_spec: clean };
    if (newTags) cpayload.url_tags = newTags;
    // 어드밴티지+ 크리에이티브(자동 향상)·상품연동(제품태그/카탈로그/Shop) 제어.
    // Meta v22(2025-01)부터 standard_enhancements 번들 키는 지원 중단 → 전송 시 에러.
    // 개별 기능 opt-in 모델로 전환되어, 명시적으로 opt-in 하지 않은 향상 기능은 기본 미적용(OFF).
    // 따라서 기본값은 "상품연동(product_extensions)만 명시적 OPT_OUT" 로 두어 제품태그/카탈로그/Shop
    // 자동 첨부를 끈다. 개별 항목 세부 제어는 클라이언트가 creativeFeatures(=creative_features_spec)
    // 를 넘겨 덮어쓸 수 있음(향후 소재 세팅 UI의 개별 토글용).
    var _cfs = (b.creativeFeatures && typeof b.creativeFeatures === 'object')
      ? b.creativeFeatures
      : { product_extensions: { enroll_status: 'OPT_OUT' } };
    cpayload.degrees_of_freedom_spec = { creative_features_spec: _cfs };
    const created = await gpost(GRAPH + '/act_' + act + '/adcreatives?access_token=' + enc(token), cpayload);
    const newCid = created.id;
    if (!newCid) throw new Error('새 소재 생성 실패');

    // 대상 세트에 새 광고 생성 (PAUSED)
    const adRes = await gpost(GRAPH + '/act_' + act + '/ads?access_token=' + enc(token), {
      name: newName,
      adset_id: targetAdsetId,
      creative: { creative_id: newCid },
      status: 'PAUSED'
    });

    // 검증용(opt-in): 생성된 소재에 실제 적용된 어드밴티지+ 개별 기능(enroll_status)을 되읽어 반환.
    // verify!==true 이면 추가 호출 없음(운영 부하 0). 향후 개별 토글 UI에서 적용결과 표시에도 활용 가능.
    var appliedFeatures = null;
    if (b.verify === true) {
      try {
        const _vc = await gget(GRAPH + '/' + newCid + '?fields=degrees_of_freedom_spec&access_token=' + enc(token));
        appliedFeatures = (_vc && _vc.degrees_of_freedom_spec) || {};
      } catch (e) { appliedFeatures = { readError: String((e && e.message) || e) }; }
    }
    return res.status(200).json({ ok: true, mode: srcCreativeId ? 'clone' : 'new', newAdId: adRes.id, newCreative: newCid, targetAdsetId: targetAdsetId, tokenSource: tokenSource, appliedFeatures: appliedFeatures, instagramUserId: clean.instagram_user_id || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
