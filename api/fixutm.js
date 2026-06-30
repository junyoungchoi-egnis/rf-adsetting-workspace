// /api/fixutm — Vercel 서버리스 (UTM 불일치 자동 교정)
// GitHub 리포에는 반드시 "api/fixutm.js"(api 폴더 안)로 올리세요.
// 운영중 광고의 utm_campaign/utm_content 가 세트명/소재명과 다를 때,
// 기존 소재 스펙을 생성 가능한 필드로 재구성하고 링크의 utm 값만 바로잡은
// 새 소재를 만들어 광고에 교체한다. 페이지·인스타·이미지/영상·문구·CTA 보존.
// 요청(POST JSON): { act, adName, correctCampaign, correctContent, apply }
//   apply!==true 이면 dry-run. 토큰은 환경변수(META_TOKEN)에서만 읽음.

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

async function gget(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error('[read] ' + (j.error.message || 'graph error'));
  return j;
}

async function gpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error('[write] ' + JSON.stringify(j.error));
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

module.exports = async function (req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST 요청만 허용' });
    const _user = await verifyUser(req);
    if (!_user) return res.status(401).json({ ok: false, error: '로그인이 필요합니다 — 회사 구글 계정(@egnis.kr)으로 로그인 후 사용하세요.' });
    const token = process.env.META_TOKEN;
    if (!token) return res.status(500).json({ ok: false, error: '서버에 META_TOKEN 없음' });

    const b = await readJson(req);
    const act = String(b.act || '').replace(/^act_/, '').trim();
    const adName = String(b.adName || '').trim();
    const correctCampaign = String(b.correctCampaign || '').trim();
    const correctContent = String(b.correctContent || '').trim();
    const apply = b.apply === true;
    if (!act || !adName || !correctCampaign || !correctContent) {
      return res.status(400).json({ ok: false, error: '필수값 누락' });
    }

    const filt = JSON.stringify([{ field: 'name', operator: 'EQUAL', value: adName }]);
    const adsRes = await gget(GRAPH + '/act_' + act + '/ads?fields=id,name,creative{id}&filtering=' + enc(filt) + '&limit=5&access_token=' + enc(token));
    const ads = adsRes.data || [];
    if (!ads.length) return res.status(404).json({ ok: false, error: '광고 못 찾음: ' + adName });
    if (ads.length > 1) return res.status(409).json({ ok: false, error: '같은 이름 광고 여러 개 (' + ads.length + ')' });
    const adId = ads[0].id;
    const cid = ads[0].creative && ads[0].creative.id;
    if (!cid) return res.status(400).json({ ok: false, error: '광고에 소재 없음' });

    const cr = await gget(GRAPH + '/' + cid + '?fields=name,object_type,url_tags,object_story_spec&access_token=' + enc(token));
    const spec = cr.object_story_spec;
    if (!spec || (!spec.link_data && !spec.video_data)) {
      return res.status(422).json({ ok: false, error: '인라인 소재 아님 (object_type=' + (cr.object_type || '?') + ')' });
    }

    const clean = { page_id: spec.page_id };
    if (spec.instagram_actor_id) clean.instagram_actor_id = spec.instagram_actor_id;
    if (spec.link_data) {
      const d = spec.link_data;
      clean.link_data = { link: fixUtm(d.link, correctCampaign, correctContent), message: d.message, name: d.name, description: d.description, image_hash: d.image_hash };
      if (d.call_to_action) {
        clean.link_data.call_to_action = { type: d.call_to_action.type, value: {} };
        if (d.call_to_action.value && d.call_to_action.value.link) {
          clean.link_data.call_to_action.value.link = fixUtm(d.call_to_action.value.link, correctCampaign, correctContent);
        }
      }
    }
    if (spec.video_data) {
      const v = spec.video_data;
      clean.video_data = { video_id: v.video_id, message: v.message, title: v.title, link_description: v.link_description, image_hash: v.image_hash };
      if (v.call_to_action) {
        clean.video_data.call_to_action = { type: v.call_to_action.type, value: {} };
        if (v.call_to_action.value && v.call_to_action.value.link) {
          clean.video_data.call_to_action.value.link = fixUtm(v.call_to_action.value.link, correctCampaign, correctContent);
        }
      }
    }
    stripEmpty(clean);
    const newTags = fixUtm(cr.url_tags || '', correctCampaign, correctContent);

    if (!apply) {
      return res.status(200).json({ ok: true, dryRun: true, adId: adId, oldCreative: cid, adName: adName, willSetCampaign: correctCampaign, willSetContent: correctContent });
    }

    const payload = { name: (cr.name || 'creative') + ' [utm-fixed]', object_story_spec: clean };
    if (newTags) payload.url_tags = newTags;
    const created = await gpost(GRAPH + '/act_' + act + '/adcreatives?access_token=' + enc(token), payload);
    const newCid = created.id;
    if (!newCid) throw new Error('새 소재 생성 실패');

    await gpost(GRAPH + '/' + adId + '?access_token=' + enc(token), { creative: { creative_id: newCid } });

    return res.status(200).json({ ok: true, adId: adId, oldCreative: cid, newCreative: newCid });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
