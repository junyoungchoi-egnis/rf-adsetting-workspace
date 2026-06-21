// ─────────────────────────────────────────────────────────────
//  /api/sync  —  Vercel 서버리스 함수 (숨은 직원실)
//  ※ GitHub 리포에는 반드시 "api/sync.js" 경로(= api 폴더 안)로 올리세요.
//
//  Meta 광고 데이터(캠페인/세트/광고 ID·이름·상태·소재수)를 읽어
//  Firebase Realtime DB의 /meta_v2 에 스냅샷으로 저장한다.
//  토큰은 절대 클라이언트로 나가지 않고, 이 함수의 환경변수에서만 읽는다.
//
//  필요한 Vercel 환경변수 (Settings → Environment Variables):
//    META_TOKEN       : Meta 시스템 사용자 액세스 토큰
//    META_ACCOUNTS    : 광고계정 ID들(act_ 제외), 콤마구분
//                       예: 1462607070849777,3342733785912061,793134085895227
//    FIREBASE_DB_URL  : https://utm-builder-cloop-260617-default-rtdb.asia-southeast1.firebasedatabase.app
//    SYNC_SECRET      : (선택) 설정하면 ?key=... 가 맞아야 실행됨
// ─────────────────────────────────────────────────────────────

const GRAPH = 'https://graph.facebook.com/v21.0';

async function fetchAllAds(actId, token) {
  const fields = 'id,name,effective_status,adset{id,name},campaign{id,name}';
  let url = `${GRAPH}/act_${actId}/ads?fields=${encodeURIComponent(fields)}&limit=500&access_token=${encodeURIComponent(token)}`;
  const ads = [];
  let guard = 0;
  while (url && guard < 60) {
    guard++;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(`[act_${actId}] ${j.error.message || 'graph error'}`);
    (j.data || []).forEach(a => ads.push(a));
    url = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return ads;
}

function aggregate(ads) {
  const byAdset = {};
  ads.forEach(a => {
    const as = a.adset || {}, cp = a.campaign || {};
    const key = as.id || ('noadset_' + (a.id || Math.random()));
    if (!byAdset[key]) byAdset[key] = {
      adsetId: as.id || '', adsetName: as.name || '',
      campaignId: cp.id || '', campaignName: cp.name || '',
      total: 0, active: 0
    };
    byAdset[key].total++;
    if (String(a.effective_status || '').toUpperCase() === 'ACTIVE') byAdset[key].active++;
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
    const perAccount = {};
    for (const act of accounts) {
      const ads = await fetchAllAds(act, token);
      perAccount[act] = ads.length;
      all = all.concat(ads);
    }

    const adsets = aggregate(all);
    const snapshot = {
      syncedAt: new Date().toISOString(),
      accounts: perAccount,
      adsetCount: adsets.length,
      adCount: all.length,
      adsets
    };

    const w = await fetch(`${dbUrl}/meta_v2.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot)
    });
    if (!w.ok) throw new Error('Firebase 쓰기 실패: ' + (await w.text()));

    return res.status(200).json({ ok: true, syncedAt: snapshot.syncedAt, adsetCount: adsets.length, adCount: all.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
