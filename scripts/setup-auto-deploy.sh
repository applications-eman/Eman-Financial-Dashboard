#!/usr/bin/env bash
# One-time setup: every push to the working branch is tested and, if the tests pass, deployed (platform + Flow) by Google Cloud Build.
#   PROJECT_ID=eman-expenses ./scripts/setup-auto-deploy.sh
# Before running: in the Google Cloud console open Cloud Build > Triggers > "Connect repository", choose GitHub, sign in and pick the
# repository applications-eman/Eman-Financial-Dashboard (one-time, about 2 minutes). The script checks for it and tells you if it is missing.
set -euo pipefail
: "${PROJECT_ID:?set PROJECT_ID}"
BRANCH="${BRANCH:-claude/optimistic-wozniak-2rs8m5}"
OWNER="${OWNER:-applications-eman}"
REPO_NAME="${REPO_NAME:-Eman-Financial-Dashboard}"

gcloud services enable cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project "$PROJECT_ID" \
  || echo "(could not re-check the Google services right now; continuing)"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
# the account that runs the build may deploy, read the saved secrets, and start the image build
for ROLE in roles/run.admin roles/iam.serviceAccountUser roles/secretmanager.secretAccessor roles/artifactregistry.writer roles/cloudbuild.builds.editor roles/storage.admin roles/logging.logWriter; do
  for SA in "$BUILD_SA" "$COMPUTE_SA"; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:${SA}" --role "$ROLE" --condition=None >/dev/null 2>&1 || true
  done
done

if gcloud builds triggers describe eman-platform-auto-deploy --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "The automatic deploy already exists."
else
  gcloud builds triggers create github \
    --name eman-platform-auto-deploy --project "$PROJECT_ID" \
    --repo-owner "$OWNER" --repo-name "$REPO_NAME" \
    --branch-pattern "^${BRANCH}\$" \
    --build-config cloudbuild.platform.yaml \
    --included-files "platform/**,router/**,scripts/deploy-platform.sh,scripts/update-flow.sh,docs/whatsapp-invoicing/flow-live.json,cloudbuild.platform.yaml" \
    || { echo; echo "Could not create it. Most likely the GitHub repository is not connected yet: Cloud Build > Triggers > Connect repository (GitHub), then run this again."; exit 1; }
fi
echo "Done. From now on a push to ${BRANCH} is tested and deployed automatically. Watch it in Cloud Build > History."
