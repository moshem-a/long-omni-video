#!/usr/bin/env bash
# Deploy the AI Video Editor to Cloud Run as a PUBLIC service.
#
# There is no login: every request carries the caller's own Gemini key
# (x-gemini-key), held in memory only. So the service is meant to be public and
# --allow-unauthenticated is correct — there is no server-side auth to bypass.
#
#   deploy (public)  ->  verify the service answers unauthenticated
#
# Usage: PROJECT=your-project REGION=us-central1 BUCKET=... ./scripts/deploy.sh
#
# NOTE: if your project inherits constraints/iam.allowedPolicyMemberDomains,
# --allow-unauthenticated (which grants allUsers) is blocked by org policy and the
# deploy will fail. Deploy to a project/host without that constraint.
set -euo pipefail

PROJECT="${PROJECT:-agentic-system-488914}"
REGION="${REGION:-us-central1}"
SVC="${SVC:-ai-video-editor}"
BUCKET="${BUCKET:-${PROJECT}-video-uploads}"

echo "==> 1/2 Deploying $SVC to Cloud Run — PUBLIC (project=$PROJECT region=$REGION)"
gcloud run deploy "$SVC" --source . --region "$REGION" --project "$PROJECT" \
  --allow-unauthenticated \
  --no-cpu-throttling --min-instances 1 --max-instances 1 --memory 4Gi --cpu 2 --timeout 3600 \
  --set-env-vars "GCS_BUCKET=$BUCKET"

echo "==> 2/2 Verifying the service is publicly reachable"
URI="$(gcloud run services describe "$SVC" --region "$REGION" --project "$PROJECT" \
  --format='value(status.url)')"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URI/api/health")"
echo "    GET $URI/api/health -> HTTP $CODE (want 200)"
if [ "$CODE" != "200" ]; then
  echo "!! Service is not publicly reachable (HTTP $CODE). If this is an org project," >&2
  echo "   allUsers may be blocked by iam.allowedPolicyMemberDomains — deploy elsewhere." >&2
  exit 1
fi
echo "==> Done. Public at $URI — anyone can use it with their own Gemini API key."
