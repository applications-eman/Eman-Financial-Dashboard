#!/usr/bin/env bash
# Deploys the platform service (admin API) to Cloud Run. Does not touch Meta, Odoo or the old systems.
#   PROJECT_ID=eman-expenses REGION=europe-west1 ./scripts/deploy-platform.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-eman-platform}"
REPO="${REPO:-eman}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:$(git rev-parse --short HEAD)"

gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com --project "$PROJECT_ID"
gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION" --project "$PROJECT_ID"

secret_exists() { gcloud secrets describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1; }
put_secret() {
  if secret_exists "$1"; then printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project "$PROJECT_ID" >/dev/null
  else printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$PROJECT_ID" >/dev/null; fi
}

if ! secret_exists eman-platform-database-url || [ "${RESET_SECRETS:-}" = "1" ]; then
  read -rsp "Platform database connection string (Supabase > Connect > Transaction pooler; typing is hidden): " V; echo; put_secret eman-platform-database-url "$V"
fi
if ! secret_exists eman-platform-auth-url || [ "${RESET_SECRETS:-}" = "1" ]; then
  read -rp "Dashboard sign-in project URL (the Supabase URL your dashboard login uses, https://xxxx.supabase.co): " V; put_secret eman-platform-auth-url "$V"
fi
if ! secret_exists eman-platform-allowed-origins || [ "${RESET_SECRETS:-}" = "1" ]; then
  read -rp "Dashboard address(es), comma separated (https://your-dashboard.example.com): " V; put_secret eman-platform-allowed-origins "$V"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
for S in eman-platform-database-url eman-platform-auth-url eman-platform-allowed-origins; do
  gcloud secrets add-iam-policy-binding "$S" --project "$PROJECT_ID" \
    --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" --role roles/secretmanager.secretAccessor >/dev/null
done

gcloud builds submit --tag "$IMAGE" --project "$PROJECT_ID" platform/

gcloud run deploy "$SERVICE" \
  --image "$IMAGE" --project "$PROJECT_ID" --region "$REGION" \
  --platform managed --allow-unauthenticated \
  --min-instances 0 --max-instances 2 --cpu 1 --memory 256Mi --concurrency 40 --port 8080 \
  --set-secrets "DATABASE_URL=eman-platform-database-url:latest,AUTH_SUPABASE_URL=eman-platform-auth-url:latest,ALLOWED_ORIGINS=eman-platform-allowed-origins:latest"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
echo "Platform service deployed: ${URL}   (health: ${URL}/health). Every /admin call needs a dashboard sign-in."
