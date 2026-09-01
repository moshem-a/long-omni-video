import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const ASSETS_DIR = path.join(ROOT, 'assets');

// Per-job working dir. On Cloud Run the only writable, large-enough location is
// the in-memory /tmp, so default there and allow override via JOBS_DIR.
export const JOBS_DIR = process.env.JOBS_DIR || path.join(os.tmpdir(), 'video-editor-jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });

export const PORT = Number(process.env.PORT) || 9002;

// No accounts: each request brings its own Gemini key (x-gemini-key), held in
// memory only. Nothing per-user is stored, so there is no global/encryption key.
export const GCS_BUCKET = process.env.GCS_BUCKET || '';
// DEV_NO_AUTH=1 lets requests without a key header fall back to GEMINI_API_KEY.
export const DEV_NO_AUTH = process.env.DEV_NO_AUTH === '1';

// Gemini models. The 2.5-flash-preview-tts model intermittently emits text
// instead of audio ("Model tried to generate text"); 3.1-flash-tts is reliable,
// with pro-tts as a fallback.
export const MODELS = {
  analysis: 'gemini-3.6-flash',
  tts: 'gemini-3.1-flash-tts-preview',
  ttsFallback: 'gemini-2.5-pro-preview-tts',
  // Generative "Generate a video" mode:
  omni: process.env.OMNI_MODEL || 'gemini-omni-1.1-flash', // per-shot text/image/reference -> video
  image: process.env.IMAGE_MODEL || 'gemini-2.5-flash-image', // synthetic character keyframe (subject ref)
};

// "Generate a video" (Omni) mode. A minute is built from several short shots
// because Omni produces one short clip per interaction; we stitch them and lay a
// single locked TTS voice over the top (Omni's own audio is discarded).
export const MAX_GENERATE_DURATION_SEC = 60;
export const SHOT_MIN_SEC = 4;
export const SHOT_MAX_SEC = 8;
export const OMNI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const OMNI_TIMEOUT_MS = 8 * 60 * 1000; // one interaction can take minutes
// Omni 1.1 output resolution ("360p" | "720p" | "1080p" | "4k"). 720p matches
// ASPECT_DIMS below and keeps per-shot latency reasonable.
export const OMNI_RESOLUTION = process.env.OMNI_RESOLUTION || '720p';
// Output pixel dims per aspect ratio (even numbers; 720p-class).
export const ASPECT_DIMS = {
  '16:9': { w: 1280, h: 720 },
  '9:16': { w: 720, h: 1280 },
};
export const DEFAULT_ASPECT = '16:9';

// Video understanding samples at 1 fps; thresholds for choosing the File API.
export const FILE_API_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
export const FILE_API_DURATION_SEC = 10 * 60; // 10 min

// TTS output format (Gemini returns 24kHz 16-bit mono PCM).
export const TTS_SAMPLE_RATE = 24000;
export const TTS_CHANNELS = 1;
export const TTS_BITS = 16;

// Assembly defaults.
export const OUTPUT_FPS = 30;
export const STRETCH_RATIO_MIN = 0.5;
export const STRETCH_RATIO_MAX = 2.0;
export const SEGMENT_TAIL_PAD_SEC = 0.12;

// Concurrency for outbound Gemini TTS calls.
export const TTS_CONCURRENCY = 3;

// The 30 Gemini prebuilt voices, with a short descriptor for the UI.
export const VOICES = [
  { name: 'Zephyr', style: 'Bright' },
  { name: 'Puck', style: 'Upbeat' },
  { name: 'Charon', style: 'Informative' },
  { name: 'Kore', style: 'Firm' },
  { name: 'Fenrir', style: 'Excitable' },
  { name: 'Leda', style: 'Youthful' },
  { name: 'Orus', style: 'Firm' },
  { name: 'Aoede', style: 'Breezy' },
  { name: 'Callirrhoe', style: 'Easy-going' },
  { name: 'Autonoe', style: 'Bright' },
  { name: 'Enceladus', style: 'Breathy' },
  { name: 'Iapetus', style: 'Clear' },
  { name: 'Umbriel', style: 'Easy-going' },
  { name: 'Algieba', style: 'Smooth' },
  { name: 'Despina', style: 'Smooth' },
  { name: 'Erinome', style: 'Clear' },
  { name: 'Algenib', style: 'Gravelly' },
  { name: 'Rasalgethi', style: 'Informative' },
  { name: 'Laomedeia', style: 'Upbeat' },
  { name: 'Achernar', style: 'Soft' },
  { name: 'Alnilam', style: 'Firm' },
  { name: 'Schedar', style: 'Even' },
  { name: 'Gacrux', style: 'Mature' },
  { name: 'Pulcherrima', style: 'Forward' },
  { name: 'Achird', style: 'Friendly' },
  { name: 'Zubenelgenubi', style: 'Casual' },
  { name: 'Vindemiatrix', style: 'Gentle' },
  { name: 'Sadachbia', style: 'Lively' },
  { name: 'Sadaltager', style: 'Knowledgeable' },
  { name: 'Sulafat', style: 'Warm' },
];

export const DEFAULT_VOICE = 'Kore';
