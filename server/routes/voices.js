import express from 'express';
import { VOICES } from '../config.js';
import { synthesizeSpeech } from '../services/gemini.js';
import { wrapWavHeader } from '../util/pcm.js';
import { withRetry } from '../util/retry.js';

const router = express.Router();

const SAMPLE_TEXT =
  'Here is how this voice will sound in your finished, professional video.';

// GET /api/voices -> the prebuilt voice catalog
router.get('/', (_req, res) => {
  res.json({ voices: VOICES, default: 'Kore' });
});

// POST /api/voices/preview { voice, text? } -> WAV audio of a short sample
router.post('/preview', async (req, res, next) => {
  try {
    const voice = (req.body?.voice || 'Kore').toString();
    if (!VOICES.some((v) => v.name === voice)) {
      return res.status(400).json({ error: `Unknown voice: ${voice}` });
    }
    const text = (req.body?.text || SAMPLE_TEXT).toString().slice(0, 300);
    const apiKey = req.apiKey;
    if (!apiKey) return res.status(400).json({ error: 'Set your Gemini API key first' });
    const pcm = await withRetry(() => synthesizeSpeech(apiKey, text, voice), { label: 'preview' });
    const wav = wrapWavHeader(pcm);
    res.setHeader('Content-Type', 'audio/wav');
    res.send(wav);
  } catch (err) {
    next(err);
  }
});

export default router;
