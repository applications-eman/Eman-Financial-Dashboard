import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redact, sink, logger } from "../lib/log.ts";
import { rateLimit } from "../lib/ratelimit.ts";
import { sendButtons, sendFlowMessage, waFetch } from "../lib/whatsapp.ts";
import { riyadhParts, runScheduledReports } from "../lib/reports.ts";
import { SupabaseStore, MemoryStore } from "../lib/store.ts";
import { saveExpense } from "../lib/expenses.ts";
import { vatWarnings } from "../lib/validate.ts";
import { setup } from "./helpers.ts";

describe("logging", () => {
  it("redacts secrets and never prints them", () => {
    const lines: string[] = [];
    const old = sink.write; sink.write = (l) => lines.push(l);
    logger.info("x", { token: "eb_secret", nested: { WA_TOKEN: "abc", authorization: "Bearer zzz", ok: 1 } });
    sink.write = old;
    assert.ok(!lines[0].includes("eb_secret") && !lines[0].includes("abc") && !lines[0].includes("zzz"));
    assert.equal((redact({ password: "p" }) as any).password, "[redacted]");
  });
});
describe("rate limit", () => {
  it("blocks after max within the window and resets", () => {
    for (let i = 0; i < 3; i++) assert.ok(rateLimit("k", 3, 1000, 0).ok);
    assert.equal(rateLimit("k", 3, 1000, 10).ok, false);
    assert.ok(rateLimit("k", 3, 1000, 2000).ok);
  });
});
describe("WhatsApp retry with backoff", () => {
  it("retries 5xx then succeeds; does not retry 4xx", async () => {
    let n = 0; const sleeps: number[] = [];
    const f = (async () => new Response("", { status: ++n < 3 ? 503 : 200 })) as typeof fetch;
    const r = await waFetch("https://x", {}, { f, sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(r.status, 200); assert.equal(n, 3); assert.ok(sleeps[1] > sleeps[0]);
    let m = 0;
    const r2 = await waFetch("https://x", {}, { f: (async () => { m++; return new Response("", { status: 400 }); }) as typeof fetch, sleep: async () => {} });
    assert.equal(r2.status, 400); assert.equal(m, 1);
    await assert.rejects(waFetch("https://x", {}, { f: (async () => { throw new Error("net"); }) as typeof fetch, sleep: async () => {} }, 2));
  });
});
describe("Flow message mode", () => {
  it("adds mode=draft only when asked", async () => {
    process.env.WA_TOKEN = "t"; process.env.WA_PHONE_NUMBER_ID = "1";
    const bodies: any[] = [];
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const deps = { f, sleep: async () => {} };
    await sendFlowMessage("+966500000002", { flowId: "9", flowToken: "x", body: "b", cta: "c" }, deps);
    await sendFlowMessage("+966500000002", { flowId: "9", flowToken: "x", body: "b", cta: "c", mode: "draft" }, deps);
    delete process.env.WA_TOKEN; delete process.env.WA_PHONE_NUMBER_ID;
    assert.equal(bodies[0].interactive.action.parameters.mode, undefined);
    assert.equal(bodies[1].interactive.action.parameters.mode, "draft");
  });
});
describe("Reply buttons message", () => {
  it("builds a WhatsApp interactive button payload (max 3, titles <= 20 chars)", async () => {
    process.env.WA_TOKEN = "t"; process.env.WA_PHONE_NUMBER_ID = "1";
    const bodies: any[] = [];
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await sendButtons("+966500000002", "choose", [{ id: "sec:bakery", title: "المخبز / Bakery" }, { id: "b", title: "x".repeat(40) }], { f, sleep: async () => {} });
    delete process.env.WA_TOKEN; delete process.env.WA_PHONE_NUMBER_ID;
    const i = bodies[0].interactive;
    assert.equal(i.type, "button");
    assert.equal(i.action.buttons[0].reply.id, "sec:bakery");
    assert.ok(i.action.buttons[1].reply.title.length <= 20);
    assert.equal(bodies[0].to, "966500000002");
  });
});
describe("VAT warning rule (mirrors DB trigger)", () => {
  it("accepts ~15% and flags others", () => {
    assert.deepEqual(vatWarnings(145.52, 18.98), []);
    assert.deepEqual(vatWarnings(115, 15), []);
    assert.deepEqual(vatWarnings(100, 50), ["vat_rate_mismatch"]);
    assert.deepEqual(vatWarnings(100, 0), ["vat_rate_mismatch"]);
  });
});
describe("SupabaseStore (REST mapping)", () => {
  it("maps 409 to conflict, sends service key + x-actor, builds filters", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}", { status: 409 }); }) as unknown as typeof fetch;
    const s = new SupabaseStore("https://p.supabase.co", "svc", f);
    assert.deepEqual(await s.insert("bakery_expenses", { a: 1 }, "ali"), { ok: false, conflict: true });
    const h = calls[0].init.headers as Record<string, string>;
    assert.equal(h["x-actor"], "ali"); assert.equal(h.apikey, "svc");
    await s.select("categories", { filters: [["section", "eq", "bakery"], ["id", "in", ["a", "b"]]], order: ["name", "asc"], limit: 5 }).catch(() => {});
    assert.match(calls[1].url, /\/rest\/v1\/categories\?section=eq\.bakery&id=in\.\("a","b"\)&order=name\.asc&limit=5/);
  });
});
describe("SupabaseStore key formats", () => {
  it("sends Authorization for legacy JWT keys but only apikey for sb_secret keys", async () => {
    const seen: Record<string, string>[] = [];
    const f = (async (_u: string, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return new Response("[]", { status: 200 }); }) as unknown as typeof fetch;
    await new SupabaseStore("https://p.supabase.co", "eyJhbGciOi.legacy.jwt", f).select("categories");
    await new SupabaseStore("https://p.supabase.co", "sb_secret_abc", f).select("categories");
    assert.equal(seen[0].Authorization, "Bearer eyJhbGciOi.legacy.jwt");
    assert.equal(seen[1].Authorization, undefined);
    assert.equal(seen[1].apikey, "sb_secret_abc");
  });
});
describe("scheduled reports", () => {
  it("fires once at the configured Riyadh hour, from settings (not code)", async () => {
    const store = setup();
    await store.insert("app_settings", { key: "report_schedule", value: { daily_enabled: true, daily_hour: 21, weekly_enabled: false } });
    const at = (iso: string) => new Date(iso);
    assert.equal(riyadhParts(at("2026-10-10T18:00:00Z")).hour, 21);
    assert.deepEqual(await runScheduledReports(store, at("2026-10-10T17:00:00Z")), []); // 20:00 Riyadh
    assert.deepEqual(await runScheduledReports(store, at("2026-10-10T18:05:00Z")), ["daily"]); // 21:05 Riyadh
    assert.deepEqual(await runScheduledReports(store, at("2026-10-10T18:50:00Z")), []); // already sent today
    await saveExpense(store, "bakery", { raw_qr: "" , vat_number: "300000000000003", invoice_date: "2026-10-10T10:00:00", total_amount: 115, vat_amount: 15 }, { source: "admin_manual", submitted_by: "t" });
    assert.equal(store.tables.bakery_expenses.length, 1);
  });
});
void MemoryStore;
