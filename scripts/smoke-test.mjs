#!/usr/bin/env node
// Post-deployment end-to-end smoke test against the REAL system. Sends sample payloads to every capture endpoint,
// then confirms the rows landed in Supabase (read with the admin's own session, i.e. through RLS) and cleans up.
//
//   BACKEND_URL=https://….web.val.run STAFF_TOKEN=eb_… WA_APP_SECRET=… WA_TEST_PHONE=966500000002 \
//   FLOW_PUBLIC_KEY_PATH=./flow_public.pem SUPABASE_URL=https://….supabase.co SUPABASE_ANON_KEY=… \
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/smoke-test.mjs
//
// WA_TEST_PHONE must be an active staff member with the `bakery` section. WhatsApp replies are attempted only if
// WA_TOKEN is configured in Val Town. Skip a channel by leaving its variables unset.
import { constants, createCipheriv, createDecipheriv, createHmac, publicEncrypt, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const e = process.env;
const need = (...k) => k.filter((x) => !e[x]);
const results = [];
const rec = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- sample ZATCA QR (seller شركة مخابز ايمان جدة للخبز, VAT 312028501300003, 2026-08-11T15:19:20, 145.52 / 18.98)
const tlv = (fields) =>
  Buffer.concat(
    Object.entries(fields).map(([t, v]) => {
      const b = Buffer.from(v, "utf8");
      return Buffer.concat([Buffer.from([Number(t), b.length]), b]);
    }),
  ).toString("base64");
const unique = (Math.floor(Math.random() * 9000) + 1000) / 100; // 10.00–99.99, unique per run
const vat = Math.round((unique - unique / 1.15) * 100) / 100;
const qr = tlv({
  1: "شركة مخابز ايمان جدة للخبز",
  2: "312028501300003",
  3: "2026-08-11T15:19:20",
  4: unique.toFixed(2),
  5: vat.toFixed(2),
});

const json = (url, init) =>
  fetch(url, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const BACKEND = (e.BACKEND_URL ?? "").replace(/\/$/, "");

let jwt = "";
async function adminLogin() {
  const r = await json(`${e.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: e.SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: e.ADMIN_EMAIL, password: e.ADMIN_PASSWORD }),
  });
  jwt = r.body.access_token ?? "";
  rec("admin login (Supabase Auth)", Boolean(jwt));
}
const rows = async (table, qs) =>
  (
    await fetch(`${e.SUPABASE_URL}/rest/v1/${table}?${qs}`, {
      headers: { apikey: e.SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` },
    })
  ).json();

if (!BACKEND) {
  console.error("Set BACKEND_URL");
  process.exit(2);
}
rec("backend /health", (await json(`${BACKEND}/health`)).body.ok === true);
if (!need("SUPABASE_URL", "SUPABASE_ANON_KEY", "ADMIN_EMAIL", "ADMIN_PASSWORD").length) await adminLogin();

// 1) iOS Shortcut endpoint
if (!need("STAFF_TOKEN").length) {
  const post = () =>
    json(`${BACKEND}/api/expense`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ section: "bakery", raw_qr: qr, token: e.STAFF_TOKEN }),
    });
  const a = await post();
  rec("POST /api/expense saves", a.body.status === "saved", `HTTP ${a.status}`);
  const b = await post();
  rec("POST /api/expense duplicate detected", b.body.status === "duplicate");
  const bad = await json(`${BACKEND}/api/expense`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ section: "bakery", raw_qr: qr, token: "eb_wrong_token_value" }),
  });
  rec("POST /api/expense rejects a bad token", bad.status === 401);
}
// 2) WhatsApp webhook with a Meta-style signed text message carrying a *different* invoice
if (!need("WA_APP_SECRET", "WA_TEST_PHONE").length) {
  const qr2 = tlv({
    1: "Smoke Test Supplier",
    2: "300000000000003",
    3: "2026-08-12T10:00:00",
    4: unique.toFixed(2),
    5: vat.toFixed(2),
  });
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ id: `wamid.SMOKE${Date.now()}`, from: e.WA_TEST_PHONE, type: "text", text: { body: qr2 } }],
            },
          },
        ],
      },
    ],
  });
  const sig = `sha256=${createHmac("sha256", e.WA_APP_SECRET).update(body).digest("hex")}`;
  const r = await json(`${BACKEND}/whatsapp/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body,
  });
  rec("WhatsApp webhook (signed text message) saved", r.body.results?.[0] === "saved", JSON.stringify(r.body.results));
  const forged = await fetch(`${BACKEND}/whatsapp/webhook`, {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=00" },
    body,
  });
  rec("WhatsApp webhook rejects a bad signature", forged.status === 401);
}
// 3) Flow endpoint: encrypted ping round-trip with the public key you registered at Meta
if (!need("WA_APP_SECRET", "FLOW_PUBLIC_KEY_PATH").length) {
  const aes = randomBytes(16),
    iv = randomBytes(16);
  const c = createCipheriv("aes-128-gcm", aes, iv);
  const data = Buffer.concat([c.update(JSON.stringify({ action: "ping", version: "3.0" })), c.final(), c.getAuthTag()]);
  const raw = JSON.stringify({
    encrypted_flow_data: data.toString("base64"),
    initial_vector: iv.toString("base64"),
    encrypted_aes_key: publicEncrypt(
      { key: readFileSync(e.FLOW_PUBLIC_KEY_PATH), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      aes,
    ).toString("base64"),
  });
  const sig = `sha256=${createHmac("sha256", e.WA_APP_SECRET).update(raw).digest("hex")}`;
  const r = await fetch(`${BACKEND}/api/flow`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
  let ok = false;
  if (r.status === 200) {
    const buf = Buffer.from(await r.text(), "base64");
    const d = createDecipheriv("aes-128-gcm", aes, Buffer.from(iv.map((b) => ~b & 255)));
    d.setAuthTag(buf.subarray(buf.length - 16));
    ok =
      JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString()).data?.status ===
      "active";
  }
  rec("Flow endpoint encrypted ping → {status:'active'}", ok, `HTTP ${r.status}`);
}
// 4) rows landed in Supabase (read through RLS with the admin session) + audit trail, then clean up
if (jwt) {
  const found = await rows(
    "bakery_expenses",
    `total_amount=eq.${unique}&select=id,source,seller_name,warnings,duplicate_count`,
  );
  rec("rows visible to the admin through RLS", Array.isArray(found) && found.length >= 1, `${found.length} row(s)`);
  for (const r of Array.isArray(found) ? found : []) {
    const del = await fetch(`${BACKEND}/admin/expenses/bakery/${r.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    rec(`cleanup row ${r.id.slice(0, 8)} via admin API`, del.ok);
  }
  const audit = await rows(
    "audit_log",
    "table_name=eq.bakery_expenses&order=created_at.desc&limit=3&select=action,actor",
  );
  rec("audit_log records the admin's delete", Array.isArray(audit) && audit.some((a) => a.action === "DELETE"));
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
console.log(
  "Realtime: open the dashboard, re-run this script and watch the toast + activity feed (or `npm run e2e` locally).",
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
