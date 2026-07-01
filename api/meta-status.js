// /api/meta-status — 현재 로그인 사용자의 Meta 연동 상태 반환 (토큰 자체는 반환하지 않음)
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
module.exports = async function (req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
    const dbUrl = (process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
    const dbSecret = process.env.FIREBASE_DB_SECRET || '';
    const uid = user.user_id || user.sub || user.uid;
    const authQ = dbSecret ? ('?auth=' + enc(dbSecret)) : '';
    const rec = await fetch(dbUrl + '/meta_tokens/' + enc(uid) + '.json' + authQ).then(r => r.json());
    if (!rec || !rec.token) return res.status(200).json({ ok: true, connected: false });
    const expired = !rec.expiresAt || rec.expiresAt < Date.now();
    return res.status(200).json({ ok: true, connected: !expired, expired: expired, metaName: rec.metaName || '', metaUserId: rec.metaUserId || '', expiresAt: rec.expiresAt || 0 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
