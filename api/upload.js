// ─────────────────────────────────────────────────────────────
//  /api/upload  —  Vercel 서버리스 함수 (이미지 → 메타 광고 라이브러리)
//  ※ GitHub 리포에는 반드시 "api/upload.js" 경로(= api 폴더 안)로 올리세요.
//
//  클라이언트가 보낸 base64 이미지를 Meta Graph API(/act_{id}/adimages)에
//  업로드하고 image_hash를 돌려준다. 토큰은 절대 클라이언트로 나가지 않고,
//  이 함수의 환경변수(META_TOKEN)에서만 읽는다. (sync.js와 동일 토큰 재사용)
//
//  요청(POST, application/json):
//    { act: "1462607070849777", bytes: "<base64>", filename: "image.jpg" }
//  응답: { ok:true, hash:"<image_hash>", url:"..." }  또는  { ok:false, error:"..." }
//
//  참고: Vercel 서버리스 요청 본문 한도 ~4.5MB → 이미지 3MB 이하 권장.
// ─────────────────────────────────────────────────────────────

const GRAPH = 'https://graph.facebook.com/v21.0';

async function readJson(req) {
  if (req.body) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { /* fallthrough */ } }
  }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST 요청만 허용됩니다' });

    const token = process.env.META_TOKEN;
    if (!token) return res.status(500).json({ ok: false, error: '서버에 META_TOKEN이 설정되지 않았습니다' });

    const body = await readJson(req);
    const act = String(body.act || '').replace(/^act_/, '').trim();
    const bytes = body.bytes;
    if (!act) return res.status(400).json({ ok: false, error: '광고계정(act)이 필요합니다' });
    if (!bytes) return res.status(400).json({ ok: false, error: '이미지 데이터(bytes)가 없습니다' });

    const params = new URLSearchParams();
    params.append('bytes', bytes);
    params.append('access_token', token);

    const r = await fetch(`${GRAPH}/act_${act}/adimages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const j = await r.json();
    if (j.error) return res.status(400).json({ ok: false, error: j.error.message || 'Graph API 오류' });

    // 응답 형태: { images: { "<filename|bytes>": { hash, url, ... } } }
    const first = j.images ? Object.values(j.images)[0] : null;
    if (!first || !first.hash) return res.status(500).json({ ok: false, error: 'image_hash를 받지 못했습니다', raw: j });

    return res.status(200).json({ ok: true, hash: first.hash, url: first.url || '' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
