import express from 'express';
import { validateKey } from '../services/gemini.js';

const router = express.Router();

// GET /api/me -> whether this request carries a usable Gemini key. The key lives
// only in the caller's browser; the server stores nothing.
router.get('/', (req, res) => {
  res.json({ hasKey: Boolean(req.apiKey) });
});

// PUT /api/me/key { apiKey } -> validate the key against Gemini and report back.
// We do NOT store it; the browser keeps it in localStorage and sends it per
// request. This endpoint only confirms the key works before the app unlocks.
router.put('/key', async (req, res, next) => {
  try {
    const apiKey = (req.body?.apiKey || '').toString().trim();
    if (!apiKey) return res.status(400).json({ error: 'apiKey is required' });

    const check = await validateKey(apiKey);
    if (!check.ok) return res.status(400).json({ error: `Key rejected: ${check.error}` });

    res.json({ hasKey: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/me/key -> nothing to delete server-side; the browser clears its own
// copy. Kept for API symmetry.
router.delete('/key', (_req, res) => {
  res.json({ hasKey: false });
});

export default router;
