import { MemorySeenStore, registryFromJson } from "./registry.ts";
import { handleWebhook, verifyChallenge } from "./router.ts";
import { SupabaseRegistry, SupabaseSeenStore } from "./supabase.ts";
import { createServer } from "node:http";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing setting ${k}`);
  return v;
};

const appSecret = need("META_APP_SECRET");
const verifyToken = need("META_VERIFY_TOKEN");
// Normal mode: the lists live in the platform database (managed from the admin screen).
// Fallback mode (no database yet): the lists come from one secret, ROUTER_REGISTRY_JSON.
const dbUrl = process.env.SUPABASE_URL;
const dbKey = process.env.SUPABASE_SERVICE_KEY;
const db = dbUrl && dbKey ? { url: dbUrl.replace(/\/$/, ""), serviceKey: dbKey, fetch } : null;
const registry = db ? new SupabaseRegistry(db) : registryFromJson(need("ROUTER_REGISTRY_JSON"));
const seen = db ? new SupabaseSeenStore(db) : new MemorySeenStore();
const log = (event: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }));

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://router");
  const send = (status: number, body: string, type = "text/plain") => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  try {
    if (req.method === "GET" && url.pathname === "/health")
      return send(200, JSON.stringify({ ok: true }), "application/json");
    if (url.pathname !== "/webhook") return send(404, "not found");
    if (req.method === "GET") {
      const r = verifyChallenge(url.searchParams, verifyToken);
      return send(r.status, r.body);
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 1_000_000) return send(413, "too large");
        chunks.push(c as Buffer);
      }
      const r = await handleWebhook(
        { appSecret, registry, seen, fetch, log },
        Buffer.concat(chunks),
        req.headers as Record<string, string | undefined>,
      );
      return send(r.status, r.body);
    }
    return send(405, "method not allowed");
  } catch (e) {
    log("router_error", { error: String((e as Error)?.message ?? e) });
    return send(500, "error");
  }
}).listen(Number(process.env.PORT ?? 8080), () => log("router_started"));
