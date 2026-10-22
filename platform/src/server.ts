import { serve } from "@hono/node-server";

import { type AppDeps, createApp } from "./app.ts";
import { PgDb } from "./db.ts";
import { loadPrivateKey } from "./invoicing/flow-crypto.ts";
import { Json2Odoo } from "./invoicing/odoo.ts";
import { CloudWa } from "./invoicing/wa.ts";
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

let invoicing: AppDeps["invoicing"];
if (missing.length === 0) {
  const odoo = new Json2Odoo({
    url: need("ODOO_URL"),
    db: process.env.ODOO_DB || undefined,
    apiKey: need("ODOO_API_KEY"),
  });
  const wa = new CloudWa({
    phoneNumberId: need("WA_PHONE_NUMBER_ID"),
    token: need("WA_TOKEN"),
    flowId: need("FLOW_ID"),
    flowMode: process.env.FLOW_MODE === "draft" ? "draft" : "published",
    graphVersion: process.env.GRAPH_VERSION || undefined,
  });
  const worker: WorkerDeps = {
    db,
    odoo,
    wa,
    cashJournalId: process.env.ODOO_CASH_JOURNAL_ID ? Number(process.env.ODOO_CASH_JOURNAL_ID) : null,
    salesJournalId: process.env.ODOO_SALES_JOURNAL_ID ? Number(process.env.ODOO_SALES_JOURNAL_ID) : null,
    workerId: randomUUID(),
  };
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
  invoicing = {
    odoo,
    wa,
    flowKey: loadPrivateKey(need("FLOW_PRIVATE_KEY"), process.env.FLOW_PRIVATE_KEY_PASSPHRASE),
    appSecret: need("META_APP_SECRET"),
    tickSecret: need("TICK_SECRET"),
    kick,
    drainNow,
  };
  log("invoicing_enabled");
} else {
  log("invoicing_disabled", { missing });
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
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) }, (i) => log("platform_started", { port: i.port }));
