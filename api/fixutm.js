// ─────────────────────────────────────────────────────────────
//  /api/fixutm  —  Vercel 서버리스 함수 (UTM 불일치 자동 교정)
//  ※ GitHub 리포에는 반드시 "api/fixutm.js" 경로(= api 폴더 안)로 올리세요.
//
//  운영중 광고의 utm_campaign / utm_content 가 세트명 / 소재명과 다를 때,
//  "기존 소재 스펙을 그대로 복제하되 링크의 utm 값만 바로잡은" 새 소재를 만들어
//  해당 광고에 교체한다. 페이지·인스타 연결·이미지/영상·문구·CTA는 그대로 보존.
//  토큰은 클라이언트로 안 나가고 환경변수(META_TOKEN)에서만 읽는다.
//
//  요청(POST, application/json):
//    { act, adName, correctCampaign, correctContent, apply }
//      - apply !== true 이면 dry-run(무엇을 바꿀지만 반환, 실제 변경 안 함)
//  응답: { ok, dryRun?, adId, oldCreative, newCreative?, ... }
//
//  주의: 소재를 새로 만들어 교체 → 광고가 검수에 다시 들어갈 수 있음.
// ─────────────────────────────────────────────────────────────

const GRAPH = 'https://graph.facebook.com/v21.0';
const enc = encodeURIComponent;

async function readJson(req) {
  if (req.body) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) {} }
  }
  return await new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
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
  if (j.error) throw new Error('[write] ' + (j.error.message || 'graph error'));
  return j;
}

// 문자열(URL 또는 url_tags) 안의 utm_campaign / utm_content 값만 교체
function fixUtm(str, camp, cont) {
  if (!str) return str;
  let s = str;
  s = s.replace(/([?&]utm_campaign=)[^&#]*/i, '$1' + enc(camp));
  s = s.replace(/([?&]utm_content=)[^&#]*/i, '$1' + enc(cont));
  return s;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST 요청만 허용' });
    const token = process.env.META_TOKEN;
    if (!token) return res.status(500).json({ ok: false, error: '서버에 META_TOKEN 없음' });

    const b = await readJson(req);
    const act = String(b.act || '').replace(/^act_/, '').trim();
    const adName = String(b.adName || '').trim();
    const correctCampaign = String(b.correctCampaign || '').trim();
    const correctContent = String(b.correctContent || '').trim();
    const apply = b.apply === true;
    if (!act || !adName || !correctCampaign || !correctContent) {
      return res.status(400).json({ ok: false, error: '필수값 누락 (act, adName, correctCampaign, correctContent)' });
    }

    // 1) 이름으로 광고 찾기 → 광고 ID + 현재 소재 ID
    const filt = JSON.stringify([{ field: 'name', operator: 'EQUAL', value: adName }]);
    const adsRes = await gget(GRAPH + '/act_' + act + '/ads?fields=id,name,creative{id}&filtering=' + enc(filt) + '&limit=5&access_token=' + enc(token));
    const ads = (adsRes.data || []);
    if (!ads.length) return res.status(404).json({ ok: false, error: '광고를 이름으로 못 찾음: ' + adName });
    if (ads.length > 1) return res.status(409).json({ ok: false, error: '같은 이름 광고가 여러 개라 모호함 (' + ads.length + ')' });
    const adId = ads[0].id;
    const cid = ads[0].creative && ads[0].creative.id;
    if (!cid) return res.status(400).json({ ok: false, error: '광고에 소재가 없음' });

    // 2) 현재 소재 스펙 읽기
    const cr = await gget(GRAPH + '/' + cid + '?fields=name,object_type,url_tags,object_story_spec&access_token=' + enc(token));
    const spec = cr.object_story_spec;
    if (!spec || (!spec.link_data && !spec.video_data)) {
      return res.status(422).json({ ok: false, error: '인라인 소재가 아니라 자동 교체 불가 (object_type=' + (cr.object_type || '?') + ')' });
    }

    // 3) 스펙 복제 + 링크의 utm만 교정
    const newSpec = JSON.parse(JSON.stringify(spec));
    if (newSpec.link_data && newSpec.link_data.link) {
      newSpec.link_data.link = fixUtm(newSpec.link_data.link, correctCampaign, correctContent);
    }
    if (newSpec.video_data && newSpec.video_data.call_to_action && newSpec.video_data.call_to_action.value && newSpec.video_data.call_to_action.value.link) {
      newSpec.video_data.call_to_action.value.link = fixUtm(newSpec.video_data.call_to_action.value.link, correctCampaign, correctContent);
    }
    const newTags = fixUtm(cr.url_tags || '', correctCampaign, correctContent);

    if (!apply) {
      return res.status(200).json({ ok: true, dryRun: true, adId: adId, oldCreative: cid, adName: adName,
        willSetCampaign: correctCampaign, willSetContent: correctContent,
        hasIgActor: !!(newSpec.instagram_actor_id || (newSpec.link_data && newSpec.link_data.instagram_actor_id)) });
    }

    // 4) 새 소재 생성 (스펙 그대로 + utm만 수정)
    const payload = { name: (cr.name || 'creative') + ' [utm-fixed]', object_story_spec: newSpec };
    if (newTags) payload.url_tags = newTags;
    const created = await gpost(GRAPH + '/act_' + act + '/adcreatives?access_token=' + enc(token), payload);
    const newCid = created.id;
    if (!newCid) throw new Error('새 소재 생성 실패');

    // 5) 광고 소재 교체
    await gpost(GRAPH + '/' + adId + '?access_token=' + enc(token), { creative: { creative_id: newCid } });

    return res.status(200).json({ ok: true, adId: adId, oldCreative: cid, newCreative: newCid });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
