#!/usr/bin/env bash
# Deploy the AI Video Editor to Cloud Run AND re-assert IAP.
#
# Why this script exists: `gcloud run deploy` (and any stray --allow-unauthenticated)
# resets the service to invokerIamDisabled=true, which takes IAP out of the request
# path. The app then never sees the x-goog-iap-jwt-assertion header and every request
# fails with "Not authenticated via IAP" (and API keys can't save, since req.uid is
# unset). This has recurred twice. This script makes deploy + IAP idempotent:
#   deploy  ->  grant IAP invoker  ->  enable IAP + require IAM  ->  verify
#
# Usage: PROJECT=agentic-system-488914 REGION=us-central1 BUCKET=... ./scripts/deploy.sh
set -euo pipefail

PROJECT="${PROJECT:-agentic-system-488914}"
REGION="${REGION:-us-central1}"
SVC="${SVC:-ai-video-editor}"
BUCKET="${BUCKET:-${PROJECT}-video-uploads}"
PNUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
IAP_SA="service-${PNUM}@gcp-sa-iap.iam.gserviceaccount.com"

echo "==> 1/4 Deploying $SVC to Cloud Run (project=$PROJECT region=$REGION)"
# NOTE: never pass --allow-unauthenticated here (it disables IAP).
gcloud run deploy "$SVC" --source . --region "$REGION" --project "$PROJECT" \
  --no-cpu-throttling --min-instances 1 --max-instances 1 --memory 4Gi --cpu 2 --timeout 3600 \
  --set-env-vars "GCS_BUCKET=$BUCKET" \
  --set-secrets KEY_ENC_SECRET=KEY_ENC_SECRET:latest

echo "==> 2/4 Granting run.invoker to the IAP service agent ($IAP_SA)"
gcloud run services add-iam-policy-binding "$SVC" --region="$REGION" --project="$PROJECT" \
  --member="serviceAccount:${IAP_SA}" --role=roles/run.invoker >/dev/null

echo "==> 3/4 Enabling IAP + requiring invoker IAM (Run v2 REST; no --iap flag on older gcloud)"
TOKEN="$(gcloud auth print-access-token)"
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/services/$SVC?updateMask=iapEnabled,invokerIamDisabled" \
  -d '{"iapEnabled": true, "invokerIamDisabled": false}' >/dev/null
sleep 10

echo "==> 4/4 Verifying IAP is enforcing"
FLAGS="$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/services/$SVC")"
IAP_ON="$(printf '%s' "$FLAGS" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("iapEnabled"))')"
URI="$(printf '%s' "$FLAGS" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("uri"))')"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URI/api/me")"
echo "    iapEnabled=$IAP_ON ; unauthenticated GET $URI/api/me -> HTTP $CODE (want 302)"
if [ "$IAP_ON" != "True" ] || [ "$CODE" != "302" ]; then
  echo "!! IAP is NOT enforcing correctly — investigate before sharing the URL." >&2
  exit 1
fi
echo "==> Done. IAP is on. Authorize new users with roles/iap.httpsResourceAccessor (see README)."
