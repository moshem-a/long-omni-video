import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { DEV_NO_AUTH } from '../config.js';
import { log } from '../util/log.js';

// Initialize the Admin SDK once. On Cloud Run this uses the runtime service
// account automatically; locally it uses GOOGLE_APPLICATION_CREDENTIALS.
let _auth = null;
let _db = null;

function ensureApp() {
  if (getApps().length) return;
  try {
    initializeApp({ credential: applicationDefault() });
  } catch (err) {
    if (DEV_NO_AUTH) {
      log.warn('firebase-admin not initialized (DEV_NO_AUTH); auth/Firestore disabled');
      return;
    }
    throw err;
  }
}

export function auth() {
  ensureApp();
  if (!_auth) _auth = getAuth();
  return _auth;
}

export function db() {
  ensureApp();
  if (!_db) _db = getFirestore();
  return _db;
}
