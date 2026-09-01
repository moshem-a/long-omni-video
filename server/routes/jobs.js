import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  createJob, getJob, resolveJob, updateJob, publicJob, listJobs, removeJob,
  jobDir, sourceObject, finalObject, refsObject,
} from '../jobs/jobStore.js';
import { runAnalyze, enqueueRender, runStoryboard, enqueueGenerate } from '../jobs/pipeline.js';
import { DEFAULT_VOICE, DEFAULT_ASPECT, MAX_GENERATE_DURATION_SEC, SHOT_MIN_SEC } from '../config.js';
import { hasKey, getKey } from '../services/keystore.js';
import {
  signedUploadUrl, signedReadUrl, downloadToFile, deleteObject,
} from '../services/storage.js';
import * as jobRepo from '../services/jobRepo.js';

const router = express.Router();

// Look up a job (memory -> /tmp -> Firestore) and enforce that it belongs to the
// caller. Async because the durable fallback reads Firestore; a lookup error
// degrades to the local store rather than 500-ing a history read.
async function ownedJob(req, res) {
  let job;
  try {
    job = await resolveJob(req.uid, req.params.id);
  } catch {
    job = getJob(req.params.id);
  }
  if (!job || job.uid !== req.uid) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  return job;
}

// GET /api/jobs -> list the caller's runs (durable history), newest first.
router.get('/', async (req, res, next) => {
  try {
    res.json({ jobs: await listJobs(req.uid) });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs -> create job + return a signed upload URL for the source video.
router.post('/', async (req, res, next) => {
  try {
    if (!(await hasKey(req.uid))) {
      return res.status(400).json({ error: 'Set your Gemini API key before uploading' });
    }
    const job = createJob({ uid: req.uid, status: 'awaiting-upload' });
    const objectPath = sourceObject(job.id);
    const uploadUrl = await signedUploadUrl(objectPath, 'video/mp4');
    res.status(201).json({ id: job.id, uploadUrl, objectPath, contentType: 'video/mp4' });
  } catch (err) {
    next(err);
  }
});

// ---- Generate mode (Omni long video) ----------------------------------------

// POST /api/jobs/generate -> create a generate job from a brief. For uploaded
// characters, returns signed URLs to PUT the reference photos to GCS.
router.post('/generate', async (req, res, next) => {
  try {
    if (!(await hasKey(req.uid))) {
      return res.status(400).json({ error: 'Set your Gemini API key before generating' });
    }
    const b = req.body?.brief || {};
    const concept = String(b.concept || '').trim();
    if (!concept) return res.status(400).json({ error: 'Describe the video you want to generate' });

    const aspectRatio = b.aspectRatio === '9:16' ? '9:16' : DEFAULT_ASPECT;
    const characterMode = b.characterMode === 'upload' ? 'upload' : 'synthetic';
    const targetDurationSec = Math.min(
      MAX_GENERATE_DURATION_SEC,
      Math.max(SHOT_MIN_SEC, Number(b.targetDurationSec) || 30)
    );

    const brief = {
      concept,
      targetDurationSec,
      aspectRatio,
      characterMode,
      characterDesc: String(b.characterDesc || '').trim(),
      characterRefs: [],
    };

    // Uploaded character: pre-mint object paths + signed upload URLs (max 3).
    let refUploads = [];
    if (characterMode === 'upload') {
      const photos = Array.isArray(req.body?.photos) ? req.body.photos.slice(0, 3) : [];
      if (!photos.length) return res.status(400).json({ error: 'Add at least one reference photo' });
      const job = createJob({
        uid: req.uid, kind: 'generate', status: 'briefing', brief,
        voice: b.voice || DEFAULT_VOICE, options: b.options || {},
      });
      refUploads = await Promise.all(photos.map(async (p, i) => {
        const object = refsObject(job.id, i);
        const contentType = String(p.contentType || 'image/jpeg');
        const url = await signedUploadUrl(object, contentType);
        return { url, object, contentType };
      }));
      brief.characterRefs = refUploads.map((r) => r.object);
      updateJob(job.id, { brief });
      return res.status(201).json({ id: job.id, refUploads });
    }

    const job = createJob({
      uid: req.uid, kind: 'generate', status: 'briefing', brief,
      voice: b.voice || DEFAULT_VOICE, options: b.options || {},
    });
    res.status(201).json({ id: job.id, refUploads });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/storyboard/start -> plan the shots (background).
router.post('/:id/storyboard/start', async (req, res, next) => {
  try {
    const job = await ownedJob(req, res);
    if (!job) return;
    if (job.kind !== 'generate' || !job.brief) {
      return res.status(400).json({ error: 'Not a generate job' });
    }
    const apiKey = await getKey(req.uid);
    if (!apiKey) return res.status(400).json({ error: 'Set your Gemini API key first' });
    updateJob(job.id, { apiKey });
    runStoryboard(getJob(job.id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/storyboard -> save edited shots + voice + options.
router.post('/:id/storyboard', async (req, res, next) => {
  try {
    const job = await ownedJob(req, res);
    if (!job) return;
    const { shots, voice, options } = req.body || {};

    if (Array.isArray(shots) && job.storyboard?.shots) {
      const byId = new Map(job.storyboard.shots.map((s) => [s.id, s]));
      for (const edit of shots) {
        const s = byId.get(edit.id);
        if (!s) continue;
        // Editing the visual prompt invalidates any cached clip -> force regen.
        if (typeof edit.prompt === 'string' && edit.prompt !== s.prompt) {
          s.prompt = edit.prompt;
          s.videoObject = null;
          s.omniInteractionId = null;
          s.status = 'pending';
        }
        if (typeof edit.narration === 'string') s.narration = edit.narration;
        if (typeof edit.durationSec === 'number') s.durationSec = edit.durationSec;
      }
      updateJob(job.id, { storyboard: job.storyboard });
    }
    updateJob(job.id, {
      voice: voice || job.voice || DEFAULT_VOICE,
      options: { ...(job.options || {}), ...(options || {}) },
    });
    res.json(publicJob(getJob(job.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/generate/start -> generate shots + assemble (background).
router.post('/:id/generate/start', async (req, res, next) => {
  try {
    const job = await ownedJob(req, res);
    if (!job) return;
    if (!job.storyboard?.shots?.length) {
      return res.status(400).json({ error: 'No storyboard to generate yet' });
    }
    const apiKey = job.apiKey || (await getKey(req.uid));
    if (!apiKey) return res.status(400).json({ error: 'Set your Gemini API key first' });
    updateJob(job.id, {
      apiKey,
      voice: job.voice || DEFAULT_VOICE,
      status: 'generating',
      error: null,
      progress: 0.1,
    });
    enqueueGenerate(getJob(job.id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/shots/:shotId/regenerate -> drop a shot's cached clip so the
// next generate re-creates just that shot.
router.post('/:id/shots/:shotId/regenerate', async (req, res, next) => {
  try {
    const job = await ownedJob(req, res);
    if (!job) return;
    const shot = job.storyboard?.shots?.find((s) => s.id === req.params.shotId);
    if (!shot) return res.status(404).json({ error: 'Shot not found' });
    shot.videoObject = null;
    shot.omniInteractionId = null;
    shot.status = 'pending';
    updateJob(job.id, { storyboard: job.storyboard });
    res.json(publicJob(getJob(job.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/start -> source is in GCS; pull it down and begin analysis.
router.post('/:id/start', async (req, res, next) => {
  try {
    const job = await ownedJob(req, res);
    if (!job) return;

    const apiKey = await getKey(req.uid);
    if (!apiKey) return res.status(400).json({ error: 'Set your Gemini API key first' });

    const localSource = path.join(jobDir(job.id), 'source.mp4');
    const objectPath = sourceObject(job.id);
    await downloadToFile(objectPath, localSource);
    // Source is RETAINED in GCS so old runs can be re-rendered later.

    updateJob(job.id, {
      apiKey, // in-memory only
      status: 'uploaded',
      paths: { ...job.paths, source: localSource },
      source: { ...job.source, sizeBytes: fs.statSync(localSource).size },
    });
    runAnalyze(getJob(job.id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id -> status + analysis for polling / reopening
router.get('/:id', async (req, res, next) => {
  try {
    const job = await ownedJob(req, res);
    if (!job) return;
    res.json(publicJob(job));
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/timeline -> save user edits (keep flags, scripts, voice, options)
router.post('/:id/timeline', async (req, res, next) => {
  try {
    const job = await ownedJob(req, res);
    if (!job) return;
    const { segments, voice, options } = req.body || {};

    if (Array.isArray(segments) && job.analysis) {
      const byId = new Map(job.analysis.segments.map((s) => [s.id, s]));
      for (const edit of segments) {
        const s = byId.get(edit.id);
        if (!s) continue;
        if (typeof edit.keep === 'boolean') s.keep = edit.keep;
        if (typeof edit.cleanedScript === 'string') s.cleanedScript = edit.cleanedScript;
      }
      updateJob(job.id, { analysis: job.analysis });
    }
    updateJob(job.id, {
      voice: voice || job.voice || DEFAULT_VOICE,
      options: { ...(job.options || {}), ...(options || {}) },
    });
    res.json(publicJob(getJob(job.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/render -> start rendering (re-downloads source if reopened)
router.post('/:id/render', async (req, res, next) => {
  try {
    const job = await ownedJob(req, res);
    if (!job) return;
    if (!job.analysis) return res.status(400).json({ error: 'Job not analyzed yet' });

    // The render runs in the background, possibly after the request returns, so
    // re-attach the key in memory in case the job was rehydrated from disk.
    const apiKey = job.apiKey || (await getKey(req.uid));
    if (!apiKey) return res.status(400).json({ error: 'Set your Gemini API key first' });

    // Reopened run: the local /tmp copy is gone — pull the source back from GCS.
    const localSource = path.join(jobDir(job.id), 'source.mp4');
    if (!fs.existsSync(localSource)) {
      await downloadToFile(job.gcs?.source || sourceObject(job.id), localSource);
    }

    updateJob(job.id, {
      apiKey,
      voice: job.voice || DEFAULT_VOICE,
      status: 'planning',
      error: null,
      progress: 0.38,
      paths: { ...job.paths, source: localSource },
    });
    enqueueRender(getJob(job.id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/download -> stream final.mp4 (local first, else GCS)
router.get('/:id/download', async (req, res, next) => {
  try {
    const job = await ownedJob(req, res);
    if (!job) return;
    const finalPath = job.paths?.final || path.join(jobDir(job.id), 'final.mp4');
    if (fs.existsSync(finalPath)) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `inline; filename="professional-${job.id}.mp4"`);
      fs.createReadStream(finalPath).pipe(res);
      return;
    }
    if (job.gcs?.final) {
      return res.redirect(302, await signedReadUrl(job.gcs.final));
    }
    return res.status(404).json({ error: 'Final video not ready' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/jobs/:id -> remove the run (Firestore doc + GCS media + local).
router.delete('/:id', async (req, res, next) => {
  try {
    const job = await ownedJob(req, res);
    if (!job) return;
    const media = [
      job.gcs?.source || sourceObject(job.id),
      job.gcs?.final || finalObject(job.id),
      ...(job.brief?.characterRefs || []),
      ...((job.storyboard?.shots || []).map((s) => s.videoObject).filter(Boolean)),
    ];
    await Promise.allSettled([
      ...media.map((obj) => deleteObject(obj)),
      jobRepo.deleteJob(req.uid, job.id),
    ]);
    removeJob(job.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
