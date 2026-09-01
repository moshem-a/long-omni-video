import { OAuth2Client } from 'google-auth-library';
import { DEV_NO_AUTH } from '../config.js';
import { auth as firebaseAuth } from '../services/firebase.js';
import { log } from '../util/log.js';

// Identity is resolved in two ways so the same build runs in two deployments:
//
//   1. Public host  -> the browser signs in with Firebase Authentication (open
//      sign-up, any Google account) and sends the ID token as
//      `Authorization: Bearer <idToken>`. We verify it with the Admin SDK.
//   2. Org SSO host -> Identity-Aware Proxy sits in front and signs a JWT into
//      `x-goog-iap-jwt-assertion`; we verify that against Google's IAP keys.
//
// Whichever is present wins; the per-user keystore/history is keyed by req.uid
// either way (Firebase uid or IAP subject).
const oAuthClient = new OAuth2Client();
let _iapKeys = null;
async function iapKeys() {
  if (!_iapKeys) _iapKeys = (await oAuthClient.getIapPublicKeys()).pubkeys;
  return _iapKeys;
}

// Optional hardening for the IAP path: pin the expected audience (the IAP
// resource path). If unset we still verify issuer+signature.
const IAP_AUDIENCE = process.env.IAP_JWT_AUDIENCE || null;

export async function requireAuth(req, res, next) {
  // Local development bypass.
  if (DEV_NO_AUTH) {
    req.uid = 'dev-user';
    req.email = 'dev@localhost';
    return next();
  }

  // 1) App-level identity: a Firebase ID token (public, bring-your-own-key).
  const authz = req.headers.authorization || '';
  if (authz.startsWith('Bearer ')) {
    const idToken = authz.slice(7).trim();
    try {
      const decoded = await firebaseAuth().verifyIdToken(idToken);
      req.uid = decoded.uid;
      req.email = decoded.email || null;
      return next();
    } catch (err) {
      log.warn({ err: err.message }, 'Firebase ID token verification failed');
      return res.status(401).json({ error: 'Sign-in required' });
    }
  }

  // 2) Fallback: an IAP assertion (org single sign-on deployments).
  const assertion = req.headers['x-goog-iap-jwt-assertion'];
  if (assertion) {
    try {
      const ticket = await oAuthClient.verifySignedJwtWithCertsAsync(
        assertion,
        await iapKeys(),
        IAP_AUDIENCE,
        ['https://cloud.google.com/iap']
      );
      const payload = ticket.getPayload();
      req.uid = payload.sub; // stable IAP subject id
      req.email = payload.email || null;
      return next();
    } catch (err) {
      log.warn({ err: err.message }, 'IAP JWT verification failed');
      return res.status(401).json({ error: 'IAP authentication failed' });
    }
  }

  return res.status(401).json({ error: 'Sign-in required' });
}
