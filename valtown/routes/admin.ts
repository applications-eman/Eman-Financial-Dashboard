// Admin API: every request needs a valid Supabase JWT of an ACTIVE app_users row with role 'admin'.
// The user's identity is forwarded as x-actor so the DB audit trigger records who changed what.
import { Hono, type Context } from "npm:hono@4";
import { z } from "npm:zod@4.6.7";
import { cors } from "npm:hono@4/cors";
import { toCsv, toXls } from "../lib/csv.ts";
import { generateToken } from "../lib/crypto.ts";
import { env } from "../lib/env.ts";
import { resolveFields, saveExpense } from "../lib/expenses.ts";
import { verifySupabaseJwt } from "../lib/jwt.ts";
import { logger } from "../lib/log.ts";
import { rateLimit } from "../lib/ratelimit.ts";
import { type Filter, getStore, type Row, type Store } from "../lib/store.ts";
import { e164, isSection, SECTIONS, sectionTable } from "../lib/validate.ts";

type Vars = { Variables: { admin: Row; actor: string; store: Store } };
export const adminRoutes = new Hono<Vars>();

adminRoutes.use("/admin/*", async (c, next) => {
  const origin = env("ALLOWED_ORIGIN");
  return cors({
    origin: origin ? origin.replace(/\/$/, "") : "", // no ALLOWED_ORIGIN => no cross-origin access
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    maxAge: 600,
  })(c, next);
});

adminRoutes.use("/admin/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const m = (c.req.header("authorization") ?? "").match(/^Bearer (.+)$/i);
  if (!m) return c.json({ error: "missing bearer token" }, 401);
  const claims = await verifySupabaseJwt(m[1]);
  if (!claims) return c.json({ error: "invalid or expired token" }, 401);
  if (!rateLimit(`admin:${claims.sub}`, 300, 60_000).ok) return c.json({ error: "rate limited" }, 429);
  const store = c.get("store") ?? getStore();
  const { rows } = await store.select("app_users", { filters: [["auth_user_id", "eq", claims.sub], ["active", "eq", true]], limit: 1 });
  const u = rows[0];
  if (!u || u.role !== "admin") return c.json({ error: "forbidden" }, 403);
  c.set("admin", u);
  c.set("store", store);
  c.set("actor", String(claims.email ?? u.name ?? claims.sub));
  await next();
});

const bad = (c: Context, msg: string, status: 400 | 404 | 409 | 422 = 400) => c.json({ error: msg }, status);
const zerr = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
const body = async (c: Context) => { try { return await c.req.json(); } catch { return null; } };

adminRoutes.get("/admin/me", (c) => {
  const { id, name, role, sections } = c.get("admin");
  return c.json({ id, name, role, sections, actor: c.get("actor") });
});

// ---------------------------------------------------------------- expenses
const ALLOWED_PATCH = ["seller_name", "vat_number", "invoice_date", "total_amount", "vat_amount", "category", "notes", "status"] as const;
const patchSchema = z.object({
  seller_name: z.string().max(300), vat_number: z.string().regex(/^\d{15}$/), invoice_date: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  total_amount: z.number().min(0), vat_amount: z.number().min(0), category: z.string().max(100).nullable(), notes: z.string().max(1000).nullable(),
  status: z.enum(["new", "reviewed", "exported"]),
}).partial().strict();

function expenseFilters(q: Record<string, string>): Filter[] {
  const f: Filter[] = [];
  if (q.from) f.push(["invoice_date", "gte", q.from]);
  if (q.to) f.push(["invoice_date", "lte", q.to]);
  if (q.supplier) f.push(["seller_name", "ilike", `%${q.supplier.replace(/[%,()]/g, "")}%`]);
  if (q.category) f.push(["category", "eq", q.category]);
  if (q.status) f.push(["status", "eq", q.status]);
  if (q.submitter) f.push(["submitted_by", "eq", q.submitter]);
  if (q.source) f.push(["source", "eq", q.source]);
  return f;
}

adminRoutes.get("/admin/expenses/:section", async (c) => {
  const section = c.req.param("section");
  if (!isSection(section)) return bad(c, "unknown section", 404);
  const q = c.req.query();
  const limit = Math.min(Number(q.limit) || 50, 500);
  const { rows, count } = await c.get("store").select(sectionTable(section), {
    filters: expenseFilters(q), order: ["invoice_date", "desc"], limit, offset: Number(q.offset) || 0,
  });
  return c.json({ rows, count });
});

adminRoutes.post("/admin/expenses/:section", async (c) => {
  const section = c.req.param("section");
  if (!isSection(section)) return bad(c, "unknown section", 404);
  const b = await body(c);
  if (!b) return bad(c, "JSON body required");
  const res = await saveExpense(c.get("store"), section, b, { source: "admin_manual", submitted_by: c.get("admin").name, actor: c.get("actor") });
  return c.json(res, res.status === "saved" ? 201 : res.status === "duplicate" ? 409 : 422);
});

adminRoutes.post("/admin/expenses/:section/bulk-status", async (c) => {
  const section = c.req.param("section");
  if (!isSection(section)) return bad(c, "unknown section", 404);
  const p = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), status: z.enum(["new", "reviewed", "exported"]) }).safeParse(await body(c));
  if (!p.success) return bad(c, zerr(p.error));
  const rows = await c.get("store").update(sectionTable(section), [["id", "in", p.data.ids]], { status: p.data.status }, c.get("actor"));
  return c.json({ updated: rows.length });
});

adminRoutes.patch("/admin/expenses/:section/:id", async (c) => {
  const section = c.req.param("section");
  if (!isSection(section)) return bad(c, "unknown section", 404);
  const p = patchSchema.safeParse(await body(c));
  if (!p.success) return bad(c, zerr(p.error));
  const patch = Object.fromEntries(Object.entries(p.data).filter(([k]) => (ALLOWED_PATCH as readonly string[]).includes(k)));
  if (!Object.keys(patch).length) return bad(c, "nothing to update");
  try {
    const rows = await c.get("store").update(sectionTable(section), [["id", "eq", c.req.param("id")]], patch, c.get("actor"));
    return rows[0] ? c.json(rows[0]) : bad(c, "not found", 404);
  } catch (e) {
    return bad(c, "update rejected (check amounts / duplicate)", 422);
  }
});

adminRoutes.delete("/admin/expenses/:section/:id", async (c) => {
  const section = c.req.param("section");
  if (!isSection(section)) return bad(c, "unknown section", 404);
  const n = await c.get("store").remove(sectionTable(section), [["id", "eq", c.req.param("id")]], c.get("actor"));
  return n ? c.json({ deleted: n }) : bad(c, "not found", 404);
});

adminRoutes.get("/admin/expenses/:section/:id/image", async (c) => {
  const section = c.req.param("section");
  if (!isSection(section)) return bad(c, "unknown section", 404);
  const { rows } = await c.get("store").select(sectionTable(section), { filters: [["id", "eq", c.req.param("id")]], limit: 1 });
  const path = rows[0]?.image_path;
  if (!path) return bad(c, "no image", 404);
  const url = await c.get("store").signedUrl(path, 300);
  return url ? c.json({ url, expires_in: 300 }) : bad(c, "image unavailable", 404);
});

// ---------------------------------------------------------------- users & tokens
const userSchema = z.object({
  name: z.string().trim().min(1).max(100), phone_e164: e164.nullable().optional(), role: z.enum(["admin", "staff"]).default("staff"),
  sections: z.array(z.enum(SECTIONS)).default([]), active: z.boolean().default(true), auth_user_id: z.string().uuid().nullable().optional(),
});
const publicUser = ({ token_hash, ...u }: Row) => ({ ...u, has_token: Boolean(token_hash) });

adminRoutes.get("/admin/users", async (c) => {
  const { rows } = await c.get("store").select("app_users", { order: ["created_at", "desc"], limit: 500 });
  return c.json({ rows: rows.map(publicUser) });
});
adminRoutes.post("/admin/users", async (c) => {
  const p = userSchema.safeParse(await body(c));
  if (!p.success) return bad(c, zerr(p.error));
  const r = await c.get("store").insert("app_users", p.data, c.get("actor"));
  if (!r.ok) return r.conflict ? bad(c, "phone already registered", 409) : bad(c, "could not create user", 422);
  return c.json(publicUser(r.row), 201);
});
adminRoutes.patch("/admin/users/:id", async (c) => {
  const p = userSchema.partial().safeParse(await body(c));
  if (!p.success) return bad(c, zerr(p.error));
  const id = c.req.param("id");
  if (id === c.get("admin").id && (p.data.active === false || p.data.role === "staff")) return bad(c, "you cannot demote or deactivate yourself", 422);
  const rows = await c.get("store").update("app_users", [["id", "eq", id]], p.data, c.get("actor"));
  return rows[0] ? c.json(publicUser(rows[0])) : bad(c, "not found", 404);
});
adminRoutes.delete("/admin/users/:id", async (c) => {
  const id = c.req.param("id");
  if (id === c.get("admin").id) return bad(c, "you cannot delete yourself", 422);
  const n = await c.get("store").remove("app_users", [["id", "eq", id]], c.get("actor"));
  return n ? c.json({ deleted: n }) : bad(c, "not found", 404);
});
// Generate or rotate. The plaintext token is returned exactly once; only its hash is stored.
adminRoutes.post("/admin/users/:id/token", async (c) => {
  const { token, hash } = generateToken();
  const rows = await c.get("store").update("app_users", [["id", "eq", c.req.param("id")]], { token_hash: hash }, c.get("actor"));
  if (!rows[0]) return bad(c, "not found", 404);
  c.header("Cache-Control", "no-store");
  return c.json({ token, note: "Copy it now. It cannot be shown again." });
});
adminRoutes.delete("/admin/users/:id/token", async (c) => {
  const rows = await c.get("store").update("app_users", [["id", "eq", c.req.param("id")]], { token_hash: null }, c.get("actor"));
  return rows[0] ? c.json({ revoked: true }) : bad(c, "not found", 404);
});

// ---------------------------------------------------------------- categories, settings, flags
const catSchema = z.object({ section: z.enum(SECTIONS), name: z.string().trim().min(1).max(60), name_ar: z.string().trim().max(60).nullable().optional(), active: z.boolean().default(true) });
adminRoutes.get("/admin/categories", async (c) => c.json((await c.get("store").select("categories", { order: ["section", "asc"], limit: 1000 })).rows));
adminRoutes.post("/admin/categories", async (c) => {
  const p = catSchema.safeParse(await body(c));
  if (!p.success) return bad(c, zerr(p.error));
  const r = await c.get("store").insert("categories", p.data, c.get("actor"));
  return r.ok ? c.json(r.row, 201) : bad(c, r.conflict ? "category exists" : "rejected", r.conflict ? 409 : 422);
});
adminRoutes.patch("/admin/categories/:id", async (c) => {
  const p = catSchema.partial().safeParse(await body(c));
  if (!p.success) return bad(c, zerr(p.error));
  const rows = await c.get("store").update("categories", [["id", "eq", c.req.param("id")]], p.data, c.get("actor"));
  return rows[0] ? c.json(rows[0]) : bad(c, "not found", 404);
});
adminRoutes.delete("/admin/categories/:id", async (c) => {
  const n = await c.get("store").remove("categories", [["id", "eq", c.req.param("id")]], c.get("actor"));
  return n ? c.json({ deleted: n }) : bad(c, "not found", 404);
});

adminRoutes.get("/admin/settings", async (c) => c.json((await c.get("store").select("app_settings", { order: ["key", "asc"], limit: 500 })).rows));
adminRoutes.put("/admin/settings/:key", async (c) => {
  const key = c.req.param("key");
  if (!/^[a-z0-9_]{1,60}$/.test(key)) return bad(c, "invalid key");
  const b = (await body(c)) as { value?: unknown } | null;
  if (!b || !("value" in b)) return bad(c, "value required");
  if (key === "vat_rate" && !(typeof b.value === "number" && b.value >= 0 && b.value < 1)) return bad(c, "vat_rate must be a number between 0 and 1", 422);
  if (JSON.stringify(b.value).length > 20_000) return bad(c, "value too large", 422);
  const row = await c.get("store").upsert("app_settings", { key, value: b.value, updated_by: c.get("actor") }, "key", c.get("actor"));
  return c.json(row);
});

adminRoutes.get("/admin/flags", async (c) => c.json((await c.get("store").select("feature_flags", { order: ["key", "asc"], limit: 200 })).rows));
adminRoutes.put("/admin/flags/:key", async (c) => {
  const b = z.object({ enabled: z.boolean(), description: z.string().max(300).optional() }).safeParse(await body(c));
  if (!b.success) return bad(c, zerr(b.error));
  const row = await c.get("store").upsert("feature_flags", { key: c.req.param("key"), ...b.data }, "key", c.get("actor"));
  return c.json(row);
});

adminRoutes.get("/admin/audit", async (c) => {
  const q = c.req.query();
  const filters: Filter[] = [];
  if (q.table) filters.push(["table_name", "eq", q.table]);
  if (q.actor) filters.push(["actor", "ilike", `%${q.actor.replace(/[%,()]/g, "")}%`]);
  const { rows, count } = await c.get("store").select("audit_log", { filters, order: ["created_at", "desc"], limit: Math.min(Number(q.limit) || 100, 500), offset: Number(q.offset) || 0 });
  return c.json({ rows, count });
});

// ---------------------------------------------------------------- export
adminRoutes.get("/admin/export", async (c) => {
  const q = c.req.query();
  const sections = q.section && isSection(q.section) ? [q.section] : q.section ? [] : [...SECTIONS];
  if (!sections.length) return bad(c, "unknown section");
  const store = c.get("store");
  const all: Row[] = [];
  for (const s of sections) {
    const { rows } = await store.select(sectionTable(s), { filters: expenseFilters(q), order: ["invoice_date", "asc"], limit: 20000 });
    all.push(...rows.map((r) => ({ section: s, ...r })));
    if (q.mark_exported === "true" && rows.length) {
      await store.update(sectionTable(s), [["id", "in", rows.map((r) => r.id)], ["status", "neq", "exported"]], { status: "exported" }, c.get("actor"));
    }
  }
  const xls = q.format === "xls";
  logger.info("export", { rows: all.length, format: xls ? "xls" : "csv" });
  c.header("Content-Type", xls ? "application/vnd.ms-excel; charset=utf-8" : "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="expenses-${new Date().toISOString().slice(0, 10)}.${xls ? "xls" : "csv"}"`);
  return c.body(xls ? toXls(all) : toCsv(all));
});
