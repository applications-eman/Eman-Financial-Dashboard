// HTTP endpoints of the invoicing service, mounted by createApp when Odoo and WhatsApp are configured.

import type { Env, Hono } from "hono";

import type { Db } from "../db.ts";
import { handleFlow } from "./flow.ts";
import { decryptFlowRequest, encryptFlowResponse, FlowDecryptError } from "./flow-crypto.ts";
import type { OdooPort } from "./odoo.ts";
import type { WaPort } from "./wa.ts";
import { handleInvoicingWebhook } from "./webhook.ts";
import type { KeyObject } from "node:crypto";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface InvoicingDeps {
  odoo: OdooPort;
  wa: WaPort;
  flowKey: KeyObject;
  /** Meta app secret: signs the Flow endpoint calls */
  appSecret: string;
  /** shared secret of the Cloud Scheduler job that calls /internal/tick */
  tickSecret: string;
  /** starts the queue worker in the background (does not wait) */
  kick: () => void;
  /** processes the queue now and returns how many requests were handled */
  drainNow: () => Promise<number>;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function routerSecret(db: Db): Promise<string | null> {
  const [t] = await db.query<{ secret: string | null }>(
    `select secret from wa_targets where id='invoicing' and enabled`,
  );
  return t?.secret ?? null;
}

export function mountInvoicing<E extends Env>(app: Hono<E>, db: Db, d: InvoicingDeps) {
  // from the router: salesman messages
  app.post("/invoicing/webhook", async (c) => {
    const secret = await routerSecret(db);
    const given = c.req.header("x-router-secret") ?? "";
    if (!secret || !same(given, secret)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    await handleInvoicingWebhook({ db, wa: d.wa, odoo: d.odoo }, body);
    d.kick();
    return c.json({ ok: true });
  });

  // from WhatsApp itself: the encrypted Flow data endpoint
  app.post("/invoicing/flow", async (c) => {
    const raw = await c.req.text();
    const expected = `sha256=${createHmac("sha256", d.appSecret).update(raw).digest("hex")}`;
    if (!same(c.req.header("x-hub-signature-256") ?? "", expected)) return c.text("bad signature", 432 as 400);
    let dec: ReturnType<typeof decryptFlowRequest>;
    try {
      dec = decryptFlowRequest(JSON.parse(raw), d.flowKey);
    } catch (e) {
      if (e instanceof FlowDecryptError || e instanceof SyntaxError) return c.text("decryption failed", 421 as 400);
      throw e;
    }
    const out = await handleFlow(db, dec.body);
    d.kick();
    return c.text(encryptFlowResponse(out, dec.aesKey, dec.iv));
  });

  // Cloud Scheduler, every minute: picks up pending ZATCA answers and anything a stopped instance left behind
  app.post("/internal/tick", async (c) => {
    if (!d.tickSecret || !same(c.req.header("x-tick-secret") ?? "", d.tickSecret))
      return c.json({ error: "unauthorized" }, 401);
    const handled = await d.drainNow();
    await db.query(`select public.purge_seen_messages()`).catch(() => undefined);
    await db.query(`select public.purge_flow_sessions()`).catch(() => undefined);
    return c.json({ handled });
  });
}
