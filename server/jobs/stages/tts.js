import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { synthesizeSpeech } from '../../services/gemini.js';
import { wrapWavHeader, pcmDurationSec } from '../../util/pcm.js';
import { withRetry } from '../../util/retry.js';
import { updateJob } from '../jobStore.js';
import {
  TTS_CONCURRENCY, TTS_SAMPLE_RATE, TTS_CHANNELS, TTS_BITS,
} from '../../config.js';

// Stage 4: synthesize narration per segment (drift-safe) and record durations.
export async function tts(job, timeline) {
  updateJob(job.id, { status: 'synthesizing', stage: 'tts', progress: 0.45 });
  const voice = job.voice;
  const limit = pLimit(TTS_CONCURRENCY);
  const ttsDir = path.join(job.paths.dir, 'tts');

  const spoken = timeline.segments.filter((s) => s.narration);
  let done = 0;

  await Promise.all(
    spoken.map((seg) =>
      limit(async () => {
        const pcm = await withRetry(() => synthesizeSpeech(job.apiKey, seg.narration, voice), {
          label: `tts:${seg.outIndex}`,
        });
        const wav = wrapWavHeader(pcm, TTS_SAMPLE_RATE, TTS_CHANNELS, TTS_BITS);
        const file = path.join(ttsDir, `seg_${String(seg.outIndex).padStart(3, '0')}.wav`);
        fs.writeFileSync(file, wav);
        seg.ttsWav = file;
        seg.ttsDurSec = pcmDurationSec(pcm, TTS_SAMPLE_RATE, TTS_CHANNELS, TTS_BITS);
        done += 1;
        updateJob(job.id, { progress: 0.45 + 0.2 * (done / spoken.length) });
      })
    )
  );

  return timeline;
}
