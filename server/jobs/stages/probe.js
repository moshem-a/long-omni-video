import { probeFile } from '../../services/ffmpeg.js';
import { updateJob } from '../jobStore.js';

// Stage 0: probe the uploaded source for duration/fps/resolution/audio.
export async function probe(job) {
  updateJob(job.id, { status: 'probing', stage: 'probe', progress: 0.05 });
  const meta = await probeFile(job.paths.source);
  updateJob(job.id, { source: { ...job.source, ...meta } });
  return meta;
}
