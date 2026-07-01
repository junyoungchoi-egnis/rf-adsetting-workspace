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
  if (spec.instagram_actor_id) clean.instagram_actor_id = spec.instagram_actor_id;
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
  if (ns.instagram_actor_id) clean.instagram_actor_id = ns.instagram_actor_id;
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
    const token = process.env.META_TOKEN;
    if (!token) return res.status(500).json({ ok: false, error: '서버에 META_TOKEN 없음' });

    const b = await readJson(req);
    const act = String(b.act || '').replace(/^act_/, '').trim();
    const srcCreativeId = String(b.srcCreativeId || '').trim();
    const targetAdsetId = String(b.targetAdsetId || '').trim();
    const newName = String(b.newName || '').trim();
    const utmCampaign = String(b.utmCampaign || '').trim();
    const utmContent = String(b.utmContent || '').trim();
    const newSpec = b.newSpec || null;
    const apply = b.apply === true;
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
      newTags = 'utm_campaign=' + enc(utmCampaign) + '&utm_content=' + enc(utmContent);
    }

    // ìì ìì¬ë ì¸ë¤ì¼ ì´ë¯¸ì§ê° íì â ìì¼ë©´ ììì ìë ì¸ë¤ì¼(image_url)ì ë¶ì¸ë¤.
    if (clean.video_data && clean.video_data.video_id && !clean.video_data.image_hash && !clean.video_data.image_url) {
      try {
        const th = await gget(GRAPH + '/' + clean.video_data.video_id + '/thumbnails?fields=uri,is_preferred&access_token=' + enc(token));
        const list = (th && th.data) || [];
        const pick = list.filter(function (x) { return x.is_preferred; })[0] || list[0];
        if (pick && pick.uri) clean.video_data.image_url = pick.uri;
      } catch (e) {}
    }

    if (!apply) {
      return res.status(200).json({ ok: true, dryRun: true, mode: srcCreativeId ? 'clone' : 'new', targetAdsetId: targetAdsetId, newName: newName });
    }

    // 새 소재 생성
    const cpayload = { name: newName + (srcCreativeId ? ' [clone]' : ' [new]'), object_story_spec: clean };
    if (newTags) cpayload.url_tags = newTags;
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

    return res.status(200).json({ ok: true, mode: srcCreativeId ? 'clone' : 'new', newAdId: adRes.id, newCreative: newCid, targetAdsetId: targetAdsetId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
