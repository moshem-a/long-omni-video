// Time helpers shared across stages.

// "MM:SS" or "HH:MM:SS" -> seconds (number). Returns null on bad input.
export function timecodeToSeconds(tc) {
  if (typeof tc === 'number') return tc;
  if (typeof tc !== 'string') return null;
  const parts = tc.trim().split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

// seconds -> "HH:MM:SS,mmm" for SRT cues.
export function secondsToSrt(totalSec) {
  const ms = Math.max(0, Math.round(totalSec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}
