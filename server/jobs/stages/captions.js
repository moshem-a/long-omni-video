import fs from 'node:fs';
import path from 'node:path';
import { secondsToSrt } from '../../util/time.js';

// Stage 5: build an SRT keyed to the SAME timeline offsets that drive the video,
// so captions cannot drift. One cue per narrated segment (MVP granularity).
export function buildCaptions(job, timeline) {
  const cues = [];
  let n = 1;
  for (const seg of timeline.segments) {
    if (!seg.narration || !seg.ttsDurSec) continue;
    const start = seg.timelineStartSec;
    const end = start + seg.ttsDurSec;
    cues.push(`${n}\n${secondsToSrt(start)} --> ${secondsToSrt(end)}\n${wrap(seg.narration)}\n`);
    n += 1;
  }
  const srtPath = path.join(job.paths.dir, 'captions.srt');
  fs.writeFileSync(srtPath, cues.join('\n'));
  return srtPath;
}

// Soft-wrap long cues to ~42 chars/line for readability.
function wrap(text, width = 42) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      if (line) lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 2).join('\n');
}
