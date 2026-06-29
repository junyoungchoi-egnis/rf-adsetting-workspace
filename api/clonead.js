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
      newTags = 'utm_campaign=' + enc(utmCampaign) + '&utm_content=' + enc(utmContent);
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
