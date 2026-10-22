#!/usr/bin/env bash
# Connects Odoo and WhatsApp to the platform service (turns invoicing on) and starts the one-minute safety tick.
# It does NOT change the Meta webhook, does not touch Odoo data, and asks for every secret (typing is hidden).
#   PROJECT_ID=eman-expenses REGION=europe-west1 ./scripts/connect-invoicing.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-eman-platform}"
JOB="${JOB:-eman-platform-tick}"

secret_exists() { gcloud secrets describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1; }
put_secret() {
  if secret_exists "$1"; then printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project "$PROJECT_ID" >/dev/null
  else printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$PROJECT_ID" >/dev/null; fi
}
ask() { local v; read -rp "$1: " v; printf '%s' "$v"; }
ask_hidden() { local v; read -rsp "$1 (typing is hidden): " v; echo >&2; printf '%s' "$v"; }

gcloud services enable cloudscheduler.googleapis.com secretmanager.googleapis.com --project "$PROJECT_ID"

echo "== Odoo =="
put_secret eman-platform-odoo-url "$(ask 'Odoo address, e.g. https://yourcompany.odoo.com (no slash at the end)')"
put_secret eman-platform-odoo-db "$(ask 'Odoo database name (usually the first part of the address)')"
put_secret eman-platform-odoo-key "$(ask_hidden 'Odoo API key of the invoicing service user')"
SALES_JOURNAL="$(ask 'Odoo id of the SALES journal for these invoices (press Enter to use the default sales journal; use a test journal while testing)')"

echo "== WhatsApp (Meta) =="
WA_PHONE="$(ask 'WhatsApp Phone number ID (Meta > WhatsApp > API setup)')"
WA_TOKEN="$(ask_hidden 'WhatsApp access token of the system user')"
put_secret eman-platform-wa-phone-id "$WA_PHONE"
put_secret eman-platform-wa-token "$WA_TOKEN"
put_secret eman-platform-flow-id "$(ask 'Flow ID (Meta > WhatsApp > Flows, after you created the invoice Flow)')"
put_secret eman-platform-app-secret "$(ask_hidden 'Meta App secret (Meta app > Settings > Basic)')"

echo
echo "== Flow encryption key =="
echo "A WhatsApp number can have ONE Flow key. A new key replaces the old one and would break any other Flow on that number"
echo "(for example the expense capture)."
read -rp "Is this number used ONLY for invoicing (no other Flow on it)? [y/N]: " ONLY
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [ "${ONLY:-n}" = "y" ] || [ "${ONLY:-n}" = "Y" ]; then
  openssl genrsa -out "$TMP/private.pem" 2048 2>/dev/null
  openssl rsa -in "$TMP/private.pem" -pubout -out "$TMP/public.pem" 2>/dev/null
  curl -fsS -X POST "https://graph.facebook.com/v21.0/${WA_PHONE}/whatsapp_business_encryption" \
    -H "Authorization: Bearer ${WA_TOKEN}" --data-urlencode "business_public_key@${TMP}/public.pem"
  echo; echo "New key registered with Meta for this number."
  put_secret eman-platform-flow-key "$(cat "$TMP/private.pem")"
else
  read -rp "Path to the EXISTING Flow private key file of this number: " KEYFILE
  [ -f "$KEYFILE" ] || { echo "File not found: $KEYFILE"; exit 1; }
  put_secret eman-platform-flow-key "$(cat "$KEYFILE")"
fi

put_secret eman-platform-tick-secret "$(openssl rand -hex 24)"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
SECRETS="odoo-url odoo-db odoo-key wa-phone-id wa-token flow-id app-secret flow-key tick-secret"
for S in $SECRETS; do
  gcloud secrets add-iam-policy-binding "eman-platform-$S" --project "$PROJECT_ID" \
    --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" --role roles/secretmanager.secretAccessor >/dev/null
done

# CPU stays on between requests so the queue keeps working right after a salesman confirms; the instance still scales to zero when idle
gcloud run services update "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --no-cpu-throttling --min-instances 0 \
  --update-secrets "ODOO_URL=eman-platform-odoo-url:latest,ODOO_DB=eman-platform-odoo-db:latest,ODOO_API_KEY=eman-platform-odoo-key:latest,WA_PHONE_NUMBER_ID=eman-platform-wa-phone-id:latest,WA_TOKEN=eman-platform-wa-token:latest,FLOW_ID=eman-platform-flow-id:latest,META_APP_SECRET=eman-platform-app-secret:latest,FLOW_PRIVATE_KEY=eman-platform-flow-key:latest,TICK_SECRET=eman-platform-tick-secret:latest" \
  --update-env-vars "FLOW_MODE=${FLOW_MODE:-draft},ODOO_SALES_JOURNAL_ID=${SALES_JOURNAL}"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
TICK="$(gcloud secrets versions access latest --secret eman-platform-tick-secret --project "$PROJECT_ID")"
if gcloud scheduler jobs describe "$JOB" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then VERB=update; else VERB=create; fi
gcloud scheduler jobs "$VERB" http "$JOB" --location "$REGION" --project "$PROJECT_ID" \
  --schedule "* * * * *" --uri "${URL}/internal/tick" --http-method POST --headers "x-tick-secret=${TICK}" --attempt-deadline 180s >/dev/null

echo
echo "Invoicing is connected (Flow mode: ${FLOW_MODE:-draft}). Nothing in Meta's webhook was changed."
echo "Flow endpoint address for Meta:   ${URL}/invoicing/flow"
echo "Router address for the service:   ${URL}/invoicing/webhook"
