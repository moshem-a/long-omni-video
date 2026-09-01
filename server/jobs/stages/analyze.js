import { analyzeVideo } from '../../services/gemini.js';
import { updateJob } from '../jobStore.js';
import { timecodeToSeconds } from '../../util/time.js';
import { withRetry } from '../../util/retry.js';

// Stage 1: Gemini video understanding -> normalized analysis with second offsets.
export async function analyze(job) {
  updateJob(job.id, { status: 'analyzing', stage: 'analyze', progress: 0.15 });

  const raw = await withRetry(
    () => analyzeVideo(job.apiKey, job.paths.source, {
      sizeBytes: job.source?.sizeBytes,
      durationSec: job.source?.durationSec,
    }),
    { label: 'analyzeVideo' }
  );

  const dur = job.source?.durationSec || 0;
  const segments = (raw.segments || []).map((s, i) => {
    let startSec = timecodeToSeconds(s.start) ?? 0;
    let endSec = timecodeToSeconds(s.end) ?? startSec;
    // Clamp to the real duration; derive seconds server-side (don't trust the model).
    startSec = Math.max(0, Math.min(startSec, dur || startSec));
    endSec = Math.max(startSec, Math.min(endSec, dur || endSec));
    return {
      id: i,
      start: s.start,
      end: s.end,
      startSec,
      endSec,
      transcript: s.transcript || '',
      cleanedScript: s.cleanedScript || '',
      sceneDescription: s.sceneDescription || '',
      category: s.category || 'speech',
      relevance: typeof s.relevance === 'number' ? s.relevance : 0.5,
      keep: s.keep !== false,
      hasSpokenContent: Boolean(s.hasSpokenContent),
    };
  });

  const analysis = { language: raw.language || 'en', segments };
  updateJob(job.id, { status: 'analyzed', stage: 'analyze', progress: 0.35, analysis });
  return analysis;
}
