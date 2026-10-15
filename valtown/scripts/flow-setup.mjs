#!/usr/bin/env node
// Creates / updates / publishes the WhatsApp Flow and registers the business public key.
// Usage:
//   WA_TOKEN=... WA_WABA_ID=... WA_PHONE_NUMBER_ID=... node valtown/scripts/flow-setup.mjs <command> [options]
// Commands:
//   public-key --pem ./flow_public.pem        upload the RSA public key used to encrypt Flow requests
//   create --endpoint https://<val>.web.val.run/api/flow [--name "Eman Expense Capture"]
//   update --flow-id <id>                     upload whatsapp/flow.json as a new version of a DRAFT flow
//   publish --flow-id <id>                    publish (irreversible: a published flow cannot be edited)
// Add --publish to `create`/`update` to publish immediately. Secrets are read from env and never printed.
import { readFileSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n) => rest.includes(`--${n}`);
const need = (n) => { const v = process.env[n]; if (!v) { console.error(`Missing env ${n}`); process.exit(2); } return v; };
const V = process.env.WA_GRAPH_VERSION || "v23.0";
const api = (p) => `https://graph.facebook.com/${V}/${p}`;
const auth = () => ({ Authorization: `Bearer ${need("WA_TOKEN")}` });

async function call(url, init) {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("Meta API error:", JSON.stringify(j.error ?? j, null, 2)); process.exit(1); }
  return j;
}
async function uploadJson(flowId) {
  const form = new FormData();
  form.set("name", "flow.json");
  form.set("asset_type", "FLOW_JSON");
  form.set("file", new Blob([readFileSync(new URL("../../whatsapp/flow.json", import.meta.url))], { type: "application/json" }), "flow.json");
  const j = await call(api(`${flowId}/assets`), { method: "POST", headers: auth(), body: form });
  const errs = j.validation_errors ?? [];
  if (errs.length) { console.error("Flow JSON validation errors:\n" + JSON.stringify(errs, null, 2)); process.exit(1); }
  console.log("Flow JSON uploaded and valid.");
}
const publish = async (id) => { await call(api(`${id}/publish`), { method: "POST", headers: auth() }); console.log(`Flow ${id} published.`); };

if (cmd === "public-key") {
  const pem = readFileSync(opt("pem") ?? "flow_public.pem", "utf8");
  const body = new URLSearchParams({ business_public_key: pem });
  await call(api(`${need("WA_PHONE_NUMBER_ID")}/whatsapp_business_encryption`), { method: "POST", headers: auth(), body });
  console.log("Public key registered for the phone number.");
} else if (cmd === "create") {
  const endpoint = opt("endpoint") ?? need("FLOW_ENDPOINT_URI");
  const body = new URLSearchParams({ name: opt("name") ?? "Eman Expense Capture", categories: JSON.stringify(["OTHER"]), endpoint_uri: endpoint });
  const j = await call(api(`${need("WA_WABA_ID")}/flows`), { method: "POST", headers: auth(), body });
  console.log("Created flow id:", j.id);
  await uploadJson(j.id);
  if (has("publish")) await publish(j.id);
  console.log(`Next: dashboard > Settings > wa_flow_id = "${j.id}"`);
} else if (cmd === "update") {
  await uploadJson(opt("flow-id") ?? need("WA_FLOW_ID"));
  if (has("publish")) await publish(opt("flow-id") ?? need("WA_FLOW_ID"));
} else if (cmd === "publish") {
  await publish(opt("flow-id") ?? need("WA_FLOW_ID"));
} else {
  console.log("Commands: public-key | create | update | publish  (see header of this file)");
  process.exit(cmd ? 1 : 0);
}
