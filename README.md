# Long Omni Video — generate 60s videos with a consistent person, using Gemini Omni 1.1

**🚀 Live demo:** **[ai-video-editor-880601596687.us-central1.run.app](https://ai-video-editor-880601596687.us-central1.run.app/)** — bring your own Gemini key, no sign-up.

Gemini **Omni 1.1** produces short clips per call. This app chains many shots — reusing
**your uploaded photos** (or an invented character) as a subject reference on every shot —
to build a **coherent video up to 60 seconds** where the same person appears in every shot
with one consistent voice. It also does classic **upload-and-polish** editing. No login: your
API key stays in your browser.

📖 **Read the write-up:** [`docs/medium-article.md`](docs/medium-article.md) · 🗺️ **Architecture:** [`docs/architecture.svg`](docs/architecture.svg)

![System architecture](docs/architecture.svg)

---

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

**No login, no accounts.** Anyone can use it with **their own Gemini API key** — the
key is kept in your browser (localStorage on your device), sent with each request,
and **never stored on the server** (it lives in memory only for the life of a job).
Remove it any time. No shared quota, no sign-up.

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

There is **no authentication**: each user brings their **own Gemini API key**, held
in their browser and sent as an `x-gemini-key` header per request (a random
`x-client-id` scopes each browser's history). Designed to run on **Google Cloud
Run**, but it's a plain Node container that runs anywhere.

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
  iamcredentials.googleapis.com storage.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com

# 2. Firestore (native mode) — stores per-browser job history only (never keys)
gcloud firestore databases create --location=$REGION

# 3. Upload bucket + CORS (allows browser PUT to signed URLs)
gsutil mb -l $REGION gs://$BUCKET
gsutil cors set cors.json gs://$BUCKET

# 4. Grant the runtime service account its roles
SA=$(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/datastore.user
gsutil iam ch serviceAccount:$SA:roles/storage.objectAdmin gs://$BUCKET
# Needed so the SA can sign v4 URLs via ADC:
gcloud iam service-accounts add-iam-policy-binding $SA --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator
```
No Firebase, no Secret Manager, no encryption key: the app stores nothing per user
(keys stay in each browser). Firestore only holds per-browser job history.

Deploy (public — open to anyone with a Gemini key):
```bash
gcloud run deploy ai-video-editor --source . --region $REGION \
  --allow-unauthenticated \
  --no-cpu-throttling --min-instances 1 --max-instances 1 --memory 4Gi --cpu 2 --timeout 3600 \
  --set-env-vars GCS_BUCKET=$BUCKET
```
`--allow-unauthenticated` is correct here — there is no server-side auth to bypass;
the service is meant to be public and every request simply carries the caller's own
Gemini key. `--no-cpu-throttling --min/max-instances 1` keep one always-on instance
so the in-memory job store and background renders (which run after the HTTP
response) stay coherent. Tighten `cors.json` `origin` to the service URL for
production.

> **Org-policy note.** If your project inherits `constraints/iam.allowedPolicyMemberDomains`,
> `--allow-unauthenticated` (which grants `allUsers`) is **blocked**, so the service
> can't be made public there. Deploy to a project/host without that constraint —
> a personal GCP project, Render, Fly.io, etc. It's a plain Node container, so any
> host works; it just needs GCS + Firestore credentials via
> `GOOGLE_APPLICATION_CREDENTIALS` or the platform's workload identity.

## No accounts — bring your own key

There is no login. The browser keeps the user's Gemini key in `localStorage` and
sends it as an `x-gemini-key` header on every request; the server
(`server/middleware/auth.js`) puts it on `req.apiKey` **in memory only** and never
persists it. A random `x-client-id` header scopes each browser's job history. To
use the app a visitor pastes a key from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) and can remove it
at any time.

## API (no auth; each request carries `x-gemini-key` + `x-client-id`)
| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/api/health` | liveness check |
| GET  | `/api/me` | `{ hasKey }` — whether this request carried a key |
| PUT  | `/api/me/key` | `{apiKey}` → validate against Gemini (not stored) |
| DELETE | `/api/me/key` | no-op server-side (browser clears its own copy) |
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
assemble`, plus `storyboard`/`generate` for Omni mode); `server/services/` Gemini,
Omni, FFmpeg, Firestore job history, GCS; `server/middleware/auth.js` attaches the
per-request key/client-id; `public/` the wizard UI; `jobs/<id>/` per-job working
files under `/tmp` (gitignored).
