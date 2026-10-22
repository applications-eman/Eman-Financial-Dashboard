#!/usr/bin/env bash
# Connects Odoo and WhatsApp to the platform service (turns invoicing on), creates the invoice Flow in Meta as a DRAFT
# with its endpoint, and starts the one-minute safety tick.
# It does NOT change the Meta webhook, does not touch Odoo data, and asks for every secret (typing is hidden).
#   PROJECT_ID=eman-expenses REGION=europe-west1 ./scripts/connect-invoicing.sh
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-eman-platform}"
JOB="${JOB:-eman-platform-tick}"
GRAPH="https://graph.facebook.com/${GRAPH_VERSION:-v21.0}"
FLOW_FILE="docs/whatsapp-invoicing/flow-live.json"
[ -f "$FLOW_FILE" ] || { echo "Run this from the repository folder (cd ~/Eman-Financial-Dashboard)."; exit 1; }

secret_exists() { gcloud secrets describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1; }
put_secret() {
  if secret_exists "$1"; then printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project "$PROJECT_ID" >/dev/null
  else printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$PROJECT_ID" >/dev/null; fi
}
# every answer is trimmed; an empty answer is refused and asked again (an extra Enter must not shift the answers)
ask() { local v; while :; do read -rp "$1: " v; v="$(printf '%s' "$v" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"; [ -n "$v" ] && break; echo "  (empty - please type the value)" >&2; done; printf '%s' "$v"; }
ask_digits() { local v; while :; do v="$(ask "$1")"; [[ "$v" =~ ^[0-9]+$ ]] && break; echo "  (numbers only - please try again)" >&2; done; printf '%s' "$v"; }
ask_hidden() { local v; while :; do read -rsp "$1 (typing is hidden): " v; echo >&2; v="$(printf '%s' "$v" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"; [ -n "$v" ] && break; echo "  (empty - please paste the value)" >&2; done; echo "  (received ${#v} characters)" >&2; printf '%s' "$v"; }
saved() { secret_exists "$1" && gcloud secrets versions access latest --secret "$1" --project "$PROJECT_ID" 2>/dev/null || true; }
reuse() { secret_exists "$1" && [ "${RESET_SECRETS:-}" != "1" ]; }
# numbers only; Enter keeps the saved value
ask_digits_default() { local v d="$2"; while :; do read -rp "$1 [${d:-none}]: " v; v="$(printf '%s' "$v" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"; [ -z "$v" ] && v="$d"; [[ "$v" =~ ^[0-9]+$ ]] && break; echo "  (numbers only - please try again)" >&2; done; printf '%s' "$v"; }
json_get() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get(sys.argv[1],""))' "$1"; }

gcloud services enable cloudscheduler.googleapis.com secretmanager.googleapis.com --project "$PROJECT_ID"
URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"

echo "== Odoo =="
if reuse eman-platform-odoo-key; then
  echo "Odoo settings already saved (to enter them again: RESET_SECRETS=1)."
  SALES_JOURNAL="$(saved eman-platform-sales-journal)"
else
  put_secret eman-platform-odoo-url "$(ask 'Odoo address, e.g. https://yourcompany.odoo.com (no slash at the end)')"
  put_secret eman-platform-odoo-db "$(ask 'Odoo database name (usually the first part of the address)')"
  put_secret eman-platform-odoo-key "$(ask_hidden 'Odoo API key')"
  SALES_JOURNAL="$(ask_digits 'Odoo id of the SALES journal for these invoices (use 23 = WhatsApp Test while testing)')"
  put_secret eman-platform-sales-journal "$SALES_JOURNAL"
fi

echo "== WhatsApp (Meta) =="
if reuse eman-platform-wa-token; then
  echo "WhatsApp settings already saved (to enter them again: RESET_SECRETS=1)."
  WA_PHONE="$(saved eman-platform-wa-phone-id)"; WA_TOKEN="$(saved eman-platform-wa-token)"
else
  WA_PHONE="$(ask_digits 'WhatsApp Phone number ID (Meta > WhatsApp > API setup)')"
  WA_TOKEN="$(ask_hidden 'WhatsApp access token of the system user')"
  put_secret eman-platform-wa-phone-id "$WA_PHONE"
  put_secret eman-platform-wa-token "$WA_TOKEN"
  put_secret eman-platform-app-secret "$(ask_hidden 'Meta App secret (Meta app > Settings > Basic)')"
fi
WABA="$(ask_digits_default 'WhatsApp / messaging account id used for Flows (Enter keeps the saved one)' "$(saved eman-platform-waba-id)")"
APP_ID="$(ask_digits_default 'Meta app id (the app that receives your webhooks; Enter keeps the saved one)' "$(saved eman-platform-app-id)")"
put_secret eman-platform-waba-id "$WABA"
put_secret eman-platform-app-id "$APP_ID"

echo
echo "== Flow encryption key =="
HAS_PASS=""
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if reuse eman-platform-flow-key; then
  echo "Flow key already saved (to enter it again: RESET_SECRETS=1)."
  secret_exists eman-platform-flow-key-pass && HAS_PASS=1
else
echo "A WhatsApp number can have ONE Flow key. A new key replaces the old one and would break any other Flow on that number"
echo "(for example the expense capture)."
read -rp "Is this number used ONLY for invoicing (no other Flow on it)? [y/N]: " ONLY
if [ "${ONLY:-n}" = "y" ] || [ "${ONLY:-n}" = "Y" ]; then
  openssl genrsa -out "$TMP/private.pem" 2048 2>/dev/null
  openssl rsa -in "$TMP/private.pem" -pubout -out "$TMP/public.pem" 2>/dev/null
  curl -fsS -X POST "${GRAPH}/${WA_PHONE}/whatsapp_business_encryption" \
    -H "Authorization: Bearer ${WA_TOKEN}" --data-urlencode "business_public_key@${TMP}/public.pem"
  echo; echo "New key registered with Meta for this number."
  put_secret eman-platform-flow-key "$(cat "$TMP/private.pem")"
else
  read -rp "Path to the EXISTING Flow private key file of this number: " KEYFILE
  KEYFILE="${KEYFILE/#\~/$HOME}"   # accept ~/flowkey.pem too
  [ -f "$KEYFILE" ] || { echo "File not found: $KEYFILE"; exit 1; }
  put_secret eman-platform-flow-key "$(cat "$KEYFILE")"
  read -rsp "Passphrase of that key (press Enter if it has none; typing is hidden): " PASS; echo
  PASS="$(printf '%s' "$PASS" | tr -d '\r')"
  if [ -n "$PASS" ]; then put_secret eman-platform-flow-key-pass "$PASS"; HAS_PASS=1; fi
fi
fi

echo
echo "== Invoice Flow in Meta (created as a DRAFT) =="
ENDPOINT="${URL}/invoicing/flow"
if secret_exists eman-platform-flow-id; then
  FLOW_ID="$(gcloud secrets versions access latest --secret eman-platform-flow-id --project "$PROJECT_ID")"
  read -rp "A Flow already exists (${FLOW_ID}). Update its content from this repository? [Y/n]: " UPD
  if [ "${UPD:-y}" != "n" ] && [ "${UPD:-y}" != "N" ]; then
    RESP="$(curl -sS -X POST "${GRAPH}/${FLOW_ID}/assets" -H "Authorization: Bearer ${WA_TOKEN}" \
      --form "file=@${FLOW_FILE};type=application/json" --form 'name=flow.json' --form 'asset_type=FLOW_JSON')"
    echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("Meta answer:", json.dumps(d.get("validation_errors") or d, indent=2))'
  fi
else
  BODY="$(FLOW_FILE="$FLOW_FILE" ENDPOINT="$ENDPOINT" python3 -c '
import json, os
print(json.dumps({"name": "Eman Invoice", "categories": ["OTHER"], "endpoint_uri": os.environ["ENDPOINT"],
                  "flow_json": json.dumps(json.load(open(os.environ["FLOW_FILE"])))}))')"
  RESP="$(printf '%s' "$BODY" | curl -sS -X POST "${GRAPH}/${WABA}/flows" -H "Authorization: Bearer ${WA_TOKEN}" -H "Content-Type: application/json" --data @-)"
  FLOW_ID="$(printf '%s' "$RESP" | json_get id)"
  if [ -z "$FLOW_ID" ]; then
    echo "Meta did not create the Flow. Its answer:"; echo "$RESP"
    echo "If it says the object does not exist or permissions are missing: the account id above may be the wrong one of the two, or the token lacks the whatsapp_business_management permission."
    exit 1
  fi
  echo "Flow created: ${FLOW_ID}"
  printf '%s' "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); e=d.get("validation_errors") or []; print("Validation errors from Meta:", json.dumps(e, indent=2) if e else "none")'
  curl -sS -X POST "${GRAPH}/${FLOW_ID}" -H "Authorization: Bearer ${WA_TOKEN}" -H "Content-Type: application/json" \
    --data "{\"endpoint_uri\":\"${ENDPOINT}\",\"application_id\":\"${APP_ID}\"}" ; echo
  put_secret eman-platform-flow-id "$FLOW_ID"
fi

put_secret eman-platform-tick-secret "$(openssl rand -hex 24)"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
SECRETS="odoo-url odoo-db odoo-key wa-phone-id wa-token flow-id app-secret flow-key tick-secret"
[ "${HAS_PASS:-}" = "1" ] && SECRETS="$SECRETS flow-key-pass"
for S in $SECRETS; do
  gcloud secrets add-iam-policy-binding "eman-platform-$S" --project "$PROJECT_ID" \
    --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" --role roles/secretmanager.secretAccessor >/dev/null
done

# CPU stays on between requests so the queue keeps working right after a salesman confirms; the instance still scales to zero when idle
gcloud run services update "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --no-cpu-throttling --min-instances 0 \
  --update-secrets "ODOO_URL=eman-platform-odoo-url:latest,ODOO_DB=eman-platform-odoo-db:latest,ODOO_API_KEY=eman-platform-odoo-key:latest,WA_PHONE_NUMBER_ID=eman-platform-wa-phone-id:latest,WA_TOKEN=eman-platform-wa-token:latest,FLOW_ID=eman-platform-flow-id:latest,META_APP_SECRET=eman-platform-app-secret:latest,FLOW_PRIVATE_KEY=eman-platform-flow-key:latest,TICK_SECRET=eman-platform-tick-secret:latest${HAS_PASS:+,FLOW_PRIVATE_KEY_PASSPHRASE=eman-platform-flow-key-pass:latest}" \
  --update-env-vars "FLOW_MODE=${FLOW_MODE:-draft},ODOO_SALES_JOURNAL_ID=${SALES_JOURNAL}"

TICK="$(gcloud secrets versions access latest --secret eman-platform-tick-secret --project "$PROJECT_ID")"
if gcloud scheduler jobs describe "$JOB" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then VERB=update; else VERB=create; fi
gcloud scheduler jobs "$VERB" http "$JOB" --location "$REGION" --project "$PROJECT_ID" \
  --schedule "* * * * *" --uri "${URL}/internal/tick" --http-method POST --headers "x-tick-secret=${TICK}" --attempt-deadline 180s >/dev/null

echo
echo "Invoicing is connected (Flow mode: ${FLOW_MODE:-draft}). Nothing in Meta's webhook was changed."
echo "Flow ID: ${FLOW_ID}   Flow endpoint: ${ENDPOINT}"
echo "Router address for the service:   ${URL}/invoicing/webhook"
