import { serve } from "@hono/node-server";

import { type AppDeps, createApp } from "./app.ts";
import { PgDb } from "./db.ts";
import { loadPrivateKey } from "./invoicing/flow-crypto.ts";
import { setting } from "./invoicing/intake.ts";
import { Json2Odoo } from "./invoicing/odoo.ts";
import { CloudWa, TestModeWa } from "./invoicing/wa.ts";
import { drain, type WorkerDeps } from "./invoicing/worker.ts";
import { randomUUID } from "node:crypto";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing setting ${k}`);
  return v;
};
const log = (event: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...extra }));

const db = new PgDb(need("DATABASE_URL"));

// Invoicing switches on only when ALL of its settings are present, so the admin screens work before Odoo/WhatsApp are connected.
const INVOICING_KEYS = [
  "ODOO_URL",
  "ODOO_API_KEY",
  "WA_PHONE_NUMBER_ID",
  "WA_TOKEN",
  "FLOW_ID",
  "FLOW_PRIVATE_KEY",
  "META_APP_SECRET",
  "TICK_SECRET",
];
const missing = INVOICING_KEYS.filter((k) => !process.env[k]);

function buildInvoicing(): NonNullable<AppDeps["invoicing"]> {
  const odoo = new Json2Odoo({
    url: need("ODOO_URL"),
    db: process.env.ODOO_DB || undefined,
    apiKey: need("ODOO_API_KEY"),
  });
  const cloud = new CloudWa({
    phoneNumberId: need("WA_PHONE_NUMBER_ID"),
    token: need("WA_TOKEN"),
    flowId: need("FLOW_ID"),
    flowMode: process.env.FLOW_MODE === "draft" ? "draft" : "published",
    graphVersion: process.env.GRAPH_VERSION || undefined,
  });
  const wa = new TestModeWa(cloud, async () => (await setting(db, "test_mode", true)) === true);
  const worker: WorkerDeps = {
    db,
    odoo,
    wa,
    cashJournalId: process.env.ODOO_CASH_JOURNAL_ID ? Number(process.env.ODOO_CASH_JOURNAL_ID) : null,
    salesJournalId: process.env.ODOO_SALES_JOURNAL_ID ? Number(process.env.ODOO_SALES_JOURNAL_ID) : null,
    workerId: randomUUID(),
  };
  // read first: a key that cannot be read must stop invoicing before anything is started
  const flowKey = loadPrivateKey(need("FLOW_PRIVATE_KEY"), process.env.FLOW_PRIVATE_KEY_PASSPHRASE);
  let running: Promise<number> | null = null;
  const drainNow = () => {
    // one pass at a time inside this instance (the database lock covers other instances)
    running ??= drain(worker).finally(() => {
      running = null;
    });
    return running;
  };
  const kick = () =>
    void drainNow().catch((e: unknown) => log("drain_failed", { error: e instanceof Error ? e.message : String(e) }));
  setInterval(kick, 30_000).unref();
  return { odoo, wa, flowKey, appSecret: need("META_APP_SECRET"), tickSecret: need("TICK_SECRET"), kick, drainNow };
}

// A problem with the invoicing settings must never take the admin screens down: invoicing stays off and /health says why.
let invoicing: AppDeps["invoicing"];
let invoicingStatus = "off";
if (missing.length > 0) {
  log("invoicing_disabled", { missing });
  invoicingStatus = `off: missing ${missing.join(", ")}`;
} else {
  try {
    invoicing = buildInvoicing();
    invoicingStatus = process.env.ODOO_SALES_JOURNAL_ID
      ? `on (journal ${process.env.ODOO_SALES_JOURNAL_ID})`
      : "on, but invoices wait: ODOO_SALES_JOURNAL_ID is not set";
    log("invoicing_enabled", { journal: process.env.ODOO_SALES_JOURNAL_ID ?? null });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log("invoicing_failed_to_start", { error: reason });
    invoicingStatus = `off: ${reason.slice(0, 160)}`;
  }
}

const app = createApp({
  db,
  auth: {
    issuerBase: need("AUTH_SUPABASE_URL").replace(/\/$/, ""),
    jwtSecret: process.env.AUTH_JWT_SECRET || undefined,
    fetch,
  },
  allowedOrigins: need("ALLOWED_ORIGINS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  invoicing,
  invoicingStatus,
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) }, (i) => log("platform_started", { port: i.port }));
