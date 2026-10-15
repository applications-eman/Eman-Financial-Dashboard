#!/usr/bin/env bash
# Builds the dashboard image with Cloud Build and deploys it to Cloud Run (min instances 0).
# Prereqs: gcloud logged in, billing enabled, and the three Secret Manager secrets created (see docs/deployment.md).
#   PROJECT_ID=my-project REGION=europe-west1 ./scripts/deploy-cloud-run.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"           # Belgium (me-central2 Dammam is not open to new projects by default)
SERVICE="${SERVICE:-eman-expenses}"
REPO="${REPO:-eman}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:$(git rev-parse --short HEAD)"

gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com --project "$PROJECT_ID"
gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION" --project "$PROJECT_ID"

gcloud builds submit --tag "$IMAGE" --project "$PROJECT_ID" .

gcloud run deploy "$SERVICE" \
  --image "$IMAGE" --project "$PROJECT_ID" --region "$REGION" \
  --platform managed --allow-unauthenticated \
  --min-instances 0 --max-instances 3 --cpu 1 --memory 512Mi --concurrency 80 \
  --port 8080 \
  --set-secrets "NEXT_PUBLIC_SUPABASE_URL=eman-supabase-url:latest,NEXT_PUBLIC_SUPABASE_ANON_KEY=eman-supabase-anon-key:latest,NEXT_PUBLIC_ADMIN_API_URL=eman-admin-api-url:latest"

gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)'
