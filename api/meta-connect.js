// /api/meta-connect — 개인 Meta 계정 OAuth 연동
//  클라이언트가 Facebook 로그인으로 얻은 "단기 사용자 토큰"을 받아
//  앱 시크릿으로 "장기(약 60일) 토큰"으로 교환하고, Firebase /meta_tokens/{uid} 에 저장.
//  토큰은 절대 클라이언트로 반환하지 않는다(상태만 반환).
//  필요한 Vercel 환경변수: META_APP_ID, META_APP_SECRET, FIREBASE_DB_URL, FIREBASE_DB_SECRET
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
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
module.exports = async function (req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST 요청만 허용' });
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ ok: false, error: '로그인이 필요합니다 — 회사 구글 계정(@egnis.kr)으로 로그인하세요.' });
    const appId = process.env.META_APP_ID, appSecret = process.env.META_APP_SECRET;
    const dbUrl = (process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
    const dbSecret = process.env.FIREBASE_DB_SECRET || '';
    if (!appId || !appSecret) return res.status(500).json({ ok: false, error: '서버에 META_APP_ID/META_APP_SECRET 없음' });
    if (!dbUrl) return res.status(500).json({ ok: false, error: 'FIREBASE_DB_URL 없음' });

    const b = await readJson(req);
    const shortToken = String(b.shortToken || b.accessToken || '').trim();
    if (!shortToken) return res.status(400).json({ ok: false, error: 'shortToken(단기 토큰)이 필요합니다' });

    // 1) 단기 → 장기 토큰 교환
    const exUrl = GRAPH + '/oauth/access_token?grant_type=fb_exchange_token&client_id=' + enc(appId) +
      '&client_secret=' + enc(appSecret) + '&fb_exchange_token=' + enc(shortToken);
    const ex = await fetch(exUrl).then(r => r.json());
    if (ex.error || !ex.access_token) {
      return res.status(400).json({ ok: false, error: '토큰 교환 실패: ' + ((ex.error && ex.error.message) || '알 수 없음') });
    }
    const longToken = ex.access_token;
    const expiresIn = (+ex.expires_in) || (60 * 24 * 3600);
    const expiresAt = Date.now() + expiresIn * 1000;

    // 2) Meta 사용자 정보
    const me = await fetch(GRAPH + '/me?fields=id,name&access_token=' + enc(longToken)).then(r => r.json());
    if (me.error) return res.status(400).json({ ok: false, error: 'Meta 사용자 조회 실패: ' + me.error.message });

    // 3) Firebase 저장 (서버 전용 경로)
    const uid = user.user_id || user.sub || user.uid;
    const authQ = dbSecret ? ('?auth=' + enc(dbSecret)) : '';
    const rec = { token: longToken, expiresAt: expiresAt, metaUserId: me.id || '', metaName: me.name || '', email: user.email || '', updatedAt: new Date().toISOString() };
    const w = await fetch(dbUrl + '/meta_tokens/' + enc(uid) + '.json' + authQ, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec)
    });
    if (!w.ok) throw new Error('Firebase 저장 실패: ' + (await w.text()));

    return res.status(200).json({ ok: true, metaName: me.name || '', metaUserId: me.id || '', expiresAt: expiresAt });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
