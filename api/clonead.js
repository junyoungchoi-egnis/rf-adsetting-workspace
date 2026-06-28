// /api/clonead — Vercel 서버리스 (소재를 대상 세트에 복제 생성)
const GRAPH = 'https://graph.facebook.com/v21.0';
const enc = encodeURIComponent;

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
  const r = await fetch(url); const j = await r.json();
  if (j.error) throw new Error('[read] ' + JSON.stringify(j.error));
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
    const token = process.env.META_TOKEN;
    if (!token) return res.status(500).json({ ok: false, error: '서버에 META_TOKEN 없음' });
    const b = await readJson(req);
    const act = String(b.act || '').replace(/^act_/, '').trim();
    const srcCreativeId = String(b.srcCreativeId || '').trim();
    const targetAdsetId = String(b.targetAdsetId || '').trim();
    const newName = String(b.newName || '').trim();
    const utmCampaign = String(b.utmCampaign || '').trim();
    const utmContent = String(b.utmContent || '').trim();
    const apply = b.apply === true;
    if (!act || !srcCreativeId || !targetAdsetId || !newName || !utmCampaign || !utmContent) {
      return res.status(400).json({ ok: false, error: '필수값 누락' });
    }
    const cr = await gget(GRAPH + '/' + srcCreativeId + '?fields=name,object_type,url_tags,object_story_spec&access_token=' + enc(token));
    const spec = cr.object_story_spec;
    if (!spec || (!spec.link_data && !spec.video_data)) {
      return res.status(422).json({ ok: false, error: '인라인 소재 아님 (object_type=' + (cr.object_type || '?') + ')' });
    }
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
    stripEmpty(clean);
    const newTags = fixUtm(cr.url_tags || '', utmCampaign, utmContent);
    if (!apply) {
      return res.status(200).json({ ok: true, dryRun: true, targetAdsetId: targetAdsetId, newName: newName, fromCreative: srcCreativeId });
    }
    const cpayload = { name: newName + ' [clone]', object_story_spec: clean };
    if (newTags) cpayload.url_tags = newTags;
    const created = await gpost(GRAPH + '/act_' + act + '/adcreatives?access_token=' + enc(token), cpayload);
    const newCid = created.id;
    if (!newCid) throw new Error('새 소재 생성 실패');
    const adRes = await gpost(GRAPH + '/act_' + act + '/ads?access_token=' + enc(token), { name: newName, adset_id: targetAdsetId, creative: { creative_id: newCid }, status: 'PAUSED' });
    return res.status(200).json({ ok: true, newAdId: adRes.id, newCreative: newCid, targetAdsetId: targetAdsetId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
