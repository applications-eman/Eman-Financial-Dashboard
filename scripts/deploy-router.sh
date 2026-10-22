#!/usr/bin/env bash
# Deploys the WhatsApp router to Cloud Run. Safe to run any time: it does NOT change anything in Meta.
# It asks for the three secrets once (typing is hidden) and stores them in Secret Manager.
#   PROJECT_ID=eman-expenses REGION=europe-west1 ./scripts/deploy-router.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-whatsapp-router}"
REPO="${REPO:-eman}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:$(git rev-parse --short HEAD)"

gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com --project "$PROJECT_ID"
gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION" --project "$PROJECT_ID"

secret_exists() { gcloud secrets describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1; }
put_secret() { # name, value
  if secret_exists "$1"; then printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project "$PROJECT_ID" >/dev/null
  else printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$PROJECT_ID" >/dev/null; fi
}

if ! secret_exists eman-router-meta-app-secret || [ "${RESET_SECRETS:-}" = "1" ]; then
  read -rsp "Meta App Secret (Meta app > Settings > Basic > App secret): " V; echo; put_secret eman-router-meta-app-secret "$V"
fi
if ! secret_exists eman-router-verify-token || [ "${RESET_SECRETS:-}" = "1" ]; then
  read -rsp "Verify token (press Enter to generate one): " V; echo
  [ -n "$V" ] || { V="$(openssl rand -hex 24)"; echo "Generated verify token: $V   (you type this in Meta later)"; }
  put_secret eman-router-verify-token "$V"
fi
if ! secret_exists eman-router-registry || [ "${RESET_SECRETS:-}" = "1" ]; then
  echo "Paste the registry as ONE line of JSON (see docs/whatsapp-router.md), then press Enter:"
  read -rs V; echo; put_secret eman-router-registry "$V"
fi

# let the service read the secrets
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
for S in eman-router-meta-app-secret eman-router-verify-token eman-router-registry; do
  gcloud secrets add-iam-policy-binding "$S" --project "$PROJECT_ID" \
    --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" --role roles/secretmanager.secretAccessor >/dev/null
done

gcloud builds submit --tag "$IMAGE" --project "$PROJECT_ID" router/

gcloud run deploy "$SERVICE" \
  --image "$IMAGE" --project "$PROJECT_ID" --region "$REGION" \
  --platform managed --allow-unauthenticated \
  --min-instances 0 --max-instances 3 --cpu 1 --memory 256Mi --concurrency 80 --port 8080 \
  --set-secrets "META_APP_SECRET=eman-router-meta-app-secret:latest,META_VERIFY_TOKEN=eman-router-verify-token:latest,ROUTER_REGISTRY_JSON=eman-router-registry:latest"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
echo
echo "Router deployed. Webhook address for Meta (do NOT change Meta yet):  ${URL}/webhook"
echo "Health check: curl ${URL}/health"
