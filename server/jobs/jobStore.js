import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { JOBS_DIR } from '../config.js';
import * as jobRepo from '../services/jobRepo.js';

// In-memory job map mirrored to jobs/<id>/job.json (fast, local — needed by
// FFmpeg) AND to Firestore (durable — survives restarts, powers run history).
const jobs = new Map();

export function jobDir(id) {
  return path.join(JOBS_DIR, id);
}

// GCS object layout for a job's retained media.
export function sourceObject(id) {
  return `jobs/${id}/source.mp4`;
}
export function finalObject(id) {
  return `jobs/${id}/final.mp4`;
}
// Generate-mode media: character reference images and per-shot clips.
export function refsObject(id, i) {
  return `jobs/${id}/refs/${String(i).padStart(2, '0')}.png`;
}
export function shotObject(id, i) {
  return `jobs/${id}/shots/${String(i).padStart(3, '0')}.mp4`;
}

function persist(job) {
  try {
    // Never write secrets to disk.
    const { apiKey, ...safe } = job;
    fs.writeFileSync(path.join(jobDir(job.id), 'job.json'), JSON.stringify(safe, null, 2));
  } catch {
    /* best-effort */
  }
}

// Only mirror to Firestore on meaningful changes — NOT on every progress tick
// (assemble.js emits a {progress} patch per clip). Keeps writes to ~8-10/job.
function shouldMirror(patch) {
  return (
    'status' in patch ||
    'stage' in patch ||
    'error' in patch ||
    'analysis' in patch ||
    'voice' in patch ||
    'options' in patch ||
    'gcs' in patch ||
    'source' in patch ||
    'brief' in patch ||
    'storyboard' in patch
  );
}

export function createJob(extra = {}) {
  const id = nanoid(10);
  const dir = jobDir(id);
  for (const sub of ['tts', 'clips', 'refs', 'shots']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  const job = {
    id,
    uid: null,
    apiKey: null, // in-memory only; stripped from persistence + public views
    kind: 'edit', // 'edit' (upload -> polish) | 'generate' (Omni long video)
    status: 'uploaded',
    stage: null,
    progress: 0,
    error: null,
    createdAt: new Date().toISOString(),
    source: null,
    analysis: null,
    brief: null, // generate: {concept,targetDurationSec,aspectRatio,characterMode,characterRefs,characterDesc}
    storyboard: null, // generate: {shots:[{id,prompt,narration,durationSec,task,status,videoObject,omniInteractionId}]}
    voice: null,
    options: null,
    gcs: { source: sourceObject(id), final: null },
    paths: { dir },
    ...extra,
  };
  jobs.set(id, job);
  persist(job);
  jobRepo.saveJob(job.uid, job).catch(() => {});
  return job;
}

export function getJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  // Try to rehydrate from local disk after a restart (same instance /tmp).
  const file = path.join(jobDir(id), 'job.json');
  if (fs.existsSync(file)) {
    try {
      const job = JSON.parse(fs.readFileSync(file, 'utf8'));
      jobs.set(id, job);
      return job;
    } catch {
      return null;
    }
  }
  return null;
}

// Durable lookup: memory -> local /tmp -> Firestore. Used for history / reopen,
// where /tmp may be gone. On a Firestore hit, seed local state so the pipeline
// (which reads job.paths.dir) can operate again.
export async function resolveJob(uid, id) {
  const local = getJob(id);
  if (local) return local;
  const remote = await jobRepo.loadJob(uid, id);
  if (!remote) return null;
  const dir = jobDir(id);
  for (const sub of ['tts', 'clips', 'refs', 'shots']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  jobs.set(id, remote);
  persist(remote);
  return remote;
}

export function updateJob(id, patch) {
  const job = jobs.get(id) || getJob(id);
  if (!job) return null;
  Object.assign(job, patch);
  persist(job);
  if (shouldMirror(patch)) jobRepo.saveJob(job.uid, job).catch(() => {});
  return job;
}

export async function listJobs(uid) {
  return jobRepo.listJobs(uid);
}

export function removeJob(id) {
  jobs.delete(id);
  try {
    fs.rmSync(jobDir(id), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// Public view sent to the browser — strip secrets and internal paths, and add
// derived flags the UI needs.
export function publicJob(job) {
  if (!job) return null;
  const { paths, apiKey, uid, gcs, brief, storyboard, ...rest } = job;
  const hasFinal =
    Boolean(gcs?.final) || fs.existsSync(path.join(jobDir(job.id), 'final.mp4'));
  return {
    ...rest,
    hasFinal,
    keptSegments: job.analysis?.segments?.filter((s) => s.keep).length ?? 0,
    brief: publicBrief(brief),
    storyboard: publicStoryboard(storyboard),
  };
}

// Strip internal GCS object paths from generate-mode data before sending to the
// browser (don't leak bucket layout), keeping only what the UI renders.
function publicBrief(brief) {
  if (!brief) return null;
  const { characterRefs, ...rest } = brief;
  return { ...rest, hasCharacter: Array.isArray(characterRefs) && characterRefs.length > 0 };
}
function publicStoryboard(storyboard) {
  if (!storyboard?.shots) return storyboard || null;
  return {
    ...storyboard,
    shots: storyboard.shots.map((s) => ({
      id: s.id,
      prompt: s.prompt,
      narration: s.narration,
      durationSec: s.durationSec,
      task: s.task,
      status: s.status || (s.videoObject ? 'ready' : 'pending'),
    })),
  };
}
