import fs from 'node:fs';
import path from 'node:path';
import { generateShot } from '../../services/omni.js';
import { uploadFile, downloadToFile } from '../../services/storage.js';
import { probeFile } from '../../services/ffmpeg.js';
import { withRetry } from '../../util/retry.js';
import { updateJob, shotObject } from '../jobStore.js';
import { writeTimeline } from './plan.js';
import { log } from '../../util/log.js';

// Build the render timeline from the storyboard. Each shot becomes a timeline
// segment shaped like plan.js output, so the existing tts/finalize/captions/
// assemble stages can be reused unchanged (video source is the shot file).
export function buildGenerateTimeline(job) {
  const timeline = {
    fit: 'stretch',
    transition: 'none',
    transitionSec: 0,
    segments: job.storyboard.shots.map((sh, i) => ({
      outIndex: i,
      shotId: sh.id,
      prompt: sh.prompt,
      task: sh.task,
      narration: (sh.narration || '').trim(),
      videoPath: null, // filled by generateShots -> drives buildClip
      srcStartSec: 0,
      srcDurSec: null,
      ttsWav: null,
      ttsDurSec: null,
      videoTargetDurSec: null,
      timelineStartSec: null,
    })),
  };
  writeTimeline(job, timeline);
  return timeline;
}

// Generate phase 2: produce (or reuse cached) a video clip per shot via Omni.
// Fills seg.videoPath + seg.srcDurSec for the assemble stage.
export async function generateShots(job, timeline) {
  updateJob(job.id, { status: 'generating', stage: 'generate', progress: 0.1, error: null });
  const shotsDir = path.join(job.paths.dir, 'shots');
  const aspectRatio = job.brief?.aspectRatio || '16:9';
  const refImages = await loadRefImages(job);

  const shots = job.storyboard.shots;
  let lastInteractionId = null;
  let done = 0;

  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    const seg = timeline.segments[i];
    const local = path.join(shotsDir, `${String(i).padStart(3, '0')}.mp4`);

    if (shot.videoObject && !fs.existsSync(local)) {
      // Reuse a clip generated on a previous run (cache) — pull it back from GCS.
      try {
        await downloadToFile(shot.videoObject, local);
      } catch {
        shot.videoObject = null; // cache miss -> regenerate below
      }
    }

    if (!shot.videoObject) {
      const { interactionId, buffer } = await withRetry(
        () => generateShot(job.apiKey, {
          prompt: shot.prompt,
          refImages,
          previousInteractionId: lastInteractionId,
          aspectRatio,
          task: shot.task,
        }),
        { label: `omni:${i}`, tries: 2 }
      );
      fs.writeFileSync(local, buffer);
      const object = shotObject(job.id, i);
      await uploadFile(local, object);
      shot.videoObject = object;
      shot.omniInteractionId = interactionId;
      shot.status = 'ready';
      updateJob(job.id, { storyboard: job.storyboard }); // mirror shot progress
      log.info({ jobId: job.id, shot: i }, 'omni shot ready');
    }

    lastInteractionId = shot.omniInteractionId || lastInteractionId;
    const meta = await probeFile(local);
    seg.srcDurSec = Math.max(0.1, meta.durationSec || shot.durationSec || 4);
    seg.videoPath = local;

    done += 1;
    updateJob(job.id, { progress: 0.1 + 0.34 * (done / shots.length) });
  }

  writeTimeline(job, timeline);
  return timeline;
}

// Download each character reference from GCS (if not already local) and return
// [{data:<base64>, mimeType}] for the Omni request.
async function loadRefImages(job) {
  const refs = job.brief?.characterRefs || [];
  const out = [];
  for (let i = 0; i < refs.length; i += 1) {
    const local = path.join(job.paths.dir, 'refs', `${String(i).padStart(2, '0')}.bin`);
    if (!fs.existsSync(local)) {
      try {
        await downloadToFile(refs[i], local);
      } catch (err) {
        log.warn({ ref: refs[i], err: err.message }, 'failed to load character reference; skipping');
        continue;
      }
    }
    const buf = fs.readFileSync(local);
    out.push({ data: buf.toString('base64'), mimeType: sniffMime(buf) });
  }
  return out;
}

function sniffMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/png';
}
