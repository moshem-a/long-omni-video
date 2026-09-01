import { probe } from './stages/probe.js';
import { analyze } from './stages/analyze.js';
import { plan, finalizeTimeline } from './stages/plan.js';
import { tts } from './stages/tts.js';
import { buildCaptions } from './stages/captions.js';
import { assemble } from './stages/assemble.js';
import { buildStoryboard } from './stages/storyboard.js';
import { buildGenerateTimeline, generateShots } from './stages/generate.js';
import { updateJob, finalObject } from './jobStore.js';
import { uploadFile } from '../services/storage.js';
import { SEGMENT_TAIL_PAD_SEC, ASPECT_DIMS, DEFAULT_ASPECT } from '../config.js';
import { log } from '../util/log.js';

// Phase 1: probe + analyze (runs right after upload).
export async function runAnalyze(job) {
  try {
    await probe(job);
    await analyze(job);
  } catch (err) {
    log.error({ jobId: job.id, err: err.message }, 'analyze failed');
    updateJob(job.id, { status: 'error', error: err.message });
  }
}

// Generate phase 1: storyboard (fast; runs right after job create, like analyze).
export async function runStoryboard(job) {
  try {
    await buildStoryboard(job);
  } catch (err) {
    log.error({ jobId: job.id, err: err.message }, 'storyboard failed');
    updateJob(job.id, { status: 'error', error: err.message });
  }
}

// Phase 2: plan -> tts -> finalize -> captions -> assemble. One at a time.
// Generate-mode renders share the SAME serialized chain (one heavy job per
// single instance) so an Omni generation never runs alongside an FFmpeg render.
let renderChain = Promise.resolve();
export function enqueueRender(job) {
  renderChain = renderChain.then(() => runRender(job)).catch(() => {});
  return renderChain;
}

export function enqueueGenerate(job) {
  renderChain = renderChain.then(() => runGenerate(job)).catch(() => {});
  return renderChain;
}

// Generate phase 2: shots (Omni) -> tts (locked voice) -> finalize -> captions ->
// assemble (per-shot video + our narration; Omni audio discarded) -> upload.
async function runGenerate(job) {
  try {
    const timeline = buildGenerateTimeline(job);
    await generateShots(job, timeline);

    // Assemble needs output pixel dims; derive them from the chosen aspect ratio
    // (there is no uploaded source in generate mode).
    const dims = ASPECT_DIMS[job.brief?.aspectRatio] || ASPECT_DIMS[DEFAULT_ASPECT];
    updateJob(job.id, { source: { ...(job.source || {}), width: dims.w, height: dims.h } });

    await tts(job, timeline);
    finalizeTimeline(job, timeline, SEGMENT_TAIL_PAD_SEC);
    const srtPath = buildCaptions(job, timeline);
    const finalPath = await assemble(job, timeline, srtPath);

    let gcsFinal = null;
    try {
      const object = finalObject(job.id);
      await uploadFile(finalPath, object);
      gcsFinal = object;
    } catch (err) {
      log.warn({ jobId: job.id, err: err.message }, 'final upload to GCS failed');
    }

    updateJob(job.id, {
      status: 'done',
      stage: 'done',
      progress: 1,
      gcs: { ...(job.gcs || {}), final: gcsFinal },
    });
    log.info({ jobId: job.id }, 'generate complete');
  } catch (err) {
    log.error({ jobId: job.id, err: err.message }, 'generate failed');
    updateJob(job.id, { status: 'error', error: err.message });
  }
}

async function runRender(job) {
  try {
    const timeline = plan(job);
    await tts(job, timeline);
    finalizeTimeline(job, timeline, SEGMENT_TAIL_PAD_SEC);
    const srtPath = buildCaptions(job, timeline);
    const finalPath = await assemble(job, timeline, srtPath);

    // Persist the finished video to GCS so it survives instance restarts and can
    // be re-downloaded from history. Best-effort: on failure the local copy still
    // serves on this instance.
    let gcsFinal = null;
    try {
      const object = finalObject(job.id);
      await uploadFile(finalPath, object);
      gcsFinal = object;
    } catch (err) {
      log.warn({ jobId: job.id, err: err.message }, 'final upload to GCS failed');
    }

    updateJob(job.id, {
      status: 'done',
      stage: 'done',
      progress: 1,
      gcs: { ...(job.gcs || {}), final: gcsFinal },
    });
    log.info({ jobId: job.id }, 'render complete');
  } catch (err) {
    log.error({ jobId: job.id, err: err.message }, 'render failed');
    updateJob(job.id, { status: 'error', error: err.message });
  }
}
