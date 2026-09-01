import { Storage } from '@google-cloud/storage';
import { GCS_BUCKET } from '../config.js';
import { log } from '../util/log.js';

// Cloud Storage helpers. The source video is uploaded by the browser straight to
// GCS via a signed URL (Cloud Run caps HTTP/1 requests at 32 MiB), then pulled
// down to the instance for FFmpeg processing.
let _storage;
function storage() {
  if (!_storage) _storage = new Storage();
  return _storage;
}

function bucket() {
  if (!GCS_BUCKET) throw new Error('GCS_BUCKET is not set');
  return storage().bucket(GCS_BUCKET);
}

// v4 signed URL for a browser PUT upload (~15 min validity).
export async function signedUploadUrl(objectPath, contentType = 'video/mp4') {
  const [url] = await bucket()
    .file(objectPath)
    .getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
    });
  return url;
}

export async function downloadToFile(objectPath, localPath) {
  log.info({ objectPath, localPath }, 'downloading source from GCS');
  await bucket().file(objectPath).download({ destination: localPath });
}

// Upload a local file to GCS (used to persist the finished render durably).
export async function uploadFile(localPath, objectPath, contentType = 'video/mp4') {
  log.info({ objectPath, localPath }, 'uploading to GCS');
  await bucket().upload(localPath, { destination: objectPath, metadata: { contentType } });
}

// v4 signed URL for a browser GET (used to serve final videos from history
// without streaming through the instance).
export async function signedReadUrl(objectPath, ttlMs = 15 * 60 * 1000) {
  const [url] = await bucket()
    .file(objectPath)
    .getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + ttlMs });
  return url;
}

export async function deleteObject(objectPath) {
  try {
    await bucket().file(objectPath).delete({ ignoreNotFound: true });
  } catch (err) {
    log.warn({ objectPath, err: err.message }, 'failed to delete GCS object');
  }
}
