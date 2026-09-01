# AI Video Editor — casual → professional

Two modes in one app:

- **Edit an upload** — upload a 1–15 min talking / screen-recording video. The app
  uses **Gemini** to analyze the video and transcribe the speech, suggests cuts
  (filler / silence / off-topic), cleans up the script (keeping your meaning),
  replaces the voice with a **professional Gemini TTS voice** you preview and pick,
  optionally burns in captions and adds background music — then renders a
  downloadable MP4 with **FFmpeg**.
- **Generate a video** — describe a concept and get a coherent video up to 60s
  where **the same person stays visually identical and keeps the same voice** across
  every shot, using **Gemini Omni 1.1** (`gemini-omni-1.1-flash`). Invent a synthetic
  character or upload 1–3 reference photos, review/edit an AI storyboard, pick the
  voice, choose 16:9 or 9:16, captions + music.

Anyone can use it with **their own Gemini API key** — no shared quota, keys are
encrypted at rest and tied to your account.

## How it works
```
Browser (upload + wizard UI)
   │  HTTP
   ▼
Node/Express server
   ├─ Gemini: video analysis (1fps, MM:SS) → segments + cleaned script
   ├─ Gemini TTS: per-segment voiceover (drift-safe), stitched
   └─ FFmpeg: fit video to new audio (setpts) → concat → music + captions
   ▼
Downloadable professional MP4
```
The sync trick: each kept segment's **video is time-stretched to match its new
TTS audio length**, so voice, visuals, and captions line up by construction.

Users **sign in with Google (Firebase Auth)** and set **their own Gemini API key**
(stored AES-encrypted in Firestore). Designed to run on **Google Cloud Run**.

## Local development (no cloud needed)
```bash
npm install
cp .env.example .env       # keep DEV_NO_AUTH=1 and set GEMINI_API_KEY=...
npm run dev                # http://localhost:9002
```
`DEV_NO_AUTH=1` bypasses login and uses `GEMINI_API_KEY` from `.env` so you can
exercise the pipeline. Note: the upload path uses a Cloud Storage signed URL, so
full upload testing needs a real `GCS_BUCKET`; without one, use the cloud setup.
(Optional) drop music files into `assets/music/` — see that folder's README.

## Deploy to Cloud Run (full setup)
```bash
PROJECT=your-project; REGION=us-central1; BUCKET=$PROJECT-video-uploads

# 1. Project + APIs
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com firestore.googleapis.com \
  firebase.googleapis.com identitytoolkit.googleapis.com \
  iamcredentials.googleapis.com storage.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# 2. Firestore (native mode)
gcloud firestore databases create --location=$REGION

# 3. Upload bucket + CORS (allows browser PUT to signed URLs)
gsutil mb -l $REGION gs://$BUCKET
gsutil cors set cors.json gs://$BUCKET

# 4. Encryption secret for users' Gemini keys
openssl rand -base64 32 | gcloud secrets create KEY_ENC_SECRET --data-file=-

# 5. Grant the runtime service account its roles
SA=$(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/datastore.user
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
gsutil iam ch serviceAccount:$SA:roles/storage.objectAdmin gs://$BUCKET
# Needed so the SA can sign v4 URLs via ADC:
gcloud iam service-accounts add-iam-policy-binding $SA --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator
```

**Manual Firebase console steps** (can't be scripted):
1. Add Firebase to the project, then **Build → Authentication → Sign-in method →
   enable Google**.
2. **Project settings → Your apps → Web app**: register one and copy
   `apiKey`, `authDomain`, `projectId`, `appId`.
3. After deploying, add the Cloud Run URL under **Authentication → Settings →
   Authorized domains**.

Deploy (no `DEV_NO_AUTH`):
```bash
gcloud run deploy ai-video-editor --source . --region $REGION \
  --no-cpu-throttling --min-instances 1 --max-instances 1 --memory 4Gi --cpu 2 --timeout 3600 \
  --set-env-vars GCS_BUCKET=$BUCKET \
  --set-secrets KEY_ENC_SECRET=KEY_ENC_SECRET:latest
```
> ⚠️ **Do NOT pass `--allow-unauthenticated`.** Auth is Identity-Aware Proxy
> (IAP), not Firebase login. `--allow-unauthenticated` sets
> `invokerIamDisabled: true`, which takes IAP out of the request path — the app
> then never receives the `x-goog-iap-jwt-assertion` header and rejects every
> request with `Not authenticated via IAP`.

**Re-assert IAP after every deploy** (`gcloud run deploy` can reset these; there
is no `--iap` flag on older gcloud, so use the Run v2 API):
```bash
PNUM=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
# 1. Let the IAP service agent invoke the service
gcloud run services add-iam-policy-binding ai-video-editor --region=$REGION \
  --member="serviceAccount:service-$PNUM@gcp-sa-iap.iam.gserviceaccount.com" \
  --role=roles/run.invoker
# 2. Enable IAP + require invoker IAM (undo any --allow-unauthenticated)
curl -s -X PATCH -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/services/ai-video-editor?updateMask=iapEnabled,invokerIamDisabled" \
  -d '{"iapEnabled": true, "invokerIamDisabled": false}'
# 3. Authorize users on the IAP resource (roles/iap.httpsResourceAccessor) — see below
```
Authorize a user (repeat per user):
```bash
curl -s -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://iap.googleapis.com/v1/projects/$PNUM/iap_web/cloud_run-$REGION/services/ai-video-editor:setIamPolicy" \
  -d '{"policy":{"bindings":[{"role":"roles/iap.httpsResourceAccessor","members":["user:SOMEONE@example.com"]}]}}'
```
`--no-cpu-throttling --min/max-instances 1` keep one always-on instance so the
in-memory job store and background renders (which run after the HTTP response)
stay coherent. Tighten `cors.json` `origin` to the service URL for production.

## Two auth modes (one build)

The same code base runs behind either identity model — `GET /api/config` reports
which one is active and the frontend adapts (`server/middleware/auth.js`):

- **Firebase Auth (public / open to everyone).** Set the `FIREBASE_*` env vars.
  The browser shows a **"Continue with Google"** gate; anyone can sign up and
  brings their **own Gemini API key**. The client sends the Firebase ID token as
  `Authorization: Bearer <token>`; the server verifies it with the Admin SDK.
- **Identity-Aware Proxy (private / org SSO).** Leave `FIREBASE_*` unset and put
  IAP in front (steps above). The server verifies the `x-goog-iap-jwt-assertion`
  header instead. No client-side login UI.

### Deploy to a public host (open to everyone, bring-your-own-key)

To let anyone in the world use it, deploy **without IAP** and **with** the
Firebase web config so the Google sign-in gate takes over. Any host that runs a
Node container works (Render, Fly.io, a personal GCP project that permits public
Cloud Run, etc.). The service still needs GCS + Firestore + Secret Manager
credentials (via `GOOGLE_APPLICATION_CREDENTIALS` or the platform's workload
identity).

```bash
# Public Cloud Run (project must allow unauthenticated / not blocked by org policy):
gcloud run deploy ai-video-editor --source . --region $REGION \
  --allow-unauthenticated \
  --no-cpu-throttling --min-instances 1 --max-instances 1 --memory 4Gi --cpu 2 --timeout 3600 \
  --set-env-vars GCS_BUCKET=$BUCKET,FIREBASE_API_KEY=...,FIREBASE_AUTH_DOMAIN=...,FIREBASE_PROJECT_ID=...,FIREBASE_APP_ID=... \
  --set-secrets KEY_ENC_SECRET=KEY_ENC_SECRET:latest
```
Then add the deployed URL under Firebase **Authentication → Settings → Authorized
domains**. Because auth is now Firebase (not IAP), `--allow-unauthenticated` is
correct here — every request is still gated by the Firebase ID token check in the
app. (On the org project used for the private deployment, `--allow-unauthenticated`
is blocked by policy, which is why the public build goes to a different host.)

## API (all under Firebase Auth except `/api/config`, `/api/health`)
| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/api/config` | public Firebase web config for the frontend |
| GET  | `/api/me` | `{ email, hasKey }` |
| PUT  | `/api/me/key` | `{apiKey}` → validate + store encrypted |
| POST | `/api/jobs` | create edit job → `{id, uploadUrl}` (signed GCS PUT) |
| POST | `/api/jobs/:id/start` | ingest source from GCS, start analysis |
| GET  | `/api/jobs/:id` | poll status + analysis / storyboard |
| POST | `/api/jobs/:id/timeline` | save keep flags, scripts, voice, options |
| POST | `/api/jobs/:id/render` | start rendering (edit mode) |
| GET  | `/api/jobs/:id/download` | stream `final.mp4` |
| DELETE | `/api/jobs/:id` | delete job + its GCS objects |
| GET  | `/api/voices` · POST `/api/voices/preview` | voices + sample WAV |
| POST | `/api/jobs/generate` | create generate job → optional ref-photo upload URLs |
| POST | `/api/jobs/:id/storyboard/start` | plan shots (Omni storyboard) |
| POST | `/api/jobs/:id/storyboard` | save edited shots + voice + options |
| POST | `/api/jobs/:id/generate/start` | generate all shots → narrate → assemble |
| POST | `/api/jobs/:id/shots/:shotId/regenerate` | regenerate a single shot |

## Project layout
`server/` Express + pipeline stages (`probe → analyze → plan → tts → captions →
assemble`); `server/services/` Gemini, FFmpeg, Firebase, Firestore keystore, GCS;
`server/middleware/auth.js` token verification; `public/` the wizard UI;
`jobs/<id>/` per-job working files under `/tmp` (gitignored).
