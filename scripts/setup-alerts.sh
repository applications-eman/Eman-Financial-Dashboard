#!/usr/bin/env bash
# One-time setup of the safety alerts: an e-mail goes out when an invoice is not issued, a PDF is not delivered, or the health check
# finds a problem (queue stuck, Odoo unreachable, Odoo key about to expire, invoices not cleared).
#   PROJECT_ID=eman-expenses ALERT_EMAIL=you@example.com ./scripts/setup-alerts.sh
set -euo pipefail
: "${PROJECT_ID:?set PROJECT_ID}"
: "${ALERT_EMAIL:?set ALERT_EMAIL (where the alerts are sent)}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-eman-platform}"

gcloud services enable monitoring.googleapis.com cloudscheduler.googleapis.com --project "$PROJECT_ID" || echo "(continuing)"

CHANNEL="$(gcloud beta monitoring channels list --project "$PROJECT_ID" --filter "labels.email_address=${ALERT_EMAIL}" --format 'value(name)' | head -1)"
if [ -z "$CHANNEL" ]; then
  CHANNEL="$(gcloud beta monitoring channels create --project "$PROJECT_ID" --display-name "Eman alerts" --type email \
    --channel-labels "email_address=${ALERT_EMAIL}" --format 'value(name)')"
fi

POLICY="$(mktemp)"
cat > "$POLICY" <<JSON
{
  "displayName": "Eman invoicing: something needs attention",
  "combiner": "OR",
  "conditions": [{
    "displayName": "Invoice not issued, PDF not delivered, or health problem",
    "conditionMatchedLog": {
      "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND (jsonPayload.message=\"invoice_not_issued\" OR jsonPayload.message=\"pdf_not_delivered\" OR jsonPayload.message=\"health_problem\")"
    }
  }],
  "alertStrategy": { "notificationRateLimit": { "period": "1800s" } },
  "notificationChannels": ["${CHANNEL}"]
}
JSON
gcloud alpha monitoring policies create --project "$PROJECT_ID" --policy-from-file "$POLICY" --quiet
rm -f "$POLICY"

# the health check runs every 5 minutes; a problem writes an error line, which the alert above e-mails
URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
SECRET="$(gcloud secrets versions access latest --secret eman-platform-tick-secret --project "$PROJECT_ID")"
if gcloud scheduler jobs describe eman-platform-health --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud scheduler jobs update http eman-platform-health --location "$REGION" --project "$PROJECT_ID" \
    --schedule "*/5 * * * *" --uri "${URL}/internal/queue-health" --http-method GET --update-headers "x-tick-secret=${SECRET}"
else
  gcloud scheduler jobs create http eman-platform-health --location "$REGION" --project "$PROJECT_ID" \
    --schedule "*/5 * * * *" --uri "${URL}/internal/queue-health" --http-method GET --headers "x-tick-secret=${SECRET}"
fi
echo "Alerts are on. Test: they go to ${ALERT_EMAIL}."
