import express from 'express';
import { setKey, hasKey, clearKey } from '../services/keystore.js';
import { validateKey } from '../services/gemini.js';

const router = express.Router();

// GET /api/me -> account info + whether a Gemini key is on file (never the key).
router.get('/', async (req, res, next) => {
  try {
    res.json({ uid: req.uid, email: req.email, hasKey: await hasKey(req.uid) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/me/key { apiKey } -> validate, encrypt, store.
router.put('/key', async (req, res, next) => {
  try {
    const apiKey = (req.body?.apiKey || '').toString().trim();
    if (!apiKey) return res.status(400).json({ error: 'apiKey is required' });

    const check = await validateKey(apiKey);
    if (!check.ok) return res.status(400).json({ error: `Key rejected: ${check.error}` });

    await setKey(req.uid, apiKey);
    res.json({ hasKey: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/me/key -> remove the stored key.
router.delete('/key', async (req, res, next) => {
  try {
    await clearKey(req.uid);
    res.json({ hasKey: false });
  } catch (err) {
    next(err);
  }
});

export default router;
