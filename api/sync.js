// ─────────────────────────────────────────────────────────────
//  /api/sync  —  Vercel 서버리스 함수 (숨은 직원실)
//  ※ GitHub 리포에는 반드시 "api/sync.js" 경로(= api 폴더 안)로 올리세요.
//
//  Meta 광고 데이터(캠페인/세트/광고 ID·이름·상태·소재수)를 읽어
//  Firebase Realtime DB의 /meta_v2 에 스냅샷으로 저장한다.
//  + 계정별 "애셋 라이브러리"(이미지·영상·크리에이티브 + 썸네일/재생소재)도 수집해
//    소재 세팅 탭에서 바로 선택·미리보기 수 있게 한다.
//  토큰은 절대 클라이언트로 나가지 않고, 이 함수의 환경변수에서만 읽는다.
//
//  필요한 Vercel 환경변수:
//    META_TOKEN, META_ACCOUNTS(콤마구분), FIREBASE_DB_URL, SYNC_SECRET(선택)
// ─────────────────────────────────────────────────────────────

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

async function fetchPaged(url, actId) {
  const out = [];
  let guard = 0;
  while (url && guard < 80) {
    guard++;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error('[act_' + actId + '] ' + (j.error.message || 'graph error'));
    (j.data || []).forEach(x => out.push(x));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return out;
}

// 애셋은 1페이지(최신 N개)만 — 함수 타임아웃 방지를 위해 페이지네이션하지 않는다.
async function fetchOne(url, actId) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error('[act_' + actId + '] ' + (j.error.message || 'graph error'));
  return j.data || [];
}

async function fetchAllAds(actId, token) {
  const fields = 'id,effective_status,adset{id,name,effective_status},campaign{id,name,effective_status}';
  const url = GRAPH + '/act_' + actId + '/ads?fields=' + enc(fields) + '&limit=500&access_token=' + enc(token);
  return fetchPaged(url, actId);
}
async function fetchAllAdsets(actId, token) {
  const fields = 'id,name,effective_status,daily_budget,lifetime_budget,campaign{id,name,effective_status,daily_budget,lifetime_budget}';
  const url = GRAPH + '/act_' + actId + '/adsets?fields=' + enc(fields) + '&limit=500&access_token=' + enc(token);
  return fetchPaged(url, actId);
}

// ── 애셋 라이브러리 ──
async function fetchCreatives(actId, token) {
  const fields = 'id,name,thumbnail_url,image_url,object_type,body,title,image_hash,video_id,object_story_id,effective_object_story_id,call_to_action_type,status';
  const url = GRAPH + '/act_' + actId + '/adcreatives?fields=' + enc(fields) + '&limit=50&access_token=' + enc(token);
  const raw = await fetchOne(url, actId);
  return raw.map(c => ({
    id: c.id, name: c.name || '(이름없음)',
    type: c.video_id ? 'VIDEO' : 'IMAGE',
    thumb: c.thumbnail_url || '', full: c.image_url || '',
    body: c.body || '', title: c.title || '', cta: c.call_to_action_type || '',
    image_hash: c.image_hash || '', video_id: c.video_id || '',
    story: c.effective_object_story_id || c.object_story_id || '',
    status: c.status || ''
  }));
}
async function fetchImages(actId, token) {
  const fields = 'hash,name,url,url_128,permalink_url,width,height,created_time';
  const url = GRAPH + '/act_' + actId + '/adimages?fields=' + enc(fields) + '&limit=50&access_token=' + enc(token);
  const raw = await fetchOne(url, actId);
  return raw.map(i => ({ hash: i.hash, name: i.name || '', thumb: i.url_128 || '', full: i.url || i.permalink_url || i.url_128 || '', w: i.width || 0, h: i.height || 0, ts: i.created_time || '' }));
}
async function fetchVideos(actId, token) {
  const fields = 'id,title,source,picture,thumbnails{uri,is_preferred},created_time';
  const url = GRAPH + '/act_' + actId + '/advideos?fields=' + enc(fields) + '&limit=40&access_token=' + enc(token);
  const raw = await fetchOne(url, actId);
  return raw.map(v => {
    let thumb = v.picture || '';
    if (!thumb && v.thumbnails && v.thumbnails.data && v.thumbnails.data.length) {
      const pref = v.thumbnails.data.find(t => t.is_preferred) || v.thumbnails.data[0];
      thumb = pref ? pref.uri : '';
    }
    return { id: v.id, title: v.title || '(제목없음)', thumb: thumb, source: v.source || '', ts: v.created_time || '' };
  });
}
async function fetchIgAccounts(actId, token) {
  const url = GRAPH + '/act_' + actId + '/instagram_accounts?fields=id,username&limit=50&access_token=' + enc(token);
  const raw = await fetchOne(url, actId);
  return raw.map(g => ({ id: g.id, username: g.username || '(unknown)' }));
}
// 세팅된 활성 광고(구조화된 광고 소재명 FB_... 기준 검색용) + 그 광고의 크리에이티브
async function fetchActiveAds(actId, token) {
  const cfields = 'id,body,title,call_to_action_type,image_hash,image_url,video_id,object_story_id,effective_object_story_id,thumbnail_url,object_type,url_tags,asset_feed_spec{bodies{text},titles{text},descriptions{text},call_to_action_types},object_story_spec{link_data{message,name,description,link,call_to_action{type}},video_data{message,title,link_description,call_to_action{type,value{link}}}}';
  const fields = 'name,effective_status,adset{name},creative{' + cfields + '}';
  const filt = '[{"field":"effective_status","operator":"IN","value":["ACTIVE"]}]';
  const url = GRAPH + '/act_' + actId + '/ads?fields=' + enc(fields) + '&filtering=' + enc(filt) + '&limit=40&access_token=' + enc(token);
  const raw = await fetchOne(url, actId);
  return raw.map(a => {
    const c = a.creative || {};
    const oss = c.object_story_spec || {}; const ld = oss.link_data || {}; const vd = oss.video_data || {};
    const afs = c.asset_feed_spec || {};
    const afsBody = (afs.bodies && afs.bodies[0] && afs.bodies[0].text) || '';
    const afsTitle = (afs.titles && afs.titles[0] && afs.titles[0].text) || '';
    const afsDesc = (afs.descriptions && afs.descriptions[0] && afs.descriptions[0].text) || '';
    const afsCta = (afs.call_to_action_types && afs.call_to_action_types[0]) || '';
    const body = c.body || ld.message || vd.message || afsBody || '';
    const title = c.title || ld.name || vd.title || afsTitle || '';
    const desc = ld.description || vd.link_description || afsDesc || '';
    const cta = c.call_to_action_type || (ld.call_to_action && ld.call_to_action.type) || (vd.call_to_action && vd.call_to_action.type) || afsCta || '';
    const _link = (ld.link) || (vd.call_to_action && vd.call_to_action.value && vd.call_to_action.value.link) || '';
    const _q = (c.url_tags || '') + '&' + ((_link.split('?')[1]) || '');
    const _utm = function(k){ var m=_q.match(new RegExp('[?&]'+k+'=([^&]*)')); return m?decodeURIComponent(m[1]):''; };
    return { name: a.name || '(이름없음)', cid: c.id || '', type: c.video_id ? 'VIDEO' : 'IMAGE', thumb: c.thumbnail_url || '', full: c.image_url || '', body: body, title: title, desc: desc, cta: cta, image_hash: c.image_hash || '', video_id: c.video_id || '', story: c.effective_object_story_id || c.object_story_id || '', link: _link, adsetName: (a.adset&&a.adset.name)||'', utm_campaign: _utm('utm_campaign'), utm_content: _utm('utm_content') };
  });
}

function aggregate(ads, adsetList) {
  const byAdset = {};
  function ensure(key) {
    if (!byAdset[key]) byAdset[key] = {
      adsetId: '', adsetName: '', adsetStatus: '',
      campaignId: '', campaignName: '', campaignStatus: '',
      account: '', total: 0, active: 0, setBudget: 0, campBudget: 0
    };
    return byAdset[key];
  }
  (adsetList || []).forEach(as => {
    if (!as || !as.id) return;
    const cp = as.campaign || {};
    const o = ensure(as.id);
    o.adsetId = as.id; o.adsetName = as.name || ''; o.adsetStatus = as.effective_status || '';
    o.campaignId = cp.id || ''; o.campaignName = cp.name || ''; o.campaignStatus = cp.effective_status || '';
    o.setBudget = (+as.daily_budget || 0) + (+as.lifetime_budget || 0);
    o.campBudget = (+cp.daily_budget || 0) + (+cp.lifetime_budget || 0);
    if (as._act) o.account = as._act;
  });
  ads.forEach(a => {
    const as = a.adset || {}, cp = a.campaign || {};
    const key = as.id || ('noadset_' + (a.id || Math.random()));
    const o = ensure(key);
    if (!o.adsetId && as.id) { o.adsetId = as.id; o.adsetName = as.name || ''; o.adsetStatus = as.effective_status || ''; }
    if (!o.campaignId && cp.id) { o.campaignId = cp.id; o.campaignName = cp.name || ''; o.campaignStatus = cp.effective_status || ''; }
    if (!o.account && a._act) o.account = a._act;
    o.total++;
    if (String(a.effective_status || '').toUpperCase() === 'ACTIVE') o.active++;
  });
  return Object.values(byAdset);
}

module.exports = async (req, res) => {
  try {
    const token = process.env.META_TOKEN;
    const accounts = (process.env.META_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
    const dbUrl = (process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
    const secret = process.env.SYNC_SECRET;

    // 허용: Vercel 크론(자동 동기화) · 로그인된 회사 사용자 · (설정 시) SYNC_SECRET 키
    const isCron = /vercel-cron/i.test((req.headers && req.headers['user-agent']) || '');
    const userOk = isCron ? true : !!(await verifyUser(req));
    const secretOk = !!(secret && req.query && req.query.key === secret);
    if (!isCron && !userOk && !secretOk) {
      return res.status(401).json({ ok: false, error: '권한 없음 — 회사 계정 로그인이 필요합니다.' });
    }

    if (!token || !accounts.length || !dbUrl) {
      return res.status(500).json({ ok: false, error: '환경변수 누락 (META_TOKEN, META_ACCOUNTS, FIREBASE_DB_URL)' });
    }

    const sec = process.env.FIREBASE_DB_SECRET || '';
    const authQ = sec ? ('?auth=' + encodeURIComponent(sec)) : '';
    // 직전 스냅샷 읽기 — 계정 동기화 실패 시 그 계정 데이터를 '빈 값'으로 덮어쓰지 않고 보존하기 위함
    let prev = null;
    try { prev = await fetch(dbUrl + '/meta_v2.json' + authQ).then(r => r.json()); } catch (e) { prev = null; }
    const prevAdsets = (prev && Array.isArray(prev.adsets)) ? prev.adsets : [];
    const prevAssets = (prev && prev.assets) ? prev.assets : {};
    const prevAccounts = (prev && prev.accounts) ? prev.accounts : {};

    let all = [];
    let allAdsets = [];
    const perAccount = {};
    const assets = {};
    const failed = {};
    await Promise.all(accounts.map(async (act) => {
      let ads, adsetList;
      try {
        ads = await fetchAllAds(act, token);
        adsetList = await fetchAllAdsets(act, token);
      } catch (e) {
        failed[act] = String((e && e.message) || e);
        return;
      }
      ads.forEach(a => { a._act = act; });
      adsetList.forEach(a => { a._act = act; });
      perAccount[act] = ads.length;
      all = all.concat(ads);
      allAdsets = allAdsets.concat(adsetList);
      const aRes = await Promise.all([
        fetchCreatives(act, token).catch(() => null),
        fetchImages(act, token).catch(() => null),
        fetchVideos(act, token).catch(() => null),
        fetchIgAccounts(act, token).catch(() => null),
        fetchActiveAds(act, token).catch(() => null)
      ]);
      const pa = prevAssets[act] || {};
      assets[act] = { creatives: aRes[0] || pa.creatives || [], images: aRes[1] || pa.images || [], videos: aRes[2] || pa.videos || [], ig: aRes[3] || pa.ig || [], ads: aRes[4] || pa.ads || [] };
    }));

    let adsets = aggregate(all, allAdsets);
    Object.keys(failed).forEach(function (act) {
      adsets = adsets.concat(prevAdsets.filter(function (a) { return a && a.account === act; }));
      perAccount[act] = prevAccounts[act] || 0;
      if (!assets[act]) assets[act] = prevAssets[act] || { creatives: [], images: [], videos: [], ig: [], ads: [] };
    });
    const snapshot = {
      syncedAt: new Date().toISOString(),
      accounts: perAccount,
      adsetCount: adsets.length,
      adCount: all.length,
      adsets: adsets,
      assets: assets
    };

    const w = await fetch(dbUrl + '/meta_v2.json' + authQ, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot)
    });
    if (!w.ok) throw new Error('Firebase 쓰기 실패: ' + (await w.text()));

    const assetTotals = Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, { c: (v.creatives || []).length, i: (v.images || []).length, v: (v.videos || []).length }]));
    return res.status(200).json({ ok: true, syncedAt: snapshot.syncedAt, adsetCount: adsets.length, adCount: all.length, assets: assetTotals, failed: failed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
