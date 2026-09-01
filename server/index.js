import express from 'express';
import { PORT, PUBLIC_DIR, GCS_BUCKET, DEV_NO_AUTH, FIREBASE_WEB_CONFIG } from './config.js';
import { log } from './util/log.js';
import { requireAuth } from './middleware/auth.js';
import jobsRouter from './routes/jobs.js';
import voicesRouter from './routes/voices.js';
import meRouter from './routes/me.js';

const app = express();

app.use(express.json({ limit: '4mb' }));

// Public endpoints (no auth).
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Public Firebase web config for the browser sign-in. Empty on IAP/dev
// deployments (the frontend then falls back to IAP/no client login). These
// values are public by design (Firebase web apps ship them in client code).
app.get('/api/config', (_req, res) => {
  res.json({ firebase: FIREBASE_WEB_CONFIG, authMode: FIREBASE_WEB_CONFIG.apiKey ? 'firebase' : 'iap' });
});

// Authenticated API
app.use('/api/me', requireAuth, meRouter);
app.use('/api/jobs', requireAuth, jobsRouter);
app.use('/api/voices', requireAuth, voicesRouter);

// Static frontend
app.use(express.static(PUBLIC_DIR));

// Centralized error handler
app.use((err, _req, res, _next) => {
  log.error({ err: err.message }, 'request error');
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  log.info(`AI Video Editor running on http://0.0.0.0:${PORT}`);
  if (DEV_NO_AUTH) log.warn('DEV_NO_AUTH=1 — authentication is bypassed (local dev only)');
  if (!GCS_BUCKET) log.warn('GCS_BUCKET not set — uploads will fail until configured');
});
