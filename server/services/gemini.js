import fs from 'node:fs';
import crypto from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import {
  MODELS,
  FILE_API_SIZE_BYTES,
  FILE_API_DURATION_SEC,
  SHOT_MIN_SEC,
  SHOT_MAX_SEC,
} from '../config.js';
import { uploadAndWait } from './files.js';
import { log } from '../util/log.js';

// One GoogleGenAI client per distinct API key, cached by a hash of the key so
// repeated calls for the same user reuse the client.
const _clients = new Map();
function client(apiKey) {
  if (!apiKey) throw new Error('No Gemini API key available for this request');
  const id = crypto.createHash('sha256').update(apiKey).digest('hex');
  let c = _clients.get(id);
  if (!c) {
    c = new GoogleGenAI({ apiKey });
    _clients.set(id, c);
  }
  return c;
}

// Retry transient Gemini errors — 503 UNAVAILABLE ("high demand"), 429 rate
// limit, 500 INTERNAL — with exponential backoff + jitter. Non-transient errors
// (e.g. 400 invalid key, 404 unknown model) throw immediately.
const TRANSIENT = /\b(429|500|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|overloaded|high demand|try again later/i;
// A hard quota/billing block (free tier "limit: 0", exceeded quota) will not
// recover by retrying — don't waste backoff on it, but DO fall back to another
// model that may still have quota.
const PERMANENT_QUOTA = /exceeded your current quota|limit:\s*0|check your plan and billing/i;
export async function withRetry(fn, { tries = 5, baseMs = 900, label = 'gemini' } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = String(err?.message || err);
      if (attempt === tries || !TRANSIENT.test(msg) || PERMANENT_QUOTA.test(msg)) throw err;
      const delay = Math.round(baseMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.3));
      log.warn({ label, attempt, tries, delay, err: msg.slice(0, 160) }, 'transient Gemini error; retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}

// A model that is missing/unsupported (404) — fall back to the next model rather
// than retrying the same one.
const NOT_FOUND = /\b404\b|not found|NOT_FOUND|is not supported|no longer available/i;

// Should this error make us try the NEXT model in a chain? True for overload,
// rate limits, hard quota blocks, and missing models. (False for e.g. 400 bad key.)
export function isFallbackError(err) {
  const msg = String(err?.message || err);
  return TRANSIENT.test(msg) || NOT_FOUND.test(msg) || PERMANENT_QUOTA.test(msg);
}

// An invalid / expired / forbidden key won't work no matter how many retries —
// but a BACKUP key might, so this is a "try the next key" (not next model) signal.
const INVALID_KEY = /API key not valid|API_KEY_INVALID|API key expired|invalid api key|PERMISSION_DENIED|permission denied|\b401\b|\b403\b/i;

// Users may store several keys as backups (e.g. one free + one with billing) so
// that when one is exhausted the app can fall through to the next. They travel as
// a single comma/newline-separated string; split into an ordered, unique list.
export function parseKeys(raw) {
  return [...new Set(String(raw || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
}

// Run `op(key)` against each stored key in turn, moving to the next key when the
// current one is over quota, overloaded, unavailable, or invalid. The first key
// that succeeds wins; if all fail the last error is thrown. This is the backup-key
// safety net — a single key just runs `op` once.
export async function withKeys(keys, op, { label = 'gemini' } = {}) {
  const list = parseKeys(keys);
  if (!list.length) throw new Error('No Gemini API key available for this request');
  let last;
  for (let i = 0; i < list.length; i++) {
    try {
      if (i > 0) log.warn({ label, keyIndex: i, keys: list.length }, 'trying backup Gemini key');
      return await op(list[i]);
    } catch (err) {
      last = err;
      const msg = String(err?.message || err);
      const canTryNext = i < list.length - 1 && (isFallbackError(err) || INVALID_KEY.test(msg));
      if (!canTryNext) throw err;
      log.warn({ label, keyIndex: i, err: msg.slice(0, 160) }, 'Gemini key failed; trying backup key');
    }
  }
  throw last;
}

// Call generateContent across a list of models: retry transient errors per model,
// and if a model stays overloaded (503) or is unavailable (404), fall back to the
// next model in the chain. Non-transient errors (e.g. 400 bad key) throw at once.
async function generateWithFallback(ai, models, params, label) {
  const chain = [...new Set(models.filter(Boolean))];
  let last;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      if (i > 0) log.warn({ label, model }, 'falling back to next model');
      return await withRetry(() => ai.models.generateContent({ ...params, model }), { label: `${label}:${model}` });
    } catch (err) {
      last = err;
      const hasNext = i < chain.length - 1;
      if (!hasNext || !isFallbackError(err)) throw err;
      log.warn({ label, model, err: String(err?.message || err).slice(0, 160) }, 'model unavailable; trying fallback');
    }
  }
  throw last;
}

const ANALYSIS_CHAIN = [MODELS.analysis, ...(MODELS.analysisFallbacks || [])];
const IMAGE_CHAIN = [MODELS.image, ...(MODELS.imageFallbacks || [])];

// Cheap call to confirm a key works before we store it.
export async function validateKey(apiKey) {
  try {
    await generateWithFallback(client(apiKey), ANALYSIS_CHAIN, {
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      config: { maxOutputTokens: 1 },
    }, 'validateKey');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  }
}

// Structured schema mirroring analysis.json segments.
const ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    language: { type: Type.STRING },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          start: { type: Type.STRING, description: 'MM:SS start timecode' },
          end: { type: Type.STRING, description: 'MM:SS end timecode' },
          transcript: { type: Type.STRING, description: 'verbatim words spoken, empty if none' },
          cleanedScript: {
            type: Type.STRING,
            description: 'filler/grammar-cleaned narration preserving meaning; empty if no speech',
          },
          sceneDescription: { type: Type.STRING },
          category: {
            type: Type.STRING,
            enum: ['speech', 'silence', 'filler', 'offtopic', 'bridge'],
          },
          relevance: { type: Type.NUMBER, description: '0..1' },
          keep: { type: Type.BOOLEAN },
          hasSpokenContent: { type: Type.BOOLEAN },
        },
        required: [
          'start', 'end', 'transcript', 'cleanedScript', 'sceneDescription',
          'category', 'relevance', 'keep', 'hasSpokenContent',
        ],
        propertyOrdering: [
          'start', 'end', 'transcript', 'cleanedScript', 'sceneDescription',
          'category', 'relevance', 'keep', 'hasSpokenContent',
        ],
      },
    },
  },
  required: ['language', 'segments'],
  propertyOrdering: ['language', 'segments'],
};

const ANALYSIS_PROMPT = `You are a professional video editor analyzing a screen-recording / talking-head video.
The video is sampled at 1 frame per second. Reference ALL timestamps as MM:SS.

Segment the video into contiguous, non-overlapping spans covering the whole duration in order.
For each span return:
- start, end: MM:SS timecodes.
- transcript: the verbatim words spoken in that span (empty string if no speech).
- cleanedScript: rewrite the spoken words for a professional voiceover — remove filler words ("um", "uh", "like", "you know"), false starts and stutters, and fix grammar — but PRESERVE the original meaning and add no new facts. If the span has no speech, use an empty string.
- sceneDescription: what is visually on screen.
- category: one of speech | silence | filler | offtopic | bridge.
- relevance: 0..1, how relevant the span is to the core message.
- keep: true to keep this span in the final video, false to cut it. Set keep=false for silence, filler-only spans, long dead air, and clearly off-topic/irrelevant content. Keep substantive speech.
- hasSpokenContent: true if there is meaningful speech to narrate.

Return strictly the JSON matching the schema.`;

// Analyze a video file. Chooses File API vs inline based on size/duration.
export async function analyzeVideo(apiKey, filePath, { sizeBytes = 0, durationSec = 0 } = {}) {
  return withKeys(apiKey, async (key) => {
    const ai = client(key);
    const useFileApi = sizeBytes > FILE_API_SIZE_BYTES || durationSec > FILE_API_DURATION_SEC;

    let videoPart;
    if (useFileApi) {
      const file = await uploadAndWait(ai, filePath, 'video/mp4');
      videoPart = { fileData: { fileUri: file.uri, mimeType: file.mimeType || 'video/mp4' } };
    } else {
      const data = fs.readFileSync(filePath).toString('base64');
      videoPart = { inlineData: { mimeType: 'video/mp4', data } };
    }

    log.info({ useFileApi }, 'requesting video analysis');
    const res = await generateWithFallback(ai, ANALYSIS_CHAIN, {
      contents: [{ role: 'user', parts: [videoPart, { text: ANALYSIS_PROMPT }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_SCHEMA,
      },
    }, 'analyze');

    const text = res.text;
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Failed to parse analysis JSON: ${e.message}\n${text?.slice(0, 500)}`);
    }
  }, { label: 'analyze' });
}

async function ttsOnce(ai, model, text, voiceName) {
  const res = await withRetry(() => ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  }), { label: `tts:${model}`, tries: 3 });
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  return part ? Buffer.from(part.inlineData.data, 'base64') : null;
}

// Synthesize one segment of narration. Returns raw PCM (Buffer). Tries the primary
// TTS model, then the fallback, since preview TTS models occasionally return text
// instead of audio.
export async function synthesizeSpeech(apiKey, text, voiceName) {
  return withKeys(apiKey, async (key) => {
    const ai = client(key);
    const models = [MODELS.tts, MODELS.ttsFallback].filter(Boolean);
    let lastErr;
    for (const model of models) {
      try {
        const buf = await ttsOnce(ai, model, text, voiceName);
        if (buf) return buf;
        log.warn({ model }, 'TTS returned no audio; trying next model');
      } catch (err) {
        lastErr = err;
        log.warn({ model, err: String(err?.message || err).slice(0, 160) }, 'TTS call failed; trying next model');
      }
    }
    // Surface the underlying error so withKeys can decide whether a backup key
    // might help (quota/overload/invalid) rather than always giving up here.
    if (lastErr) throw lastErr;
    throw new Error('TTS produced no audio from any model');
  }, { label: 'tts' });
}

// ---------------------------------------------------------------------------
// "Generate a video" (Omni) mode helpers
// ---------------------------------------------------------------------------

const STORYBOARD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    shots: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          prompt: {
            type: Type.STRING,
            description:
              'Self-contained cinematic description of ONE continuous shot (camera, action, setting, lighting). Repeat the exact character description every time so the person looks identical.',
          },
          narration: {
            type: Type.STRING,
            description: 'One sentence of voiceover narration spoken over this shot.',
          },
          durationSec: { type: Type.NUMBER, description: `Shot length in seconds, ${SHOT_MIN_SEC}-${SHOT_MAX_SEC}.` },
        },
        required: ['prompt', 'narration', 'durationSec'],
        propertyOrdering: ['prompt', 'narration', 'durationSec'],
      },
    },
  },
  required: ['title', 'shots'],
  propertyOrdering: ['title', 'shots'],
};

// Break a concept into an ordered list of short shots that sum to ~targetDuration.
// Each shot prompt embeds the locked character description so identity survives
// even independent of Omni's stateful chaining.
export async function generateStoryboard(apiKey, brief) {
  return withKeys(apiKey, (key) => generateStoryboardOnce(key, brief), { label: 'storyboard' });
}

async function generateStoryboardOnce(apiKey, brief) {
  const ai = client(apiKey);
  const target = Math.min(60, Math.max(SHOT_MIN_SEC, Number(brief.targetDurationSec) || 30));
  const character = (brief.characterDesc || '').trim();
  const prompt = `You are a film director planning a short ${target}-second video.

Concept: ${brief.concept}
${character ? `Main character (describe them EXACTLY the same way in every shot's prompt so they look identical throughout): ${character}` : 'Keep any recurring people visually identical across all shots — describe them the same way every time.'}
Aspect ratio: ${brief.aspectRatio || '16:9'}.

Break this into a sequence of ${SHOT_MIN_SEC}-${SHOT_MAX_SEC} second shots whose durations sum to about ${target} seconds (never more than 60). For each shot:
- prompt: a single continuous camera shot (no scene cuts within a shot), vividly described for a text-to-video model, ALWAYS restating the full character description so the person is consistent.
- narration: exactly one spoken sentence of voiceover for that shot, in a consistent narrator voice.
- durationSec: between ${SHOT_MIN_SEC} and ${SHOT_MAX_SEC}.

Return strictly JSON matching the schema.`;

  const res = await generateWithFallback(ai, ANALYSIS_CHAIN, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseMimeType: 'application/json', responseSchema: STORYBOARD_SCHEMA },
  }, 'storyboard');
  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch (e) {
    throw new Error(`Failed to parse storyboard JSON: ${e.message}\n${res.text?.slice(0, 400)}`);
  }
  // Clamp durations and total to keep us <= 60s.
  let budget = 60;
  parsed.shots = (parsed.shots || []).map((s) => {
    const d = Math.min(SHOT_MAX_SEC, Math.max(SHOT_MIN_SEC, Math.round(Number(s.durationSec) || SHOT_MIN_SEC)));
    return { ...s, durationSec: d };
  }).filter((s) => (budget -= s.durationSec) >= -SHOT_MAX_SEC);
  return parsed;
}

// Generate one portrait keyframe for a synthetic character; the PNG bytes become
// the canonical subject-reference image reused on every shot. Returns a Buffer.
export async function generateCharacterImage(apiKey, description) {
  return withKeys(apiKey, (key) => generateCharacterImageOnce(key, description), { label: 'characterImage' });
}

async function generateCharacterImageOnce(apiKey, description) {
  const ai = client(apiKey);
  const res = await generateWithFallback(ai, IMAGE_CHAIN, {
    contents: [{
      role: 'user',
      parts: [{
        text: `A single, well-lit reference portrait photo of this character, neutral background, looking at camera, photorealistic: ${description}`,
      }],
    }],
  }, 'characterImage');
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error('Character image model returned no image');
  return Buffer.from(part.inlineData.data, 'base64');
}
