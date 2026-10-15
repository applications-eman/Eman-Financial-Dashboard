import { Hono } from "npm:hono@4";
import { verifyMetaSignature } from "../lib/crypto.ts";
import { env } from "../lib/env.ts";
import { decryptFlowRequest, encryptFlowResponse, FlowDecryptError, type FlowEnvelope, loadPrivateKey } from "../lib/flow-crypto.ts";
import { handleFlowRequest } from "../lib/flow-handler.ts";
import { logger } from "../lib/log.ts";
import { rateLimit } from "../lib/ratelimit.ts";
import { getStore } from "../lib/store.ts";

export const flowRoutes = new Hono();

flowRoutes.post("/api/flow", async (c) => {
  if (!rateLimit("flow", 600, 60_000).ok) return c.text("rate limited", 429);
  const raw = await c.req.text();
  const appSecret = env("WA_APP_SECRET") ?? "";
  // Meta signs Flow endpoint calls too; reject anything unsigned.
  if (!verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), appSecret)) return new Response("invalid signature", { status: 432 });
  let envelope: FlowEnvelope;
  try { envelope = JSON.parse(raw); } catch { return c.text("bad request", 400); }
  const pem = env("WA_FLOW_PRIVATE_KEY");
  if (!pem) { logger.error("WA_FLOW_PRIVATE_KEY missing"); return c.text("server misconfigured", 500); }
  let dec;
  try {
    dec = decryptFlowRequest(envelope, loadPrivateKey(pem, env("WA_FLOW_PRIVATE_KEY_PASSPHRASE")));
  } catch (e) {
    // 421 tells WhatsApp to refresh the public key and retry.
    logger.warn("flow decrypt failed", { kind: e instanceof FlowDecryptError ? "decrypt" : "key" });
    return c.text("decryption failed", 421);
  }
  const response = await handleFlowRequest(dec.body as Record<string, any>, { store: getStore(), f: fetch, appSecret });
  return c.text(encryptFlowResponse(response, dec.aesKey, dec.iv));
});
