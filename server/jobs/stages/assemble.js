import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from '../../services/ffmpeg.js';
import { updateJob } from '../jobStore.js';
import {
  OUTPUT_FPS, STRETCH_RATIO_MIN, STRETCH_RATIO_MAX, ASSETS_DIR,
} from '../../config.js';
import { log } from '../../util/log.js';

// Stage 6: build a normalized clip per segment (video fit to new audio), concat,
// then a final mux pass for music + optional caption burn-in. -> final.mp4
export async function assemble(job, timeline, srtPath) {
  updateJob(job.id, { status: 'assembling', stage: 'assemble', progress: 0.7 });
  const dir = job.paths.dir;
  const clipsDir = path.join(dir, 'clips');
  const w = evenDim(job.source?.width || 1280);
  const h = evenDim(job.source?.height || 720);

  // 1) Build each segment clip.
  let i = 0;
  for (const seg of timeline.segments) {
    await buildClip(job, seg, { w, h });
    i += 1;
    updateJob(job.id, { progress: 0.7 + 0.15 * (i / timeline.segments.length) });
  }

  // 2) Concat clips (all share codecs/params -> stream copy).
  const listPath = path.join(dir, 'concat.txt');
  fs.writeFileSync(
    listPath,
    timeline.segments
      .map((s) => `file '${clipPath(clipsDir, s.outIndex)}'`)
      .join('\n')
  );
  const concatPath = path.join(dir, 'concat.mp4');
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatPath]);

  // 3) Final mux: music bed + optional burned captions.
  const finalPath = path.join(dir, 'final.mp4');
  await muxFinal(job, { concatPath, srtPath, finalPath, w, h });

  updateJob(job.id, { paths: { ...job.paths, final: finalPath }, progress: 0.98 });
  return finalPath;
}

async function buildClip(job, seg, { w, h }) {
  const clipsDir = path.join(job.paths.dir, 'clips');
  const out = clipPath(clipsDir, seg.outIndex);
  const target = seg.videoTargetDurSec;
  const ratio = clamp(target / seg.srcDurSec, STRETCH_RATIO_MIN, STRETCH_RATIO_MAX);
  const videoLenAfter = seg.srcDurSec * ratio;

  // Video filter: time-stretch, then freeze-pad if still short (audio much longer).
  let vf = `setpts=${ratio.toFixed(6)}*PTS`;
  if (videoLenAfter < target - 0.02) {
    const padDur = (target - videoLenAfter).toFixed(3);
    vf += `,tpad=stop_mode=clone:stop_duration=${padDur}`;
  }
  vf += `,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${OUTPUT_FPS},setsar=1,format=yuv420p`;

  // Edit mode trims the single uploaded source; generate mode uses a per-shot
  // clip (seg.videoPath). Either way we take only its video ([0:v]) and pair it
  // with our locked TTS audio below, so any source/Omni audio is discarded.
  const srcPath = seg.videoPath || job.paths.source;
  const startSec = seg.srcStartSec ?? 0;
  const args = ['-ss', String(startSec), '-t', String(seg.srcDurSec), '-i', srcPath];

  if (seg.ttsWav) {
    args.push('-i', seg.ttsWav);
    args.push(
      '-filter_complex', `[0:v]${vf}[v];[1:a]apad,aformat=sample_rates=48000:channel_layouts=stereo[a]`,
      '-map', '[v]', '-map', '[a]'
    );
  } else {
    // No narration: keep native pace, add silent stereo audio.
    args.push('-f', 'lavfi', '-t', String(target), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    args.push('-filter_complex', `[0:v]${vf}[v]`, '-map', '[v]', '-map', '1:a');
  }

  args.push(
    '-t', String(target),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    '-video_track_timescale', '90000',
    out
  );

  log.debug({ seg: seg.outIndex, ratio, target }, 'building clip');
  await runFfmpeg(args);
}

async function muxFinal(job, { concatPath, srtPath, finalPath, w, h }) {
  const opts = job.options || {};
  const burn = opts.burnCaptions && srtPath && fs.existsSync(srtPath);
  const musicPath = resolveMusic(opts.musicTrackId);
  const gain = typeof opts.musicGainDb === 'number' ? opts.musicGainDb : -22;

  // Fast path: nothing to add -> just copy.
  if (!burn && !musicPath) {
    await runFfmpeg(['-i', concatPath, '-c', 'copy', finalPath]);
    return;
  }

  const args = ['-i', concatPath];
  const filters = [];
  let vLabel = '0:v';
  let aLabel = '0:a';

  if (musicPath) {
    args.push('-stream_loop', '-1', '-i', musicPath);
    filters.push(`[1:a]volume=${gain}dB[m]`);
    filters.push(`[0:a][m]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`);
    aLabel = '[aout]';
  }

  if (burn) {
    const esc = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const style = "force_style='FontSize=22,Outline=1,Shadow=0,MarginV=28'";
    filters.push(`[0:v]subtitles='${esc}':${style}[vout]`);
    vLabel = '[vout]';
  }

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', vLabel, '-map', aLabel);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-ar', '48000', '-shortest', finalPath);

  await runFfmpeg(args);
}

function resolveMusic(trackId) {
  if (!trackId || trackId === 'none') return null;
  for (const ext of ['mp3', 'm4a', 'wav']) {
    const p = path.join(ASSETS_DIR, 'music', `${trackId}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function clipPath(clipsDir, index) {
  return path.join(clipsDir, `seg_${String(index).padStart(3, '0')}.mp4`);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const evenDim = (n) => Math.max(2, Math.round(n / 2) * 2);
