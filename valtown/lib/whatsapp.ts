// WhatsApp Cloud API client with retry/backoff. Tokens come from env and are never logged.
import { env, GRAPH_VERSION, requireEnv } from "./env.ts";
import { errMsg, logger, maskPhone } from "./log.ts";
import type { Store } from "./store.ts";
import { getSetting } from "./settings.ts";

export interface WaDeps { f: typeof fetch; sleep: (ms: number) => Promise<void> }
export const defaultDeps: WaDeps = { f: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const graph = (path: string) => `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;

/** Retries 429/5xx/network errors with exponential backoff + jitter; 4xx fail fast. */
export async function waFetch(url: string, init: RequestInit, deps: WaDeps = defaultDeps, attempts = 4): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await deps.f(url, init);
      if (r.status !== 429 && r.status < 500) return r;
      last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    if (i < attempts - 1) await deps.sleep(300 * 2 ** i + Math.floor(Math.random() * 100));
  }
  throw new Error(`WhatsApp request failed after ${attempts} attempts: ${errMsg(last)}`);
}

async function post(body: unknown, deps: WaDeps): Promise<boolean> {
  const id = requireEnv("WA_PHONE_NUMBER_ID");
  const r = await waFetch(graph(`${id}/messages`), {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("WA_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...(body as object) }),
  }, deps);
  if (!r.ok) logger.warn("whatsapp send rejected", { status: r.status, detail: (await r.text()).slice(0, 300) });
  return r.ok;
}

const digits = (to: string) => to.replace(/\D/g, "");

export async function sendText(to: string, text: string, deps: WaDeps = defaultDeps): Promise<boolean> {
  try {
    return await post({ to: digits(to), type: "text", text: { body: text, preview_url: false } }, deps);
  } catch (e) {
    logger.error("sendText failed", { to: maskPhone(to), error: errMsg(e) });
    return false;
  }
}

/** Business-initiated messages (outside the 24h window) need an approved template. If the admin has
 *  configured `wa_notify_template` ({name, lang}, body = single {{1}} variable) we use it, otherwise plain text. */
export async function sendNotification(store: Store, to: string, text: string, deps: WaDeps = defaultDeps): Promise<boolean> {
  const tpl = await getSetting<{ name?: string; lang?: string } | null>(store, "wa_notify_template", null);
  if (tpl?.name) {
    try {
      const ok = await post({
        to: digits(to), type: "template",
        template: { name: tpl.name, language: { code: tpl.lang || "ar" }, components: [{ type: "body", parameters: [{ type: "text", text: text.replace(/\s*\n+\s*/g, " | ").slice(0, 1000) }] }] },
      }, deps);
      if (ok) return true;
    } catch (e) {
      logger.warn("template send failed, falling back to text", { error: errMsg(e) });
    }
  }
  return sendText(to, text, deps);
}

/** Interactive "reply buttons" message (max 3 buttons, title max 20 chars). Works inside the 24h chat window; no Flow needed. */
export async function sendButtons(to: string, body: string, buttons: { id: string; title: string }[], deps: WaDeps = defaultDeps): Promise<boolean> {
  try {
    return await post({
      to: digits(to), type: "interactive",
      interactive: { type: "button", body: { text: body }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) } },
    }, deps);
  } catch (e) {
    logger.error("sendButtons failed", { to: maskPhone(to), error: errMsg(e) });
    return false;
  }
}

export async function sendFlowMessage(to: string, o: { flowId: string; flowToken: string; body: string; cta: string; screen?: string; mode?: "draft" | "published" }, deps: WaDeps = defaultDeps): Promise<boolean> {
  try {
    return await post({
      to: digits(to), type: "interactive",
      interactive: {
        type: "flow", body: { text: o.body },
        action: { name: "flow", parameters: { flow_message_version: "3", flow_token: o.flowToken, flow_id: o.flowId, flow_cta: o.cta.slice(0, 30), flow_action: "data_exchange", ...(o.mode === "draft" ? { mode: "draft" } : {}) } },
      },
    }, deps);
  } catch (e) {
    logger.error("sendFlow failed", { to: maskPhone(to), error: errMsg(e) });
    return false;
  }
}

export async function downloadMedia(mediaId: string, deps: WaDeps = defaultDeps): Promise<{ bytes: Uint8Array; mime: string }> {
  const auth = { Authorization: `Bearer ${requireEnv("WA_TOKEN")}` };
  const meta = await waFetch(graph(mediaId), { headers: auth }, deps);
  if (!meta.ok) throw new Error(`media lookup failed: ${meta.status}`);
  const { url, mime_type } = (await meta.json()) as { url: string; mime_type: string };
  const file = await waFetch(url, { headers: auth }, deps);
  if (!file.ok) throw new Error(`media download failed: ${file.status}`);
  return { bytes: new Uint8Array(await file.arrayBuffer()), mime: mime_type };
}

export const waConfigured = () => Boolean(env("WA_TOKEN") && env("WA_PHONE_NUMBER_ID"));
