import { log } from '../util/log.js';

// Upload a video via the Gemini File API and poll until it is ACTIVE.
// Returns the file object (with .uri and .mimeType) for use as a content part.
export async function uploadAndWait(ai, filePath, mimeType = 'video/mp4') {
  log.info({ filePath }, 'uploading to Gemini File API');
  let file = await ai.files.upload({ file: filePath, config: { mimeType } });

  const deadline = Date.now() + 10 * 60 * 1000; // 10 min cap
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('File API processing timed out');
    await sleep(2000);
    file = await ai.files.get({ name: file.name });
  }
  if (file.state === 'FAILED') {
    throw new Error('File API processing failed for uploaded video');
  }
  log.info({ name: file.name, state: file.state }, 'file ready');
  return file;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
