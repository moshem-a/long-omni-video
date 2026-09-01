import crypto from 'node:crypto';
import { KEY_ENC_SECRET, DEV_NO_AUTH } from '../config.js';
import { db } from './firebase.js';

// Local-dev fallback: when auth is bypassed, use GEMINI_API_KEY from env instead
// of Firestore so the pipeline can be exercised without cloud resources.
const DEV_KEY = DEV_NO_AUTH ? (process.env.GEMINI_API_KEY || '') : '';

// Per-user Gemini API keys, AES-256-GCM encrypted at rest in Firestore.
// Stored format: base64(iv).base64(authTag).base64(ciphertext)

function secretKey() {
  if (!KEY_ENC_SECRET) {
    throw new Error('KEY_ENC_SECRET is not set (need a base64-encoded 32-byte key)');
  }
  const buf = Buffer.from(KEY_ENC_SECRET, 'base64');
  if (buf.length !== 32) {
    throw new Error('KEY_ENC_SECRET must decode to exactly 32 bytes (use: openssl rand -base64 32)');
  }
  return buf;
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(blob) {
  const [ivB64, tagB64, ctB64] = String(blob).split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted key');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

function userDoc(uid) {
  return db().collection('users').doc(uid);
}

export async function setKey(uid, plain) {
  await userDoc(uid).set({ geminiKeyEnc: encrypt(plain) }, { merge: true });
}

export async function getKey(uid) {
  if (DEV_KEY) return DEV_KEY;
  const snap = await userDoc(uid).get();
  const enc = snap.exists ? snap.get('geminiKeyEnc') : null;
  return enc ? decrypt(enc) : null;
}

export async function hasKey(uid) {
  if (DEV_KEY) return true;
  const snap = await userDoc(uid).get();
  return Boolean(snap.exists && snap.get('geminiKeyEnc'));
}

export async function clearKey(uid) {
  const { FieldValue } = await import('firebase-admin/firestore');
  await userDoc(uid).set({ geminiKeyEnc: FieldValue.delete() }, { merge: true });
}
