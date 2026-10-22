#!/usr/bin/env bash
# Sends the current invoice Flow (docs/whatsapp-invoicing/flow-live.json) to the EXISTING Flow in Meta. Asks nothing:
# it uses the Flow id and token already saved by connect-invoicing.sh. Meta answers with any Flow error right here.
#   PROJECT_ID=eman-expenses ./scripts/update-flow.sh
set -euo pipefail
: "${PROJECT_ID:?set PROJECT_ID}"
GRAPH="https://graph.facebook.com/${GRAPH_VERSION:-v21.0}"
FLOW_FILE="docs/whatsapp-invoicing/flow-live.json"
[ -f "$FLOW_FILE" ] || { echo "Run this from the repository folder (cd ~/Eman-Financial-Dashboard)."; exit 1; }
get() { gcloud secrets versions access latest --secret "$1" --project "$PROJECT_ID"; }
FLOW_ID="$(get eman-platform-flow-id)"
TOKEN="$(get eman-platform-wa-token)"
echo "Updating Flow ${FLOW_ID} ..."
curl -sS -X POST "${GRAPH}/${FLOW_ID}/assets" -H "Authorization: Bearer ${TOKEN}" \
  --form "file=@${FLOW_FILE};type=application/json" --form 'name=flow.json' --form 'asset_type=FLOW_JSON' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); e=d.get("validation_errors"); print("Meta answer:", "OK, no Flow errors" if d.get("success") and not e else json.dumps(d, indent=2))'
