// Revenue module API. Admin-only routes live under /admin/* (guard is in admin.ts); /review/* is open to admin AND accounts staff.
import { Hono, type Context } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { z } from "npm:zod@4.6.7";
import { toCsv } from "../lib/csv.ts";
import { env } from "../lib/env.ts";
import { verifySupabaseJwt } from "../lib/jwt.ts";
import { getOdoo, odooAvailable } from "../lib/odoo-factory.ts";
import { DEFAULT_SYNC, runSyncCycle } from "../lib/odoo-sync.ts";
import { rateLimit } from "../lib/ratelimit.ts";
import { type Row, type Store, getStore } from "../lib/store.ts";
import { verifyPeriod } from "../lib/verify.ts";
import { getSetting } from "../lib/settings.ts";

type Vars = { Variables: { admin: Row; actor: string; store: Store; reviewer: Row } };
const bad = (c: Context, msg: string, status: 400 | 404 | 409 | 422 = 400) => c.json({ error: msg }, status);
const zerr = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
const body = async (c: Context) => { try { return await c.req.json(); } catch { return null; } };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().min(0).max(1e10);

// ---------------------------------------------------------------- admin-only (mounted inside adminRoutes)
export const revenueAdmin = new Hono<Vars>();

revenueAdmin.get("/admin/sync/status", async (c) => {
  const store = c.get("store");
  const cfg = { ...DEFAULT_SYNC, ...(await getSetting<Record<string, number>>(store, "sync_settings", {})) };
  const state = await store.select("sync_state", { filters: [["key", "in", ["last_success", "invoice_cursor"]]] });
  const runs = await store.select("sync_runs", { order: ["started_at", "desc"], limit: 10 });
  const flag = (await store.select("feature_flags", { filters: [["key", "eq", "odoo_sync"]], limit: 1 })).rows[0];
  let dbBytes: number | null = null;
  try { const r = (await store.rpc("db_size_bytes")) as unknown; dbBytes = Number(Array.isArray(r) ? Object.values(r[0] ?? {})[0] : r); } catch { /* optional */ }
  return c.json({
    configured: odooAvailable(), enabled: Boolean(flag?.enabled), settings: cfg,
    last_success: state.rows.find((r) => r.key === "last_success")?.value ?? null,
    cursor: state.rows.find((r) => r.key === "invoice_cursor")?.value ?? null,
    runs: runs.rows, db_bytes: Number.isFinite(dbBytes) ? dbBytes : null,
  });
});

revenueAdmin.post("/admin/sync/run", async (c) => {
  if (!odooAvailable()) return bad(c, "Odoo variables are not set in Val Town", 422);
  if (!rateLimit(`syncnow:${c.get("admin").id}`, 6, 60_000).ok) return c.json({ error: "rate limited" }, 429);
  const r = await runSyncCycle(c.get("store"), getOdoo(), { kind: "manual" });
  return c.json(r, r.error ? 502 : 200);
});

revenueAdmin.post("/admin/verify", async (c) => {
  if (!odooAvailable()) return bad(c, "Odoo variables are not set in Val Town", 422);
  if (!rateLimit(`verify:${c.get("admin").id}`, 10, 60_000).ok) return c.json({ error: "rate limited" }, 429);
  const p = z.object({ from: date, to: date }).safeParse(await body(c));
  if (!p.success) return bad(c, zerr(p.error), 422);
  try { return c.json(await verifyPeriod(c.get("store"), getOdoo(), p.data.from, p.data.to, c.get("actor"))); }
  catch (e) { return c.json({ error: e instanceof Error ? e.message : "verification failed" }, 502); }
});

// ---- VAT payments register
const payment = z.object({
  period_year: z.number().int().min(2020).max(2100), period_quarter: z.number().int().min(1).max(4), amount_paid: money,
  paid_on: date.nullable().optional(), reference: z.string().max(200).nullable().optional(), notes: z.string().max(1000).nullable().optional(),
}).strict();

revenueAdmin.get("/admin/vat/payments", async (c) => c.json((await c.get("store").select("vat_payments", { order: ["period_year", "desc"], limit: 500 })).rows));
revenueAdmin.post("/admin/vat/payments", async (c) => {
  const p = payment.safeParse(await body(c));
  if (!p.success) return bad(c, zerr(p.error), 422);
  const r = await c.get("store").insert("vat_payments", { ...p.data, created_by: c.get("actor") }, c.get("actor"));
  return r.ok ? c.json(r.row, 201) : bad(c, "could not save", 422);
});
revenueAdmin.patch("/admin/vat/payments/:id", async (c) => {
  const p = payment.partial().safeParse(await body(c));
  if (!p.success || !Object.keys(p.data).length) return bad(c, p.success ? "nothing to update" : zerr(p.error), 422);
  const rows = await c.get("store").update("vat_payments", [["id", "eq", c.req.param("id")]], p.data, c.get("actor"));
  return rows[0] ? c.json(rows[0]) : bad(c, "not found", 404);
});
revenueAdmin.delete("/admin/vat/payments/:id", async (c) => {
  const n = await c.get("store").remove("vat_payments", [["id", "eq", c.req.param("id")]], c.get("actor"));
  return n ? c.json({ ok: true }) : bad(c, "not found", 404);
});

// ---- grocery daily sales (manual entry; all B2C)
const day = z.object({
  sale_date: date, net_sales: money, vat_amount: money, credit_net: money.default(0), credit_vat: money.default(0),
  invoice_count: z.number().int().min(0).max(1e6).default(0), notes: z.string().max(500).nullable().optional(),
}).strict().refine((d) => d.vat_amount <= d.net_sales * 0.2 + 1, { message: "VAT looks too high for the net sales", path: ["vat_amount"] });

revenueAdmin.get("/admin/grocery-sales", async (c) => {
  const f: [string, "gte" | "lte", string][] = [];
  const { from, to } = c.req.query();
  if (from) f.push(["sale_date", "gte", from]);
  if (to) f.push(["sale_date", "lte", to]);
  return c.json((await c.get("store").select("grocery_sales_daily", { filters: f, order: ["sale_date", "desc"], limit: 1000 })).rows);
});
revenueAdmin.put("/admin/grocery-sales", async (c) => {
  const raw = await body(c);
  const list = z.array(day).min(1).max(400).safeParse(Array.isArray(raw) ? raw : [raw]);
  if (!list.success) return bad(c, zerr(list.error), 422);
  const actor = c.get("actor");
  const store = c.get("store");
  for (const d of list.data) await store.upsert("grocery_sales_daily", { ...d, entered_by: actor, updated_at: new Date().toISOString() }, "sale_date", actor);
  return c.json({ saved: list.data.length });
});
revenueAdmin.delete("/admin/grocery-sales/:date", async (c) => {
  const n = await c.get("store").remove("grocery_sales_daily", [["sale_date", "eq", c.req.param("date")]], c.get("actor"));
  return n ? c.json({ ok: true }) : bad(c, "not found", 404);
});

// ---- CSV export of invoices for a period (admin)
revenueAdmin.get("/admin/revenue/export", async (c) => {
  const { from, to } = c.req.query();
  if (!date.safeParse(from).success || !date.safeParse(to).success) return bad(c, "from and to (YYYY-MM-DD) are required", 422);
  const { rows } = await c.get("store").select("sales_invoices", { filters: [["invoice_date", "gte", from], ["invoice_date", "lte", to], ["state", "eq", "posted"]], order: ["invoice_date", "asc"], limit: 20000 });
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="sales-${from}_${to}.csv"`);
  return c.body(toCsv(rows.map(({ odoo_id, number, kind, invoice_date, salesman_name, customer_name, customer_vat, segment, amount_untaxed, amount_tax, amount_total, zatca_state }) => ({ odoo_id, number, kind, invoice_date, salesman_name, customer_name, customer_vat, segment, amount_untaxed, amount_tax, amount_total, zatca_state }))));
});

// ---------------------------------------------------------------- reviewers (admin + accounts)
export const reviewRoutes = new Hono<Vars>();
reviewRoutes.use("/review/*", async (c, next) => {
  const origin = env("ALLOWED_ORIGIN");
  return cors({ origin: origin ? origin.replace(/\/$/, "") : "", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PATCH", "OPTIONS"], maxAge: 600 })(c, next);
});
reviewRoutes.use("/review/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const m = (c.req.header("authorization") ?? "").match(/^Bearer (.+)$/i);
  if (!m) return c.json({ error: "missing bearer token" }, 401);
  const claims = await verifySupabaseJwt(m[1]);
  if (!claims) return c.json({ error: "invalid or expired token" }, 401);
  if (!rateLimit(`review:${claims.sub}`, 120, 60_000).ok) return c.json({ error: "rate limited" }, 429);
  const store = c.get("store") ?? getStore();
  const { rows } = await store.select("app_users", { filters: [["auth_user_id", "eq", claims.sub], ["active", "eq", true]], limit: 1 });
  const u = rows[0];
  if (!u || (u.role !== "admin" && u.role !== "accounts")) return c.json({ error: "forbidden" }, 403);
  c.set("reviewer", u); c.set("store", store); c.set("actor", String(claims.email ?? u.name ?? claims.sub));
  await next();
});

const ack = z.object({ status: z.enum(["open", "acknowledged", "resolved"]), note: z.string().trim().max(1000).optional() }).strict();
reviewRoutes.patch("/review/alerts/:id", async (c) => {
  const p = ack.safeParse(await body(c));
  if (!p.success) return bad(c, zerr(p.error), 422);
  if (p.data.status !== "open" && !p.data.note) return bad(c, "a short note is required to acknowledge or resolve an alert", 422);
  const raw = c.req.param("id");
  if (!/^[\w-]{1,64}$/.test(raw)) return bad(c, "invalid id", 400);
  const id = /^\d+$/.test(raw) ? Number(raw) : raw; // DB ids are numeric
  const actor = c.get("actor");
  const patch = p.data.status === "open" ? { status: "open", handled_by: null, handled_at: null } : { status: p.data.status, note: p.data.note, handled_by: actor, handled_at: new Date().toISOString() };
  const rows = await c.get("store").update("alerts", [["id", "eq", id]], patch, actor);
  return rows[0] ? c.json(rows[0]) : bad(c, "not found", 404);
});
