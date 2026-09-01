import { db } from './firebase.js';
import { jobDir } from '../jobs/jobStore.js';
import { DEV_NO_AUTH } from '../config.js';
import { log } from '../util/log.js';

// Local dev bypasses cloud entirely (no ADC / Firestore); jobs live only in the
// in-memory Map + /tmp, exactly as before this feature. This also avoids the
// multi-second Firestore init/timeout on every call when ambient ADC exists.

// Durable per-user mirror of jobs in Firestore, so run history survives instance
// restarts/redeploys (the in-memory Map + /tmp are ephemeral on Cloud Run).
//
// All calls here are best-effort: on any failure (incl. DEV_NO_AUTH, where
// firebase-admin is uninitialized and db() throws) we log and degrade to the
// memory+/tmp store instead of surfacing an error to the request.

function jobCollection(uid) {
  return db().collection('users').doc(uid).collection('jobs');
}

function keptCount(analysis) {
  return analysis?.segments?.filter((s) => s.keep).length ?? 0;
}

// Explicit allow-list so a secret (apiKey) or instance-local field (paths) can
// never leak into Firestore, even if the job object later grows new fields.
function toFirestore(job, FieldValue) {
  return {
    id: job.id,
    uid: job.uid,
    kind: job.kind ?? 'edit',
    status: job.status ?? null,
    stage: job.stage ?? null,
    progress: job.progress ?? 0,
    error: job.error ?? null,
    createdAt: job.createdAt ?? new Date().toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
    source: job.source ?? null,
    voice: job.voice ?? null,
    options: job.options ?? null,
    analysis: job.analysis ?? null,
    brief: job.brief ?? null,
    storyboard: job.storyboard ?? null,
    keptSegments: keptCount(job.analysis),
    hasFinal: Boolean(job.gcs?.final),
    gcs: job.gcs ?? { source: null, final: null },
  };
}

// Rebuild an in-memory job seed from a Firestore doc. Timestamps -> ISO strings
// so the public shape matches jobs created this session.
function fromFirestore(data) {
  if (!data) return null;
  const createdAt =
    typeof data.createdAt?.toDate === 'function'
      ? data.createdAt.toDate().toISOString()
      : data.createdAt || new Date().toISOString();
  return {
    ...data,
    createdAt,
    updatedAt: undefined,
    apiKey: null, // never persisted; re-attached from keystore on render
    paths: { dir: jobDir(data.id) },
  };
}

export async function saveJob(uid, job) {
  if (DEV_NO_AUTH || !uid) return;
  try {
    const { FieldValue } = await import('firebase-admin/firestore');
    await jobCollection(uid).doc(job.id).set(toFirestore(job, FieldValue), { merge: true });
  } catch (err) {
    log.warn({ jobId: job.id, err: err.message }, 'jobRepo.saveJob failed (mirror skipped)');
  }
}

export async function loadJob(uid, id) {
  if (DEV_NO_AUTH || !uid) return null;
  try {
    const snap = await jobCollection(uid).doc(id).get();
    return snap.exists ? fromFirestore(snap.data()) : null;
  } catch (err) {
    log.warn({ jobId: id, err: err.message }, 'jobRepo.loadJob failed');
    return null;
  }
}

// List projection for the history UI — deliberately omits `analysis` (large) and
// any secret/path fields.
export async function listJobs(uid) {
  if (DEV_NO_AUTH || !uid) return [];
  try {
    const snap = await jobCollection(uid).orderBy('createdAt', 'desc').limit(100).get();
    return snap.docs.map((d) => {
      const j = d.data();
      const createdAt =
        typeof j.createdAt?.toDate === 'function' ? j.createdAt.toDate().toISOString() : j.createdAt;
      return {
        id: j.id,
        kind: j.kind ?? 'edit',
        status: j.status ?? null,
        stage: j.stage ?? null,
        progress: j.progress ?? 0,
        error: j.error ?? null,
        createdAt,
        source: j.source ? { durationSec: j.source.durationSec, sizeBytes: j.source.sizeBytes } : null,
        voice: j.voice ?? null,
        keptSegments: j.keptSegments ?? 0,
        shotCount: j.storyboard?.shots?.length ?? 0,
        targetDurationSec: j.brief?.targetDurationSec ?? null,
        hasFinal: Boolean(j.hasFinal),
      };
    });
  } catch (err) {
    log.warn({ uid, err: err.message }, 'jobRepo.listJobs failed');
    return [];
  }
}

export async function deleteJob(uid, id) {
  if (DEV_NO_AUTH || !uid) return;
  try {
    await jobCollection(uid).doc(id).delete();
  } catch (err) {
    log.warn({ jobId: id, err: err.message }, 'jobRepo.deleteJob failed');
  }
}
