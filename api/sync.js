// ─────────────────────────────────────────────────────────────
//  /api/sync  —  Vercel 서버리스 함수 (숨은 직원실)
//  ※ GitHub 리포에는 반드시 "api/sync.js" 경로(= api 폴더 안)로 올리세요.
//
//  Meta 광고 데이터(캠페인/세트/광고 ID·이름·상태·소재수)를 읽어
//  Firebase Realtime DB의 /meta_v2 에 스냅샷으로 저장한다.
//  + 계정별 "애셋 라이브러리"(크리에이티브·이미지·영상 + 썸네일)도 함께 수집해
//    소재 세팅 탭에서 바로 선택·미리보기할 수 있게 한다.
//  토큰은 절대 클라이언트로 나가지 않고, 이 함수의 환경변수에서만 읽는다.
//
//  필요한 Vercel 환경변수:
//    META_TOKEN, META_ACCOUNTS(콤마구분), FIREBASE_DB_URL, SYNC_SECRET(선택)
// ─────────────────────────────────────────────────────────────

const GRAPH = 'https://graph.facebook.com/v21.0';
const enc = encodeURIComponent;

async function fetchPaged(url, actId) {
  const out = [];
  let guard = 0;
  while (url && guard < 80) {
    guard++;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(`[act_${actId}] ${j.error.message || 'graph error'}`);
    (j.data || []).forEach(x => out.push(x));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return out;
}

// 페이지를 따라가되 최대 cap개까지만 (애셋 목록 비대화 방지)
async function fetchCapped(url, actId, cap) {
  const out = [];
  let u = url, guard = 0;
  while (u && guard < 30 && out.length < cap) {
    guard++;
    const r = await fetch(u);
    const j = await r.json();
    if (j.error) throw new Error(`[act_${actId}] ${j.error.message || 'graph error'}`);
    (j.data || []).forEach(x => out.push(x));
    u = (j.paging && j.paging.next && out.length < cap) ? j.paging.next : null;
  }
  return out.slice(0, cap);
}

async function fetchAllAds(actId, token) {
  const fields = 'id,effective_status,adset{id,name,effective_status},campaign{id,name,effective_status}';
  const url = `${GRAPH}/act_${actId}/ads?fields=${enc(fields)}&limit=500&access_token=${enc(token)}`;
  return fetchPaged(url, actId);
}
async function fetchAllAdsets(actId, token) {
  const fields = 'id,name,effective_status,campaign{id,name,effective_status}';
  const url = `${GRAPH}/act_${actId}/adsets?fields=${enc(fields)}&limit=500&access_token=${enc(token)}`;
  return fetchPaged(url, actId);
}

// ── 애셋 라이브러리 ──
async function fetchCreatives(actId, token) {
  const fields = 'id,name,thumbnail_url,object_type,body,title,image_hash,video_id,object_story_id,effective_object_story_id,call_to_action_type,status';
  const url = `${GRAPH}/act_${actId}/adcreatives?fields=${enc(fields)}&limit=100&access_token=${enc(token)}`;
  const raw = await fetchCapped(url, actId, 120);
  return raw.map(c => ({
    id: c.id, name: c.name || '(이름없음)',
    type: c.video_id ? 'VIDEO' : 'IMAGE',
    thumb: c.thumbnail_url || '',
    body: c.body || '', title: c.title || '', cta: c.call_to_action_type || '',
    image_hash: c.image_hash || '', video_id: c.video_id || '',
    story: c.effective_object_story_id || c.object_story_id || '',
    status: c.status || ''
  }));
}
async function fetchImages(actId, token) {
  const fields = 'hash,name,url_128,permalink_url,width,height';
  const url = `${GRAPH}/act_${actId}/adimages?fields=${enc(fields)}&limit=100&access_token=${enc(token)}`;
  const raw = await fetchCapped(url, actId, 100);
  return raw.map(i => ({ hash: i.hash, name: i.name || '', thumb: i.url_128 || i.permalink_url || '', w: i.width || 0, h: i.height || 0 }));
}
async function fetchVideos(actId, token) {
  const fields = 'id,title,thumbnails{uri,is_preferred},created_time';
  const url = `${GRAPH}/act_${actId}/advideos?fields=${enc(fields)}&limit=80&access_token=${enc(token)}`;
  const raw = await fetchCapped(url, actId, 80);
  return raw.map(v => {
    let thumb = '';
    if (v.thumbnails && v.thumbnails.data && v.thumbnails.data.length) {
      const pref = v.thumbnails.data.find(t => t.is_preferred) || v.thumbnails.data[0];
      thumb = pref ? pref.uri : '';
    }
    return { id: v.id, title: v.title || '(제목없음)', thumb };
  });
}

function aggregate(ads, adsetList) {
  const byAdset = {};
  function ensure(key) {
    if (!byAdset[key]) byAdset[key] = {
      adsetId: '', adsetName: '', adsetStatus: '',
      campaignId: '', campaignName: '', campaignStatus: '',
      account: '', total: 0, active: 0
    };
    return byAdset[key];
  }
  (adsetList || []).forEach(as => {
    if (!as || !as.id) return;
    const cp = as.campaign || {};
    const o = ensure(as.id);
    o.adsetId = as.id; o.adsetName = as.name || ''; o.adsetStatus = as.effective_status || '';
    o.campaignId = cp.id || ''; o.campaignName = cp.name || ''; o.campaignStatus = cp.effective_status || '';
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

    if (secret) {
      const key = (req.query && req.query.key) || '';
      if (key !== secret) return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    if (!token || !accounts.length || !dbUrl) {
      return res.status(500).json({ ok: false, error: '환경변수 누락 (META_TOKEN, META_ACCOUNTS, FIREBASE_DB_URL)' });
    }

    let all = [];
    let allAdsets = [];
    const perAccount = {};
    const assets = {};
    for (const act of accounts) {
      const ads = await fetchAllAds(act, token);
      const adsetList = await fetchAllAdsets(act, token);
      ads.forEach(a => { a._act = act; });
      adsetList.forEach(a => { a._act = act; });
      perAccount[act] = ads.length;
      all = all.concat(ads);
      allAdsets = allAdsets.concat(adsetList);
      // 애셋(개별 계정 실패해도 전체 동기화는 계속)
      try {
        const [creatives, images, videos] = await Promise.all([
          fetchCreatives(act, token), fetchImages(act, token), fetchVideos(act, token)
        ]);
        assets[act] = { creatives, images, videos };
      } catch (e) {
        assets[act] = { creatives: [], images: [], videos: [], error: String((e && e.message) || e) };
      }
    }

    const adsets = aggregate(all, allAdsets);
    const snapshot = {
      syncedAt: new Date().toISOString(),
      accounts: perAccount,
      adsetCount: adsets.length,
      adCount: all.length,
      adsets,
      assets
    };

    const w = await fetch(`${dbUrl}/meta_v2.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot)
    });
    if (!w.ok) throw new Error('Firebase 쓰기 실패: ' + (await w.text()));

    const assetTotals = Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, { c: (v.creatives || []).length, i: (v.images || []).length, v: (v.videos || []).length }]));
    return res.status(200).json({ ok: true, syncedAt: snapshot.syncedAt, adsetCount: adsets.length, adCount: all.length, assets: assetTotals });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
