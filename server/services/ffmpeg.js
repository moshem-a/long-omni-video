import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { log } from '../util/log.js';

const require = createRequire(import.meta.url);

// Resolve a binary: prefer one on the system PATH, fall back to the static package.
function resolveBinary(systemName, staticResolver) {
  const probe = spawnSync(systemName, ['-version'], { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) return systemName;
  try {
    const p = staticResolver();
    if (p) return p;
  } catch {
    /* fall through */
  }
  return systemName; // last resort; will error clearly when invoked
}

let _ffmpegPath;
let _ffprobePath;

export function ffmpegPath() {
  if (!_ffmpegPath) {
    _ffmpegPath = resolveBinary('ffmpeg', () => require('ffmpeg-static'));
    log.info({ ffmpeg: _ffmpegPath }, 'resolved ffmpeg binary');
  }
  return _ffmpegPath;
}

export function ffprobePath() {
  if (!_ffprobePath) {
    _ffprobePath = resolveBinary('ffprobe', () => require('ffprobe-static').path);
    log.info({ ffprobe: _ffprobePath }, 'resolved ffprobe binary');
  }
  return _ffprobePath;
}

// Run ffmpeg with the given args. Resolves on exit 0, rejects with stderr otherwise.
export function runFfmpeg(args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath();
    log.debug({ args }, 'ffmpeg invoke');
    const proc = spawn(bin, ['-hide_banner', '-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onProgress) onProgress(s);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

// Probe a media file via ffprobe -> normalized metadata object.
export function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    const bin = ffprobePath();
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const proc = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}\n${stderr}`));
      try {
        const data = JSON.parse(stdout);
        const v = (data.streams || []).find((s) => s.codec_type === 'video');
        const a = (data.streams || []).find((s) => s.codec_type === 'audio');
        const fmt = data.format || {};
        resolve({
          durationSec: Number(fmt.duration) || (v && Number(v.duration)) || 0,
          fps: v ? evalFps(v.avg_frame_rate || v.r_frame_rate) : 0,
          width: v ? Number(v.width) : 0,
          height: v ? Number(v.height) : 0,
          hasAudio: Boolean(a),
          hasVideo: Boolean(v),
          sizeBytes: Number(fmt.size) || 0,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function evalFps(rate) {
  if (!rate || typeof rate !== 'string') return 0;
  const [num, den] = rate.split('/').map(Number);
  if (!den) return num || 0;
  return num / den;
}
