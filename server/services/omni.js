import { MODELS, OMNI_ENDPOINT, OMNI_TIMEOUT_MS, OMNI_RESOLUTION } from '../config.js';
import { log } from '../util/log.js';
import { withRetry } from './gemini.js';

// Gemini Omni 1.1 ("Generate a video") client. The interactions endpoint is not
// exposed by the @google/genai SDK yet, so we call the REST API directly.
//
// Wire format (https://ai.google.dev/gemini-api/docs/omni), model gemini-omni-1.1-flash:
//   POST /v1beta/interactions   header: x-goog-api-key
//   body: { model, input: [{type:'image',data,mime_type}...,{type:'text',text}],
//           response_format:{type:'video',aspect_ratio,resolution,delivery:'uri'},
//           generation_config:{video_config:{task}}, previous_interaction_id? }
//   resp: { id, status, steps:[...,{type:'model_output',content:[{type:'video',data|uri,mime_type}]}] }
// Generation is synchronous (one POST returns the clip). With delivery:'uri' (and
// for large clips) the video comes back as a Files API `uri` instead of inline
// `data`; we handle both.
//
// NOTE: previous_interaction_id and video_config.task are mutually exclusive —
// Omni rejects the pair (400). Every shot sets a task, so we never chain.
//
// The response shape is a preview API and may shift — extraction below is
// defensive (walks steps/content) so a minor change is a one-spot fix.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Generate a single shot. `refImages` is an array of {data:<base64>, mimeType}.
// Returns { interactionId, buffer } with the raw mp4 bytes.
export async function generateShot(apiKey, {
  prompt,
  refImages = [],
  previousInteractionId = null,
  aspectRatio = '16:9',
  task = 'text_to_video',
}) {
  if (!apiKey) throw new Error('No Gemini API key available for this request');

  const input = [
    ...refImages.map((img) => ({ type: 'image', data: img.data, mime_type: img.mimeType || 'image/png' })),
    { type: 'text', text: `${prompt}\n\nSingle unbroken continuous shot. No scene cuts.` },
  ];
  const body = {
    model: MODELS.omni,
    input,
    // delivery:'uri' asks Omni 1.1 to hand back a Files API uri (robust for the
    // larger 720p+ clips) rather than a multi-MB inline base64 blob.
    response_format: { type: 'video', aspect_ratio: aspectRatio, resolution: OMNI_RESOLUTION, delivery: 'uri' },
    generation_config: { video_config: { task } },
  };
  // Omni rejects previous_interaction_id whenever a video task is set (they are
  // mutually exclusive). Every shot uses a task, so we never chain; cross-shot
  // identity is instead carried by re-sending the same subject-reference images
  // and embedding the character description in each shot's prompt.
  if (previousInteractionId && !task) body.previous_interaction_id = previousInteractionId;

  log.info(
    { task, aspectRatio, refs: refImages.length, chained: Boolean(body.previous_interaction_id) },
    'omni: generating shot'
  );
  const json = await withRetry(() => postJson(OMNI_ENDPOINT, apiKey, body), { label: 'omni:shot', tries: 5 });

  const interactionId = json.id || json.interaction_id || json.name || null;
  const video = findVideo(json);
  if (!video) {
    throw new Error(`Omni returned no video (status=${json.status}): ${JSON.stringify(json).slice(0, 400)}`);
  }
  const buffer = video.data
    ? Buffer.from(video.data, 'base64')
    : await downloadUri(video.uri, apiKey);
  return { interactionId, buffer };
}

// Walk the response for the first video content item (data or uri).
function findVideo(json) {
  const steps = Array.isArray(json.steps) ? json.steps : [];
  for (const step of steps) {
    const content = Array.isArray(step.content) ? step.content : [];
    for (const item of content) {
      if (item?.type === 'video' && (item.data || item.uri)) return item;
      // Some shapes nest the media under model_output.
      if (item?.model_output?.content) {
        const v = item.model_output.content.find((c) => c?.type === 'video' && (c.data || c.uri));
        if (v) return v;
      }
    }
  }
  // Fallbacks for flatter shapes.
  const out = json.model_output?.content?.find?.((c) => c?.type === 'video' && (c.data || c.uri));
  return out || null;
}

// Download a video referenced by uri. Handles both a Files API resource
// (poll until ACTIVE, then :download) and a plain fetchable URL.
async function downloadUri(uri, apiKey) {
  const m = /\/files\/([^:?/]+)/.exec(uri);
  if (m) {
    const name = `files/${m[1]}`;
    const deadline = Date.now() + OMNI_TIMEOUT_MS;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const meta = await getJson(`${BASE}/${name}`, apiKey);
      if (meta.state === 'ACTIVE' || !meta.state) break;
      if (meta.state === 'FAILED') throw new Error('Omni file processing failed');
      if (Date.now() > deadline) throw new Error('Omni file processing timed out');
      await sleep(2000);
    }
    return fetchBytes(`${BASE}/${name}:download?alt=media`, apiKey);
  }
  return fetchBytes(uri, apiKey);
}

async function postJson(url, apiKey, body) {
  const res = await withTimeout((signal) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    })
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Omni request failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return res.json();
}

async function getJson(url, apiKey) {
  const res = await withTimeout((signal) => fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal }));
  if (!res.ok) throw new Error(`Omni GET failed (${res.status}) for ${url}`);
  return res.json();
}

async function fetchBytes(url, apiKey) {
  const res = await withTimeout((signal) => fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal }));
  if (!res.ok) throw new Error(`Omni video download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function withTimeout(fn) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OMNI_TIMEOUT_MS);
  return Promise.resolve(fn(ctrl.signal)).finally(() => clearTimeout(t));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
