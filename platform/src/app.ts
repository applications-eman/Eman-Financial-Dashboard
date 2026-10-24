import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import { type Actor, type AuthCfg, actorFor, canDecideApprovals, canWrite, verifyToken } from "./auth.ts";
import type { Db } from "./db.ts";
import { msg } from "./invoicing/messages.ts";
import { queueHealth } from "./invoicing/ops.ts";
import { type InvoicingDeps, mountInvoicing } from "./invoicing/routes.ts";
import { makeLimiter } from "./ratelimit.ts";
import { isSafeTargetUrl } from "./ssrf.ts";
import { randomBytes } from "node:crypto";

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AppDeps {
  db: Db;
  auth: AuthCfg;
  allowedOrigins: string[];
  fetch?: typeof fetch;
  /** present when Odoo and WhatsApp are configured */
  invoicing?: InvoicingDeps;
  /** shown by /health, e.g. "on" or "off: <reason>" */
  invoicingStatus?: string;
}

type Vars = { Variables: { actor: Actor } };

const uuid = z.uuid();
const phoneIn = z.string().transform((s, ctx) => {
  const d = s.replace(/\D/g, "").replace(/^00/, "");
  if (!/^[0-9]{8,15}$/.test(d))
    ctx.addIssue({ code: "custom", message: "phone number must have 8 to 15 digits, with the country code" });
  return d;
});
const id40 = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/, "use small letters, digits, - or _ (2 to 41 characters)");

/** names are trimmed and inner spaces collapsed, so "Al  Noor " and "Al Noor" are the same name */
const nameIn = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(1, "name is required").max(max));
/** Saudi VAT number: 15 digits, starting and ending with 3 (ZATCA) */
const vatIn = z
  .string()
  .transform((v) => v.replace(/\s+/g, ""))
  .pipe(z.string().regex(/^3[0-9]{13}3$/, "VAT number must be 15 digits, starting and ending with 3"));

/** the same name (any capitals) must not exist twice */
async function assertNameFree(
  t: Db,
  table: "customers" | "products" | "product_categories",
  name: string,
  label: string,
  exceptId?: string,
) {
  const rows = await t.query(
    `select 1 from ${table} where lower(name)=lower($1) and ($2::uuid is null or id<>$2) limit 1`,
    [name, exceptId ?? null],
  );
  if (rows.length) throw new HttpError(409, "name_taken", `A ${label} named "${name}" already exists.`);
}

const SETTINGS: Record<string, z.ZodType> = {
  duplicate_window_minutes: z.number().int().min(1).max(1440),
  max_lines_per_invoice: z.number().int().min(1).max(100),
  kill_switch: z.boolean(),
  test_mode: z.boolean(),
  queue_alert_length: z.number().int().min(1).max(1000),
  queue_alert_wait_minutes: z.number().int().min(1).max(240),
  // the day the Odoo API key stops working (the platform warns 14 days before)
  odoo_key_expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

async function audit(
  t: Db,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
) {
  await t.query(`insert into audit_log (actor, action, entity, entity_id, before, after) values ($1,$2,$3,$4,$5,$6)`, [
    actor.email,
    action,
    entity,
    entityId,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
  ]);
}

const errorCode = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? String(e.code) : "");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isUniqueViolation = (e: unknown) =>
  errorCode(e) === "23505" || /duplicate key|unique constraint/i.test(errorText(e));
const isFkViolation = (e: unknown) => errorCode(e) === "23503" || /foreign key/i.test(errorText(e));

function customerAction(next: string | undefined, current: string) {
  if (!next || next === current) return "update";
  return next === "frozen" ? "freeze" : "unfreeze";
}

export function createApp(deps: AppDeps) {
  const app = new Hono<Vars>();
  const { db } = deps;

  app.use(
    "*",
    cors({
      origin: (o) => (deps.allowedOrigins.includes(o) ? o : null),
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true, invoicing: deps.invoicingStatus ?? (deps.invoicing ? "on" : "off") }));
  if (deps.invoicing) mountInvoicing(app, db, deps.invoicing);

  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.code, message: e.message }, e.status as 400);
    if (e instanceof z.ZodError)
      return c.json(
        {
          error: "invalid_input",
          message: e.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; "),
        },
        400,
      );
    console.error(JSON.stringify({ event: "error", message: errorText(e) }));
    return c.json({ error: "server_error", message: "Something went wrong. Nothing was changed." }, 500);
  });

  // ---- sign-in and permission for everything under /admin
  const adminLimit = makeLimiter(300, 60_000);
  app.use("/admin/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    // 300 calls a minute per caller: far above real use of the screens
    const caller = (c.req.header("x-forwarded-for") ?? "local").split(",")[0].trim();
    if (!adminLimit(caller)) throw new HttpError(429, "too_many_requests", "Too many requests. Please wait a minute.");
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer /i, "");
    const claims = token ? await verifyToken(token, deps.auth) : null;
    if (!claims) throw new HttpError(401, "unauthorized", "Please sign in again.");
    const actor = await actorFor(db, claims);
    if (!actor) throw new HttpError(403, "not_allowed", "Your account is not allowed to use the platform.");
    const deciding =
      c.req.method === "POST" &&
      /^\/admin\/approvals\/[^/]+\/decide$/.test(c.req.path) &&
      canDecideApprovals(actor.role);
    if (c.req.method !== "GET" && !canWrite(actor.role) && !deciding)
      throw new HttpError(403, "read_only", "Your role can view but not change.");
    c.set("actor", actor);
    await next();
  });

  const body = async <T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T): Promise<z.infer<T>> =>
    schema.parse(await c.req.json().catch(() => ({})));

  app.get("/admin/me", (c) => c.json(c.get("actor")));

  app.get("/admin/summary", async (c) => {
    const [s] = await db.query(`select
      (select count(*)::int from salesmen where status='active') as salesmen_active,
      (select count(*)::int from salesmen where status='inactive') as salesmen_inactive,
      (select count(*)::int from salesmen where status='frozen') as salesmen_frozen,
      (select count(*)::int from wa_targets where enabled) as services_on,
      (select count(*)::int from wa_numbers where enabled) as numbers_on,
      (select count(*)::int from customers where status='active') as customers_active,
      (select count(*)::int from products where status='active') as products_active,
      (select count(*)::int from products where status='active' and max_price is null) as products_without_limit`);
    return c.json(s);
  });

  // ================================================================ services (router targets)
  app.get("/admin/targets", async (c) =>
    c.json(
      await db.query(`select t.id, t.name, t.url, t.enabled, t.is_default, t.notes, (t.secret is not null) as has_secret, t.created_at,
      (select count(*)::int from wa_numbers n where n.target_id = t.id) as numbers from wa_targets t order by t.name`),
    ),
  );

  app.post("/admin/targets", async (c) => {
    const actor = c.get("actor");
    const b = await body(
      c,
      z.object({
        id: id40,
        name: nameIn(80),
        url: z.string().max(500),
        notes: z.string().max(500).optional(),
      }),
    );
    if (!isSafeTargetUrl(b.url))
      throw new HttpError(
        400,
        "unsafe_url",
        "The address must be a public https address (no IP numbers, no internal names).",
      );
    const secret = randomBytes(24).toString("hex");
    try {
      await db.tx(async (t) => {
        const dupName = await t.query(`select 1 from wa_targets where lower(name)=lower($1) limit 1`, [b.name]);
        if (dupName.length) throw new HttpError(409, "name_taken", `A service named "${b.name}" already exists.`);
        await t.query(`insert into wa_targets (id, name, url, secret, notes) values ($1,$2,$3,$4,$5)`, [
          b.id,
          b.name,
          b.url,
          secret,
          b.notes ?? null,
        ]);
        await audit(t, actor, "create", "wa_target", b.id, null, { name: b.name, url: b.url });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, "exists", "A service with this id already exists.");
      throw e;
    }
    // the secret is shown ONCE: the service must check this value in the X-Router-Secret header
    return c.json({ id: b.id, secret }, 201);
  });

  app.patch("/admin/targets/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const b = await body(
      c,
      z.object({
        name: nameIn(80).optional(),
        url: z.string().max(500).optional(),
        enabled: z.boolean().optional(),
        notes: z.string().max(500).nullable().optional(),
        /** receives every sender no service has claimed (only one service can be the default) */
        is_default: z.boolean().optional(),
      }),
    );
    if (b.url !== undefined && !isSafeTargetUrl(b.url))
      throw new HttpError(
        400,
        "unsafe_url",
        "The address must be a public https address (no IP numbers, no internal names).",
      );
    const out = await db.tx(async (t) => {
      const [before] = await t.query(
        `select id, name, url, enabled, is_default, notes from wa_targets where id=$1 for update`,
        [id],
      );
      if (!before) throw new HttpError(404, "not_found", "Service not found.");
      if (b.is_default === true)
        await t.query(`update wa_targets set is_default=false where id<>$1 and is_default`, [id]);
      const [after] = await t.query(
        `update wa_targets set name=coalesce($2,name), url=coalesce($3,url), enabled=coalesce($4,enabled), is_default=coalesce($7,is_default),
           notes=case when $5::boolean then $6 else notes end where id=$1 returning id, name, url, enabled, is_default, notes`,
        [
          id,
          b.name ?? null,
          b.url ?? null,
          b.enabled ?? null,
          b.notes !== undefined,
          b.notes ?? null,
          b.is_default ?? null,
        ],
      );
      await audit(t, actor, "update", "wa_target", id, before, after);
      return after;
    });
    return c.json(out);
  });

  app.post("/admin/targets/:id/rotate-secret", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const secret = randomBytes(24).toString("hex");
    await db.tx(async (t) => {
      const r = await t.query(`update wa_targets set secret=$2 where id=$1 returning id`, [id, secret]);
      if (!r.length) throw new HttpError(404, "not_found", "Service not found.");
      await audit(t, actor, "rotate_secret", "wa_target", id, null, null);
    });
    return c.json({ id, secret });
  });

  // reachability check: any answer below 500 means the address is alive
  app.post("/admin/targets/:id/test", async (c) => {
    const [t] = await db.query<{ url: string }>(`select url from wa_targets where id=$1`, [c.req.param("id")]);
    if (!t) throw new HttpError(404, "not_found", "Service not found.");
    if (!isSafeTargetUrl(t.url)) throw new HttpError(400, "unsafe_url", "The saved address is not allowed.");
    const started = Date.now();
    try {
      const r = await (deps.fetch ?? fetch)(t.url, { method: "GET", signal: AbortSignal.timeout(6000) });
      return c.json({ reachable: r.status < 500, status: r.status, ms: Date.now() - started });
    } catch (e) {
      return c.json({
        reachable: false,
        status: 0,
        ms: Date.now() - started,
        error: errorText(e),
      });
    }
  });

  app.delete("/admin/targets/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    await db.tx(async (t) => {
      const [n] = await t.query<{ n: number }>(`select count(*)::int as n from wa_numbers where target_id=$1`, [id]);
      if (n.n > 0)
        throw new HttpError(409, "in_use", `This service still owns ${n.n} number(s). Move or remove them first.`);
      const r = await t.query(`delete from wa_targets where id=$1 returning id, name, url`, [id]);
      if (!r.length) throw new HttpError(404, "not_found", "Service not found.");
      await audit(t, actor, "delete", "wa_target", id, r[0], null);
    });
    return c.json({ ok: true });
  });

  // ================================================================ WhatsApp numbers
  app.get("/admin/numbers", async (c) =>
    c.json(
      await db.query(`select n.phone, n.target_id, t.name as target_name, n.label, n.enabled, s.name as salesman_name, s.status as salesman_status, n.created_at
      from wa_numbers n join wa_targets t on t.id = n.target_id left join salesmen s on s.phone = n.phone order by n.phone`),
    ),
  );

  app.post("/admin/numbers", async (c) => {
    const actor = c.get("actor");
    const b = await body(c, z.object({ phone: phoneIn, target_id: id40, label: z.string().max(80).optional() }));
    await db.tx(async (t) => {
      const [owner] = await t.query<{ target_id: string }>(`select target_id from wa_numbers where phone=$1`, [
        b.phone,
      ]);
      if (owner)
        throw new HttpError(
          409,
          "number_taken",
          `This number already belongs to the service "${owner.target_id}". One number can belong to one service only.`,
        );
      const [tg] = await t.query(`select id from wa_targets where id=$1`, [b.target_id]);
      if (!tg) throw new HttpError(400, "unknown_service", "That service does not exist.");
      await t.query(`insert into wa_numbers (phone, target_id, label) values ($1,$2,$3)`, [
        b.phone,
        b.target_id,
        b.label ?? null,
      ]);
      await audit(t, actor, "create", "wa_number", b.phone, null, { target_id: b.target_id, label: b.label ?? null });
    });
    return c.json({ phone: b.phone }, 201);
  });

  app.patch("/admin/numbers/:phone", async (c) => {
    const actor = c.get("actor");
    const phone = c.req.param("phone");
    const b = await body(
      c,
      z.object({
        target_id: id40.optional(),
        enabled: z.boolean().optional(),
        label: z.string().max(80).nullable().optional(),
      }),
    );
    const out = await db.tx(async (t) => {
      const [before] = await t.query<{ target_id: string }>(
        `select phone, target_id, label, enabled from wa_numbers where phone=$1 for update`,
        [phone],
      );
      if (!before) throw new HttpError(404, "not_found", "Number not found.");
      if (b.target_id && b.target_id !== before.target_id) {
        const [s] = await t.query(`select id from salesmen where phone=$1`, [phone]);
        if (s)
          throw new HttpError(409, "in_use", "This number belongs to a salesman. Change it from the salesman page.");
      }
      const [after] = await t.query(
        `update wa_numbers set target_id=coalesce($2,target_id), enabled=coalesce($3,enabled), label=case when $4::boolean then $5 else label end where phone=$1 returning phone, target_id, label, enabled`,
        [phone, b.target_id ?? null, b.enabled ?? null, b.label !== undefined, b.label ?? null],
      );
      await audit(t, actor, "update", "wa_number", phone, before, after);
      return after;
    });
    return c.json(out);
  });

  app.delete("/admin/numbers/:phone", async (c) => {
    const actor = c.get("actor");
    const phone = c.req.param("phone");
    await db.tx(async (t) => {
      const [s] = await t.query(`select id from salesmen where phone=$1`, [phone]);
      if (s) throw new HttpError(409, "in_use", "This number belongs to a salesman. Remove the salesman first.");
      const r = await t.query(`delete from wa_numbers where phone=$1 returning phone, target_id`, [phone]);
      if (!r.length) throw new HttpError(404, "not_found", "Number not found.");
      await audit(t, actor, "delete", "wa_number", phone, r[0], null);
    });
    return c.json({ ok: true });
  });

  // ================================================================ salesmen
  const INVOICING = "invoicing";

  app.get("/admin/salesmen", async (c) =>
    c.json(
      await db.query(`select s.id, s.code, s.name, s.phone, s.language, s.status, s.daily_limit, s.activated_at, s.activated_by, s.created_at,
      (select count(*)::int from salesman_customers sc where sc.salesman_id = s.id) as customers from salesmen s order by s.name`),
    ),
  );

  app.post("/admin/salesmen", async (c) => {
    const actor = c.get("actor");
    const b = await body(
      c,
      z.object({
        code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,30}$/, "use capital letters, digits, - or _"),
        name: nameIn(80),
        phone: phoneIn,
        language: z.enum(["en", "ml"]).default("en"),
        daily_limit: z.number().int().positive().nullable().optional(),
      }),
    );
    const out = await db.tx(async (t) => {
      const [tg] = await t.query(`select id from wa_targets where id=$1`, [INVOICING]);
      if (!tg)
        throw new HttpError(
          409,
          "no_invoicing_service",
          `Add the service with id "${INVOICING}" first (Connected services).`,
        );
      const [owner] = await t.query<{ target_id: string }>(`select target_id from wa_numbers where phone=$1`, [
        b.phone,
      ]);
      if (owner && owner.target_id !== INVOICING)
        throw new HttpError(
          409,
          "number_taken",
          `This number already belongs to the service "${owner.target_id}". One number can belong to one service only.`,
        );
      if (!owner)
        await t.query(`insert into wa_numbers (phone, target_id, label, enabled) values ($1,$2,$3,false)`, [
          b.phone,
          INVOICING,
          b.name,
        ]);
      try {
        const [row] = await t.query(
          `insert into salesmen (code, name, phone, language, daily_limit) values ($1,$2,$3,$4,$5) returning id, code, name, phone, language, status, daily_limit`,
          [b.code, b.name, b.phone, b.language, b.daily_limit ?? null],
        );
        await audit(t, actor, "create", "salesman", row.id, null, row);
        return row;
      } catch (e) {
        if (isUniqueViolation(e))
          throw new HttpError(409, "exists", "A salesman with this code or number already exists.");
        throw e;
      }
    });
    return c.json(out, 201);
  });

  app.patch("/admin/salesmen/:id", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    const b = await body(
      c,
      z.object({
        name: nameIn(80).optional(),
        language: z.enum(["en", "ml"]).optional(),
        daily_limit: z.number().int().positive().nullable().optional(),
      }),
    );
    const out = await db.tx(async (t) => {
      const [before] = await t.query(
        `select id, code, name, language, daily_limit from salesmen where id=$1 for update`,
        [id],
      );
      if (!before) throw new HttpError(404, "not_found", "Salesman not found.");
      const [after] = await t.query(
        `update salesmen set name=coalesce($2,name), language=coalesce($3,language), daily_limit=case when $4::boolean then $5 else daily_limit end where id=$1 returning id, code, name, language, daily_limit`,
        [id, b.name ?? null, b.language ?? null, b.daily_limit !== undefined, b.daily_limit ?? null],
      );
      await audit(t, actor, "update", "salesman", id, before, after);
      return after;
    });
    return c.json(out);
  });

  // Activate / freeze / unfreeze. Freezing takes effect immediately: the router stops forwarding his number.
  const setStatus = (path: string, to: "active" | "frozen", from: string[], numberEnabled: boolean) =>
    app.post(`/admin/salesmen/:id/${path}`, async (c) => {
      const actor = c.get("actor");
      const id = uuid.parse(c.req.param("id"));
      const out = await db.tx(async (t) => {
        const [s] = await t.query<{ status: string; phone: string; name: string }>(
          `select status, phone, name from salesmen where id=$1 for update`,
          [id],
        );
        if (!s) throw new HttpError(404, "not_found", "Salesman not found.");
        if (!from.includes(s.status))
          throw new HttpError(409, "wrong_state", `This salesman is "${s.status}"; that action is not possible now.`);
        const warnings: string[] = [];
        if (to === "active") {
          const [n] = await t.query<{ target_id: string; tenabled: boolean }>(
            `select n.target_id, t.enabled as tenabled from wa_numbers n join wa_targets t on t.id=n.target_id where n.phone=$1`,
            [s.phone],
          );
          if (!n || n.target_id !== INVOICING)
            throw new HttpError(409, "number_not_invoicing", "His number is not connected to the invoicing service.");
          if (!n.tenabled) throw new HttpError(409, "service_off", "The invoicing service is switched off.");
          const [cnt] = await t.query<{ n: number }>(
            `select count(*)::int as n from salesman_customers where salesman_id=$1`,
            [id],
          );
          if (cnt.n === 0)
            warnings.push("No customers are assigned to him yet; he will see 'no customers' until you add some.");
        }
        await t.query(
          `update salesmen set status=$2, activated_at=case when $2='active' and activated_at is null then now() else activated_at end, activated_by=case when $2='active' and activated_by is null then $3 else activated_by end where id=$1`,
          [id, to, actor.email],
        );
        await t.query(`update wa_numbers set enabled=$2 where phone=$1`, [s.phone, numberEnabled]);
        await audit(t, actor, path, "salesman", id, { status: s.status }, { status: to });
        return { id, status: to, warnings };
      });
      return c.json(out);
    });
  setStatus("activate", "active", ["inactive", "frozen"], true);
  setStatus("freeze", "frozen", ["active", "inactive"], false);

  app.delete("/admin/salesmen/:id", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    await db.tx(async (t) => {
      const [s] = await t.query<{ phone: string; status: string }>(
        `select phone, status from salesmen where id=$1 for update`,
        [id],
      );
      if (!s) throw new HttpError(404, "not_found", "Salesman not found.");
      if (s.status === "active") throw new HttpError(409, "wrong_state", "Freeze him first.");
      try {
        await t.query(`delete from salesmen where id=$1`, [id]);
      } catch (e) {
        if (isFkViolation(e))
          throw new HttpError(409, "has_history", "He has invoice history. Freeze him instead of deleting.");
        throw e;
      }
      await t.query(`delete from wa_numbers where phone=$1 and target_id=$2`, [s.phone, INVOICING]);
      await audit(t, actor, "delete", "salesman", id, s, null);
    });
    return c.json({ ok: true });
  });

  // ================================================================ customers and who may invoice whom
  app.get("/admin/customers", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const rows = await db.query(
      `select c.id, c.name, c.vat, c.status, c.odoo_partner_id,
        (select count(*)::int from salesman_customers sc where sc.customer_id = c.id) as salesmen
        from customers c where ($1 = '' or lower(c.name) like '%' || lower($1) || '%' or c.vat like $1 || '%') and ($2::text is null or c.status = $2)
        order by lower(c.name) limit $3 offset $4`,
      [q, status ?? null, limit, offset],
    );
    return c.json(rows);
  });

  app.post("/admin/customers", async (c) => {
    const actor = c.get("actor");
    const b = await body(
      c,
      z.object({
        name: nameIn(200),
        vat: vatIn.nullable().optional(),
        odoo_partner_id: z.number().int().positive().nullable().optional(),
      }),
    );
    try {
      const out = await db.tx(async (t) => {
        await assertNameFree(t, "customers", b.name, "customer");
        if (b.vat) {
          const dup = await t.query(`select name from customers where vat=$1 limit 1`, [b.vat]);
          if (dup.length)
            throw new HttpError(409, "vat_taken", `The customer "${dup[0].name}" already has this VAT number.`);
        }
        const [row] = await t.query(
          `insert into customers (name, vat, odoo_partner_id) values ($1,$2,$3) returning id, name, vat, status, odoo_partner_id`,
          [b.name, b.vat ?? null, b.odoo_partner_id ?? null],
        );
        await audit(t, actor, "create", "customer", row.id, null, row);
        return row;
      });
      return c.json(out, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, "exists", "A customer with this Odoo record already exists.");
      throw e;
    }
  });

  app.patch("/admin/customers/:id", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    const b = await body(
      c,
      z.object({
        name: nameIn(200).optional(),
        vat: vatIn.nullable().optional(),
        status: z.enum(["active", "frozen"]).optional(),
      }),
    );
    const out = await db.tx(async (t) => {
      const [before] = await t.query(`select id, name, vat, status from customers where id=$1 for update`, [id]);
      if (!before) throw new HttpError(404, "not_found", "Customer not found.");
      if (b.name) await assertNameFree(t, "customers", b.name, "customer", id);
      if (b.vat) {
        const dup = await t.query(`select name from customers where vat=$1 and id<>$2 limit 1`, [b.vat, id]);
        if (dup.length)
          throw new HttpError(409, "vat_taken", `The customer "${dup[0].name}" already has this VAT number.`);
      }
      const [after] = await t.query(
        `update customers set name=coalesce($2,name), vat=case when $3::boolean then $4 else vat end, status=coalesce($5,status) where id=$1 returning id, name, vat, status`,
        [id, b.name ?? null, b.vat !== undefined, b.vat ?? null, b.status ?? null],
      );
      await audit(t, actor, customerAction(b.status, before.status), "customer", id, before, after);
      return after;
    });
    return c.json(out);
  });

  // Delete a customer that was added by mistake. A customer with invoice history is frozen instead.
  app.delete("/admin/customers/:id", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    await db.tx(async (t) => {
      let row: Record<string, unknown> | undefined;
      try {
        [row] = await t.query(`delete from customers where id=$1 returning id, name, vat`, [id]);
      } catch (e) {
        if (isFkViolation(e))
          throw new HttpError(
            409,
            "has_history",
            "This customer has invoice history. Switch it off (Active) instead of deleting.",
          );
        throw e;
      }
      if (!row) throw new HttpError(404, "not_found", "Customer not found.");
      await audit(t, actor, "delete", "customer", id, row, null);
    });
    return c.json({ ok: true });
  });

  app.get("/admin/salesmen/:id/customers", async (c) =>
    c.json(
      await db.query(
        `select c.id, c.name, c.vat, c.status, sc.source from salesman_customers sc join customers c on c.id = sc.customer_id where sc.salesman_id = $1 order by lower(c.name)`,
        [uuid.parse(c.req.param("id"))],
      ),
    ),
  );

  // replaces the whole list of customers of one salesman
  app.put("/admin/salesmen/:id/customers", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    const b = await body(c, z.object({ customer_ids: z.array(uuid).max(2000) }));
    const ids = [...new Set(b.customer_ids)];
    await db.tx(async (t) => {
      const [s] = await t.query(`select id from salesmen where id=$1 for update`, [id]);
      if (!s) throw new HttpError(404, "not_found", "Salesman not found.");
      const found = await t.query<{ id: string }>(`select id from customers where id = any($1::uuid[])`, [ids]);
      if (found.length !== ids.length) throw new HttpError(400, "unknown_customer", "Some customers do not exist.");
      const [before] = await t.query<{ n: number }>(
        `select count(*)::int as n from salesman_customers where salesman_id=$1`,
        [id],
      );
      await t.query(`delete from salesman_customers where salesman_id=$1 and not (customer_id = any($2::uuid[]))`, [
        id,
        ids,
      ]);
      await t.query(
        `insert into salesman_customers (salesman_id, customer_id) select $1, x from unnest($2::uuid[]) x on conflict do nothing`,
        [id, ids],
      );
      await audit(t, actor, "set_customers", "salesman", id, { count: before.n }, { count: ids.length });
    });
    return c.json({ count: ids.length });
  });

  // ================================================================ categories and products (with price limits)
  app.get("/admin/categories", async (c) =>
    c.json(
      await db.query(
        `select c.id, c.name, c.sort_order, c.active, (select count(*)::int from products p where p.category_id = c.id) as products from product_categories c order by c.sort_order, c.name`,
      ),
    ),
  );

  app.post("/admin/categories", async (c) => {
    const actor = c.get("actor");
    const b = await body(c, z.object({ name: nameIn(60), sort_order: z.number().int().default(0) }));
    try {
      const out = await db.tx(async (t) => {
        await assertNameFree(t, "product_categories", b.name, "category");
        const [row] = await t.query(
          `insert into product_categories (name, sort_order) values ($1,$2) returning id, name, sort_order, active`,
          [b.name, b.sort_order],
        );
        await audit(t, actor, "create", "category", row.id, null, row);
        return row;
      });
      return c.json(out, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, "exists", "A category with this name already exists.");
      throw e;
    }
  });

  app.patch("/admin/categories/:id", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    const b = await body(
      c,
      z.object({
        name: nameIn(60).optional(),
        sort_order: z.number().int().optional(),
        active: z.boolean().optional(),
      }),
    );
    const out = await db.tx(async (t) => {
      const [before] = await t.query(
        `select id, name, sort_order, active from product_categories where id=$1 for update`,
        [id],
      );
      if (!before) throw new HttpError(404, "not_found", "Category not found.");
      if (b.name) await assertNameFree(t, "product_categories", b.name, "category", id);
      const [after] = await t.query(
        `update product_categories set name=coalesce($2,name), sort_order=coalesce($3,sort_order), active=coalesce($4,active) where id=$1 returning id, name, sort_order, active`,
        [id, b.name ?? null, b.sort_order ?? null, b.active ?? null],
      );
      await audit(t, actor, "update", "category", id, before, after);
      return after;
    });
    return c.json(out);
  });

  app.get("/admin/products", async (c) =>
    c.json(
      await db.query(
        `select p.id, p.name, p.max_price, p.status, p.odoo_product_id, p.category_id, c.name as category, p.image from products p left join product_categories c on c.id = p.category_id order by coalesce(c.sort_order, 9999), lower(p.name)`,
      ),
    ),
  );

  const price = z.number().positive().max(1_000_000).multipleOf(0.01);

  app.post("/admin/products", async (c) => {
    const actor = c.get("actor");
    const b = await body(
      c,
      z.object({
        name: nameIn(120),
        category_id: uuid.nullable().optional(),
        max_price: price.nullable().optional(),
        odoo_product_id: z.number().int().positive().nullable().optional(),
      }),
    );
    try {
      const out = await db.tx(async (t) => {
        await assertNameFree(t, "products", b.name, "product");
        const [row] = await t.query(
          `insert into products (name, category_id, max_price, odoo_product_id) values ($1,$2,$3,$4) returning id, name, category_id, max_price, status`,
          [b.name, b.category_id ?? null, b.max_price ?? null, b.odoo_product_id ?? null],
        );
        if (row.max_price != null)
          await t.query(
            `insert into product_price_history (product_id, old_max, new_max, changed_by) values ($1,null,$2,$3)`,
            [row.id, row.max_price, actor.email],
          );
        await audit(t, actor, "create", "product", row.id, null, row);
        return row;
      });
      return c.json(out, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, "exists", "A product with this Odoo record already exists.");
      if (isFkViolation(e)) throw new HttpError(400, "unknown_category", "That category does not exist.");
      throw e;
    }
  });

  app.patch("/admin/products/:id", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    const b = await body(
      c,
      z.object({
        name: nameIn(120).optional(),
        category_id: uuid.nullable().optional(),
        max_price: price.nullable().optional(),
        status: z.enum(["active", "frozen"]).optional(),
      }),
    );
    const out = await db.tx(async (t) => {
      const [before] = await t.query<{ max_price: string | null }>(
        `select id, name, category_id, max_price, status from products where id=$1 for update`,
        [id],
      );
      if (!before) throw new HttpError(404, "not_found", "Product not found.");
      if (b.name) await assertNameFree(t, "products", b.name, "product", id);
      const [after] = await t.query<{ max_price: string | null }>(
        `update products set name=coalesce($2,name), category_id=case when $3::boolean then $4 else category_id end, max_price=case when $5::boolean then $6 else max_price end, status=coalesce($7,status) where id=$1 returning id, name, category_id, max_price, status`,
        [
          id,
          b.name ?? null,
          b.category_id !== undefined,
          b.category_id ?? null,
          b.max_price !== undefined,
          b.max_price ?? null,
          b.status ?? null,
        ],
      );
      if (b.max_price !== undefined && String(before.max_price) !== String(after.max_price)) {
        await t.query(
          `insert into product_price_history (product_id, old_max, new_max, changed_by) values ($1,$2,$3,$4)`,
          [id, before.max_price, after.max_price, actor.email],
        );
      }
      await audit(t, actor, "update", "product", id, before, after);
      return after;
    });
    return c.json(out);
  });

  // a small picture for the WhatsApp product list: JPEG or PNG, at most 20 KB (the dashboard shrinks it first)
  const MAX_IMAGE_BYTES = 20_000;
  app.put("/admin/products/:id/image", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    const { image } = await body(
      c,
      z.object({
        image: z
          .string()
          .regex(/^[A-Za-z0-9+/]+={0,2}$/)
          .max(40000),
      }),
    );
    const bytes = Buffer.from(image, "base64");
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (!isJpeg && !isPng) throw new HttpError(400, "bad_image", "The picture must be a JPEG or PNG.");
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new HttpError(
        400,
        "image_too_big",
        `The picture is ${Math.ceil(bytes.length / 1000)} KB; the limit is 20 KB.`,
      );
    await db.tx(async (t) => {
      const [row] = await t.query(`update products set image=$2 where id=$1 returning id, name`, [id, image]);
      if (!row) throw new HttpError(404, "not_found", "Product not found.");
      await audit(t, actor, "set_image", "product", id, null, { bytes: bytes.length });
    });
    return c.json({ ok: true, bytes: bytes.length });
  });

  app.delete("/admin/products/:id/image", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    await db.tx(async (t) => {
      const [row] = await t.query(`update products set image=null where id=$1 returning id`, [id]);
      if (!row) throw new HttpError(404, "not_found", "Product not found.");
      await audit(t, actor, "remove_image", "product", id, null, null);
    });
    return c.json({ ok: true });
  });

  app.delete("/admin/products/:id", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    await db.tx(async (t) => {
      const [row] = await t.query(`delete from products where id=$1 returning id, name`, [id]);
      if (!row) throw new HttpError(404, "not_found", "Product not found.");
      await audit(t, actor, "delete", "product", id, row, null);
    });
    return c.json({ ok: true });
  });

  app.get("/admin/products/:id/history", async (c) =>
    c.json(
      await db.query(
        `select old_max, new_max, changed_by, changed_at from product_price_history where product_id=$1 order by changed_at desc, id desc limit 200`,
        [uuid.parse(c.req.param("id"))],
      ),
    ),
  );

  // Excel / CSV upload (the screen turns the file into rows). Matches products by name; creates missing ones and categories.
  app.post("/admin/products/bulk", async (c) => {
    const actor = c.get("actor");
    const b = await body(
      c,
      z.object({
        rows: z
          .array(
            z.object({
              name: nameIn(120),
              category: z.string().max(60).optional(),
              max_price: price.nullable().optional(),
            }),
          )
          .min(1)
          .max(1000),
      }),
    );
    const res = await db.tx(async (t) => {
      let created = 0,
        updated = 0,
        priceChanges = 0;
      for (const r of b.rows) {
        let categoryId: string | null = null;
        if (r.category?.trim()) {
          const catName = r.category.trim().replace(/\s+/g, " ");
          const [found] = await t.query<{ id: string }>(
            `select id from product_categories where lower(name)=lower($1)`,
            [catName],
          );
          const cat =
            found ??
            (
              await t.query<{ id: string }>(`insert into product_categories (name) values ($1) returning id`, [catName])
            )[0];
          categoryId = cat.id;
        }
        const [existing] = await t.query<{ id: string; max_price: string | null }>(
          `select id, max_price from products where lower(name)=lower($1) for update`,
          [r.name.trim()],
        );
        if (!existing) {
          const [row] = await t.query<{ id: string }>(
            `insert into products (name, category_id, max_price) values ($1,$2,$3) returning id`,
            [r.name.trim(), categoryId, r.max_price ?? null],
          );
          if (r.max_price != null)
            await t.query(
              `insert into product_price_history (product_id, old_max, new_max, changed_by) values ($1,null,$2,$3)`,
              [row.id, r.max_price, actor.email],
            );
          created++;
        } else {
          await t.query(
            `update products set category_id=coalesce($2,category_id), max_price=case when $3::boolean then $4 else max_price end where id=$1`,
            [existing.id, categoryId, r.max_price !== undefined, r.max_price ?? null],
          );
          if (
            r.max_price !== undefined &&
            String(existing.max_price) !== (r.max_price == null ? "null" : r.max_price.toFixed(2))
          ) {
            await t.query(
              `insert into product_price_history (product_id, old_max, new_max, changed_by) values ($1,$2,$3,$4)`,
              [existing.id, existing.max_price, r.max_price ?? null, actor.email],
            );
            priceChanges++;
          }
          updated++;
        }
      }
      await audit(t, actor, "bulk_upload", "product", null, null, {
        rows: b.rows.length,
        created,
        updated,
        priceChanges,
      });
      return { created, updated, priceChanges };
    });
    return c.json(res);
  });

  // ================================================================ Odoo connection, invoices, approvals
  app.get("/admin/odoo/status", async (c) => {
    if (!deps.invoicing) return c.json({ configured: false });
    try {
      return c.json({ configured: true, company: await deps.invoicing.odoo.ping() });
    } catch (e) {
      return c.json({ configured: true, error: errorText(e) });
    }
  });

  // Links customers and products to their Odoo records (by VAT number, then exact name). Ambiguous or missing ones are listed.
  app.post("/admin/odoo/link", async (c) => {
    const actor = c.get("actor");
    if (!deps.invoicing) throw new HttpError(409, "odoo_not_configured", "Odoo is not connected to the platform yet.");
    const odoo = deps.invoicing.odoo;
    const result = {
      customers: { linked: 0, unmatched: [] as string[] },
      products: { linked: 0, unmatched: [] as string[] },
    };
    const customers = await db.query<{ id: string; name: string; vat: string | null }>(
      `select id, name, vat from customers where odoo_partner_id is null and status='active' order by name limit 500`,
    );
    for (const r of customers) {
      const id = await odoo.findPartner({ vat: r.vat, name: r.name });
      try {
        if (!id) throw new Error("none");
        await db.query(`update customers set odoo_partner_id=$2, synced_at=now() where id=$1`, [r.id, id]);
        result.customers.linked++;
      } catch {
        result.customers.unmatched.push(r.name);
      }
    }
    const products = await db.query<{ id: string; name: string }>(
      `select id, name from products where odoo_product_id is null and status='active' order by name limit 500`,
    );
    for (const r of products) {
      const id = await odoo.findProduct(r.name);
      try {
        if (!id) throw new Error("none");
        await db.query(`update products set odoo_product_id=$2 where id=$1`, [r.id, id]);
        result.products.linked++;
      } catch {
        result.products.unmatched.push(r.name);
      }
    }
    await db.tx((t) =>
      audit(t, actor, "link_odoo", "odoo", null, null, {
        customers: result.customers.linked,
        products: result.products.linked,
      }),
    );
    return c.json(result);
  });

  app.get("/admin/requests", async (c) => {
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
    return c.json(
      await db.query(
        `select r.id, r.ref_code, s.name as salesman, c.name as customer, r.total, r.status, r.invoice_number, r.zatca_status,
                r.error_code, r.error_detail, r.attempts, r.created_at, r.finished_at
           from invoice_requests r join salesmen s on s.id = r.salesman_id join customers c on c.id = r.customer_id
          where ($1::text is null or r.status = $1) order by r.created_at desc limit $2`,
        [status ?? null, limit],
      ),
    );
  });

  app.get("/admin/requests/:id/events", async (c) =>
    c.json(
      await db.query(`select at, kind, detail from invoice_request_events where request_id=$1 order by id`, [
        uuid.parse(c.req.param("id")),
      ]),
    ),
  );

  app.post("/admin/requests/:id/retry", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    await db.tx(async (t) => {
      const r = await t.query(
        `update invoice_requests set status='queued', queued_at=now(), lease_until=null, finished_at=null, error_code=null, error_detail=null
          where id=$1 and status='failed' returning id`,
        [id],
      );
      if (!r.length) throw new HttpError(409, "wrong_state", "Only failed requests can be retried.");
      await t.query(`insert into invoice_request_events (request_id, kind, detail) values ($1,'retry',$2)`, [
        id,
        JSON.stringify({ by: actor.email }),
      ]);
      await audit(t, actor, "retry", "invoice_request", id, null, null);
    });
    deps.invoicing?.kick();
    return c.json({ ok: true });
  });

  app.get("/admin/approvals", async (c) =>
    c.json(
      await db.query(
        `select a.id, a.reason, a.requested_at, a.decision, a.decided_by, a.decided_at, r.ref_code, r.total, s.name as salesman, cu.name as customer
           from approvals a join invoice_requests r on r.id = a.request_id join salesmen s on s.id = r.salesman_id
           join customers cu on cu.id = r.customer_id
          order by (a.decision is null) desc, a.requested_at desc limit 100`,
      ),
    ),
  );

  app.post("/admin/approvals/:id/decide", async (c) => {
    const actor = c.get("actor");
    const id = uuid.parse(c.req.param("id"));
    const { decision } = await body(c, z.object({ decision: z.enum(["approved", "rejected"]) }));
    const phone = await db.tx(async (t) => {
      const [a] = await t.query<{ request_id: string; decision: string | null }>(
        `select request_id, decision from approvals where id=$1 for update`,
        [id],
      );
      if (!a) throw new HttpError(404, "not_found", "Approval not found.");
      if (a.decision) throw new HttpError(409, "decided", "This request was already decided.");
      await t.query(`update approvals set decision=$2, decided_by=$3, decided_at=now() where id=$1`, [
        id,
        decision,
        actor.email,
      ]);
      await t.query(
        `update invoice_requests set status=$2, queued_at=case when $2='queued' then now() end,
           finished_at=case when $2='cancelled' then now() end where id=$1 and status='awaiting_approval'`,
        [a.request_id, decision === "approved" ? "queued" : "cancelled"],
      );
      await t.query(`insert into invoice_request_events (request_id, kind, detail) values ($1,$2,$3)`, [
        a.request_id,
        decision,
        JSON.stringify({ by: actor.email }),
      ]);
      await audit(t, actor, decision, "approval", id, null, { request: a.request_id });
      const [s] = await t.query<{ phone: string }>(
        `select s.phone from invoice_requests r join salesmen s on s.id = r.salesman_id where r.id=$1`,
        [a.request_id],
      );
      return s?.phone ?? null;
    });
    if (phone && deps.invoicing) await deps.invoicing.wa.sendText(phone, msg(decision === "approved" ? "M30" : "M29"));
    deps.invoicing?.kick();
    return c.json({ ok: true });
  });

  // ================================================================ health
  app.get("/admin/health", async (c) => {
    if (!deps.invoicing)
      return c.json({ ok: false, problems: [deps.invoicingStatus ?? "Invoicing is off."], info: [], counts: null });
    return c.json(await queueHealth(db, deps.invoicing.odoo, { journalId: deps.invoicing.journalId }));
  });

  // ================================================================ settings and audit
  app.get("/admin/settings", async (c) => {
    const rows = await db.query<{ key: string; value: unknown }>(
      `select key, value from platform_settings order by key`,
    );
    // test mode is ON until someone switches it off, even before it was ever saved
    return c.json({ test_mode: true, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  });

  app.put("/admin/settings/:key", async (c) => {
    const actor = c.get("actor");
    const key = c.req.param("key");
    const schema = SETTINGS[key];
    if (!schema) throw new HttpError(404, "unknown_setting", "Unknown setting.");
    const { value } = await body(c, z.object({ value: schema }));
    await db.tx(async (t) => {
      const [before] = await t.query<{ value: unknown }>(
        `select value from platform_settings where key=$1 for update`,
        [key],
      );
      await t.query(
        `insert into platform_settings (key, value, updated_by) values ($1,$2,$3) on conflict (key) do update set value=excluded.value, updated_at=now(), updated_by=excluded.updated_by`,
        [key, JSON.stringify(value), actor.email],
      );
      await audit(t, actor, "set", "setting", key, before?.value ?? null, value);
    });
    return c.json({ key, value });
  });

  app.get("/admin/audit", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
    const entity = c.req.query("entity");
    return c.json(
      await db.query(
        `select id, at, actor, action, entity, entity_id, before, after from audit_log where ($1::text is null or entity = $1) order by id desc limit $2`,
        [entity ?? null, limit],
      ),
    );
  });

  return app;
}
