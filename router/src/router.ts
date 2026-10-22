import { signBody, verifyMetaSignature } from "./crypto.ts";
import { extractEvents, filterBody } from "./extract.ts";
import { isSafeTargetUrl } from "./ssrf.ts";
import type { RouterDeps, Target, WaEvent } from "./types.ts";

const noop = (_event: string, _data?: Record<string, unknown>): void => undefined;

export interface Reply {
  status: number;
  body: string;
}

/** Meta's one-time address check: GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=... */
export function verifyChallenge(query: URLSearchParams, verifyToken: string): Reply {
  if (verifyToken && query.get("hub.mode") === "subscribe" && query.get("hub.verify_token") === verifyToken) {
    return { status: 200, body: query.get("hub.challenge") ?? "" };
  }
  return { status: 403, body: "forbidden" };
}

/**
 * One POST from Meta. Rules:
 *  1. unsigned or wrongly signed requests are dropped (401) and never forwarded;
 *  2. each message is sent to the service that owns the sender's number; unknown numbers are dropped;
 *  3. a message id already forwarded is not forwarded again (Meta retries);
 *  4. if one POST holds people of several services, each service gets only its own events, re-signed;
 *  5. if a service fails we answer 502, so Meta retries; messages already delivered elsewhere are not repeated.
 */
export async function handleWebhook(
  deps: RouterDeps,
  raw: Uint8Array,
  headers: Record<string, string | undefined>,
): Promise<Reply> {
  const log = deps.log ?? noop;
  if (!verifyMetaSignature(raw, headers["x-hub-signature-256"], deps.appSecret)) {
    log("signature_rejected");
    return { status: 401, body: "invalid signature" };
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return { status: 400, body: "invalid json" };
  }

  const events = extractEvents(body);
  if (!events.length) {
    log("no_routable_events");
    return { status: 200, body: "ok" };
  }

  const [targets, routes] = await Promise.all([deps.registry.targets(), deps.registry.routes()]);
  const byId = new Map(targets.filter((t) => t.enabled && isSafeTargetUrl(t.url)).map((t) => [t.id, t]));
  const owner = new Map(routes.map((r) => [r.phone, r.targetId]));

  // decide per event: which target, or dropped
  const perTarget = new Map<string, WaEvent[]>();
  let dropped = 0;
  for (const ev of events) {
    const tid = owner.get(ev.phone);
    if (!tid || !byId.has(tid)) {
      dropped++;
      log("unknown_or_disabled_sender", { phone: ev.phone });
      continue;
    }
    if (ev.kind === "message" && ev.id && (await deps.seen.seen(ev.id))) {
      dropped++;
      log("duplicate_message", { id: ev.id });
      continue;
    }
    (perTarget.get(tid) ?? perTarget.set(tid, []).get(tid)!).push(ev);
  }
  if (!perTarget.size) return { status: 200, body: "ok" };

  const unchanged = perTarget.size === 1 && dropped === 0;
  const results = await Promise.all(
    [...perTarget].map(async ([tid, evs]) => {
      const target = byId.get(tid)!;
      let payload: Uint8Array | string = raw;
      let signature = headers["x-hub-signature-256"] ?? "";
      if (!unchanged) {
        const keep = new Set(evs.map((e) => `${e.kind}:${e.id}:${e.phone}`));
        payload = JSON.stringify(filterBody(body, (e) => keep.has(`${e.kind}:${e.id}:${e.phone}`)));
        signature = signBody(payload, deps.appSecret);
      }
      const ok = await forward(deps, target, payload, signature);
      if (!ok) await deps.seen.forget(evs.filter((e) => e.kind === "message" && e.id).map((e) => e.id));
      return ok;
    }),
  );
  return results.every(Boolean)
    ? { status: 200, body: "ok" }
    : { status: 502, body: "a service did not accept the event" };
}

async function forward(
  deps: RouterDeps,
  target: Target,
  payload: Uint8Array | string,
  signature: string,
): Promise<boolean> {
  const log = deps.log ?? noop;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 8000);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-router-source": "eman-whatsapp-router",
    };
    if (target.secret) headers["x-router-secret"] = target.secret;
    const res = await deps.fetch(target.url, {
      method: "POST",
      headers,
      body: payload as BodyInit,
      signal: ctl.signal,
    });
    if (!res.ok) log("target_rejected", { target: target.id, status: res.status });
    return res.ok;
  } catch (e) {
    log("target_unreachable", { target: target.id, error: String((e as Error)?.message ?? e) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
