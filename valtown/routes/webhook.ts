import { Hono } from "npm:hono@4";
import { safeEqual, verifyMetaSignature } from "../lib/crypto.ts";
import { env } from "../lib/env.ts";
import { errMsg, logger } from "../lib/log.ts";
import { rateLimit } from "../lib/ratelimit.ts";
import { getStore } from "../lib/store.ts";
import { processInboundMessage } from "../lib/wa-inbound.ts";

export const webhookRoutes = new Hono();

webhookRoutes.get("/whatsapp/webhook", (c) => {
  const q = c.req.query();
  const expected = env("WA_VERIFY_TOKEN");
  if (expected && q["hub.mode"] === "subscribe" && q["hub.verify_token"] && safeEqual(q["hub.verify_token"], expected)) {
    return c.text(q["hub.challenge"] ?? "");
  }
  return c.text("forbidden", 403);
});

webhookRoutes.post("/whatsapp/webhook", async (c) => {
  if (!rateLimit("wa-webhook", 1200, 60_000).ok) return c.text("rate limited", 429);
  const raw = await c.req.text();
  const secret = env("WA_APP_SECRET") ?? "";
  if (!verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), secret)) {
    logger.warn("webhook signature rejected");
    return c.text("invalid signature", 401);
  }
  let payload: any;
  try { payload = JSON.parse(raw); } catch { return c.text("bad json", 400); }
  const store = getStore();
  const results: string[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const msg of change?.value?.messages ?? []) {
        const id = String(msg.id ?? "");
        if (!id) continue;
        // Idempotency: a retry of an already-processed message is a no-op.
        const ins = await store.insert("whatsapp_events", { wa_message_id: id, payload: { type: msg.type, from_masked: String(msg.from ?? "").slice(-4) } });
        if (!ins.ok && ins.conflict) {
          const { rows } = await store.select("whatsapp_events", { filters: [["wa_message_id", "eq", id]], limit: 1 });
          if (rows[0]?.processed_at) { results.push("duplicate_event"); continue; }
        } else if (!ins.ok) { logger.error("event insert failed"); }
        try {
          results.push(await processInboundMessage(store, msg, secret));
          await store.update("whatsapp_events", [["wa_message_id", "eq", id]], { processed_at: new Date().toISOString() });
        } catch (e) {
          logger.error("message processing failed", { id, error: errMsg(e) });
          results.push("error");
        }
      }
    }
  }
  return c.json({ ok: true, results }); // always 200 so Meta does not hammer retries for permanent failures
});
