import fs from 'node:fs';
import path from 'node:path';
import { generateStoryboard, generateCharacterImage } from '../../services/gemini.js';
import { uploadFile } from '../../services/storage.js';
import { updateJob, refsObject } from '../jobStore.js';
import { DEFAULT_VOICE } from '../../config.js';
import { log } from '../../util/log.js';

// Generate phase 1: turn the brief into an editable, ordered storyboard.
// For a synthetic character, first mint a canonical portrait keyframe that every
// shot will reuse as its subject reference (identity lock).
export async function buildStoryboard(job) {
  updateJob(job.id, { status: 'storyboarding', stage: 'storyboard', progress: 0.1, error: null });
  const brief = job.brief || {};

  // Synthetic character: create + persist a reference image if we don't have one.
  if (brief.characterMode === 'synthetic' && !(brief.characterRefs?.length) && brief.characterDesc) {
    const png = await generateCharacterImage(job.apiKey, brief.characterDesc);
    const local = path.join(job.paths.dir, 'refs', '00.png');
    fs.writeFileSync(local, png);
    const object = refsObject(job.id, 0);
    await uploadFile(local, object, 'image/png');
    brief.characterRefs = [object];
    updateJob(job.id, { brief });
    log.info({ jobId: job.id }, 'storyboard: synthetic character keyframe created');
  }

  const sb = await generateStoryboard(job.apiKey, brief);
  const hasRefs = (brief.characterRefs?.length || 0) > 0;
  const shots = (sb.shots || []).map((s, i) => ({
    id: `shot_${String(i).padStart(3, '0')}`,
    prompt: s.prompt,
    narration: (s.narration || '').trim(),
    durationSec: s.durationSec,
    // First shot animates the reference image directly (image-to-video); the rest
    // use it as a subject reference so the person stays identical across the video.
    task: hasRefs ? (i === 0 ? 'image_to_video' : 'reference_to_video') : 'text_to_video',
    status: 'pending',
    videoObject: null,
    omniInteractionId: null,
  }));

  updateJob(job.id, {
    storyboard: { title: sb.title || brief.concept?.slice(0, 60) || 'Untitled', shots },
    voice: job.voice || DEFAULT_VOICE,
    status: 'storyboarded',
    stage: 'storyboard',
    progress: 0.3,
  });
  log.info({ jobId: job.id, shots: shots.length }, 'storyboard ready');
}
