import { log } from './log.js';

// Retry an async fn with exponential backoff on transient (429/5xx/network) errors.
export async function withRetry(fn, { tries = 4, baseMs = 800, label = 'op' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const status = err?.status || err?.code;
      const transient =
        /429|500|502|503|504|ECONNRESET|ETIMEDOUT|fetch failed|overloaded/i.test(msg) ||
        [429, 500, 502, 503, 504].includes(Number(status));
      if (!transient || attempt === tries - 1) throw err;
      const delay = baseMs * 2 ** attempt;
      log.warn({ label, attempt: attempt + 1, delay, msg }, 'transient error, retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
