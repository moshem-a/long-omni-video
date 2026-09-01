import { DEV_NO_AUTH } from '../config.js';

// No accounts, no login. The browser holds the user's own Gemini API key in
// localStorage and sends it on every request as `x-gemini-key`; we keep it on
// `req.apiKey` in memory only (never persisted). A random per-browser id in
// `x-client-id` scopes that browser's job history (`req.uid`). This makes the app
// open to anyone with a Gemini key and removes all auth infrastructure.
//
// Local dev: with DEV_NO_AUTH=1 and GEMINI_API_KEY set, requests without a header
// key fall back to that env key so the pipeline can be exercised from curl/tests.
export function attachIdentity(req, _res, next) {
  const headerKey = (req.headers['x-gemini-key'] || '').toString().trim();
  req.apiKey = headerKey || (DEV_NO_AUTH ? process.env.GEMINI_API_KEY || null : null);
  req.uid = (req.headers['x-client-id'] || '').toString().trim() || 'anon';
  req.email = null;
  next();
}
