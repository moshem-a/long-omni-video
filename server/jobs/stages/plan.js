import fs from 'node:fs';
import path from 'node:path';
import { updateJob } from '../jobStore.js';

// Stage 3: build the timeline model from kept segments + user edits.
// Fills source cut points + narration only; TTS durations / absolute offsets
// are filled later (after the tts stage) by finalizeTimeline().
export function plan(job) {
  updateJob(job.id, { status: 'planning', stage: 'plan', progress: 0.4 });

  const segs = job.analysis.segments.filter((s) => s.keep);
  const timeline = {
    fit: job.options?.videoFitMode || 'stretch',
    // transition preference kept for the assemble stage; offset overlap stays 0
    // until crossfade is actually applied (Milestone 7) so captions can't drift.
    transition: job.options?.transition || 'none',
    transitionSec: 0,
    segments: segs.map((s, i) => ({
      outIndex: i,
      srcId: s.id,
      srcStartSec: s.startSec,
      srcEndSec: s.endSec,
      srcDurSec: Math.max(0.001, s.endSec - s.startSec),
      narration: (s.cleanedScript || '').trim(),
      ttsWav: null,
      ttsDurSec: null,
      videoTargetDurSec: null,
      timelineStartSec: null,
    })),
  };

  writeTimeline(job, timeline);
  return timeline;
}

// Called after TTS: set per-clip video target durations and absolute offsets.
export function finalizeTimeline(job, timeline, tailPadSec) {
  let cursor = 0;
  for (const seg of timeline.segments) {
    // Segments with no narration keep their natural source duration.
    const audioDur = seg.ttsDurSec || 0;
    seg.videoTargetDurSec = audioDur > 0 ? audioDur + tailPadSec : seg.srcDurSec;
    seg.timelineStartSec = cursor;
    cursor += seg.videoTargetDurSec - (timeline.transitionSec || 0);
  }
  writeTimeline(job, timeline);
  return timeline;
}

export function writeTimeline(job, timeline) {
  fs.writeFileSync(path.join(job.paths.dir, 'timeline.json'), JSON.stringify(timeline, null, 2));
}
