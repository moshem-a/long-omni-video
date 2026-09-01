import express from 'express';
import { PORT, PUBLIC_DIR, GCS_BUCKET, DEV_NO_AUTH } from './config.js';
import { log } from './util/log.js';
import { attachIdentity } from './middleware/auth.js';
import jobsRouter from './routes/jobs.js';
import voicesRouter from './routes/voices.js';
import meRouter from './routes/me.js';

const app = express();

app.use(express.json({ limit: '4mb' }));

// Public endpoints (no auth).
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// API — no login; each request carries the user's own key (x-gemini-key) and a
// per-browser id (x-client-id). attachIdentity puts these on req.
app.use('/api/me', attachIdentity, meRouter);
app.use('/api/jobs', attachIdentity, jobsRouter);
app.use('/api/voices', attachIdentity, voicesRouter);

// Static frontend
app.use(express.static(PUBLIC_DIR));

// Centralized error handler
app.use((err, _req, res, _next) => {
  log.error({ err: err.message }, 'request error');
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  log.info(`AI Video Editor running on http://0.0.0.0:${PORT}`);
  if (DEV_NO_AUTH) log.warn('DEV_NO_AUTH=1 — using GEMINI_API_KEY from env as fallback key (local dev only)');
  if (!GCS_BUCKET) log.warn('GCS_BUCKET not set — uploads will fail until configured');
});
