// Turns a confirmed Flow session into an invoice request. This is the authoritative check (the Flow's own checks
// are only for convenience): price limits, customer ownership, limits, duplicates. Nothing here talks to Odoo.

import type { Db } from "../db.ts";
import type { MsgCode } from "./messages.ts";
import { createHash } from "node:crypto";

export const VAT_RATE = 0.15;

export interface SessionLine {
  product_id: string;
  qty: number;
  price: number;
}
export interface Session {
  token: string;
  salesman_id: string;
  customer_id: string | null;
  lines: SessionLine[];
  request_id: string | null;
  expires_at: Date;
}
export interface RequestLine {
  product_id: string;
  odoo_product_id: number;
  name: string;
  qty: number;
  price: number;
  sub: number;
  vat: number;
}

const cents = (n: number) => Math.round(n * 100);

/** Line amounts as Odoo's "round per line" gives them (half up, two decimals). */
export function priceLine(qty: number, price: number): { sub: number; vat: number } {
  const sub = cents(qty * price);
  return { sub: sub / 100, vat: Math.round(sub * VAT_RATE) / 100 };
}

export function totals(lines: { sub: number; vat: number }[]) {
  const sub = lines.reduce((s, l) => s + cents(l.sub), 0);
  const vat = lines.reduce((s, l) => s + cents(l.vat), 0);
  return { subtotal: sub / 100, vat: vat / 100, total: (sub + vat) / 100 };
}

export const money = (n: number) => n.toFixed(2);

export async function setting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const [r] = await db.query<{ value: T }>(`select value from platform_settings where key=$1`, [key]);
  return r ? r.value : fallback;
}

export async function loadSession(db: Db, token: string): Promise<Session | null> {
  const [s] = await db.query<Session>(
    `select token, salesman_id, customer_id, lines, request_id, expires_at from flow_sessions where token=$1 and expires_at > now()`,
    [token],
  );
  return s ?? null;
}

export function contentHash(
  salesmanId: string,
  customerId: string,
  lines: { product_id: string; qty: number; price: number }[],
): string {
  const norm = lines
    .map((l) => `${l.product_id}:${l.qty}:${l.price.toFixed(2)}`)
    .sort()
    .join("|");
  return createHash("sha256").update(`${salesmanId}|${customerId}|${norm}`).digest("hex");
}

export type Intake =
  | {
      ok: true;
      kind: "queued" | "existing" | "approval";
      requestId: string;
      ref: string;
      position: number;
      similar?: { time: string; number: string };
    }
  | { ok: false; code: MsgCode; vars?: Record<string, string | number> };

const fail = (code: MsgCode, vars?: Record<string, string | number>): Intake => ({ ok: false, code, vars });
const isUnique = (e: unknown) =>
  /duplicate key|unique constraint/i.test(e instanceof Error ? e.message : String(e)) ||
  (typeof e === "object" && e !== null && "code" in e && e.code === "23505");

export async function submitRequest(db: Db, token: string): Promise<Intake> {
  const s = await loadSession(db, token);
  if (!s) return fail("M22");

  if (s.request_id) {
    const [r] = await db.query<{ ref_code: string; status: string }>(
      `select ref_code, status from invoice_requests where id=$1`,
      [s.request_id],
    );
    if (r) return { ok: true, kind: "existing", requestId: s.request_id, ref: r.ref_code, position: 0 };
  }

  if ((await setting(db, "kill_switch", false)) === true) return fail("M31");

  const [sm] = await db.query<{ status: string; daily_limit: number | null }>(
    `select status, daily_limit from salesmen where id=$1`,
    [s.salesman_id],
  );
  if (sm?.status !== "active") return fail("M02");

  const maxLines = await setting(db, "max_lines_per_invoice", 20);
  if (s.lines.length === 0 || !s.customer_id) return fail("M08");
  if (s.lines.length > maxLines) return fail("M28", { max: maxLines });

  const [cust] = await db.query<{ id: string; name: string; status: string; odoo_partner_id: number | null }>(
    `select c.id, c.name, c.status, c.odoo_partner_id from customers c join salesman_customers sc on sc.customer_id = c.id where sc.salesman_id = $1 and c.id = $2`,
    [s.salesman_id, s.customer_id],
  );
  if (cust?.status !== "active") return fail("M20");
  if (!cust.odoo_partner_id) return fail("M21", { what: cust.name });

  const prods = await db.query<{
    id: string;
    name: string;
    max_price: string | null;
    status: string;
    odoo_product_id: number | null;
  }>(`select id, name, max_price, status, odoo_product_id from products where id = any($1::uuid[])`, [
    [...new Set(s.lines.map((l) => l.product_id))],
  ]);
  const byId = new Map(prods.map((p) => [p.id, p]));
  const lines: RequestLine[] = [];
  for (const l of s.lines) {
    const p = byId.get(l.product_id);
    if (p?.status !== "active") return fail("M21", { what: "a product in your cart" });
    if (p.max_price === null) return fail("M09", { product: p.name });
    if (!(l.qty > 0)) return fail("M05");
    if (!(l.price > 0)) return fail("M06");
    if (cents(l.price) > cents(Number(p.max_price)))
      return fail("M07", { product: p.name, entered: money(l.price), max: money(Number(p.max_price)) });
    if (!p.odoo_product_id) return fail("M21", { what: p.name });
    lines.push({
      product_id: p.id,
      odoo_product_id: p.odoo_product_id,
      name: p.name,
      qty: l.qty,
      price: l.price,
      ...priceLine(l.qty, l.price),
    });
  }
  const t = totals(lines);

  if (sm.daily_limit) {
    const [{ n }] = await db.query<{ n: number }>(
      `select count(*)::int as n from invoice_requests where salesman_id=$1 and status not in ('awaiting_approval','cancelled','failed','rejected','duplicate_blocked')
        and (created_at at time zone 'Asia/Riyadh')::date = (now() at time zone 'Asia/Riyadh')::date`,
      [s.salesman_id],
    );
    if (n >= sm.daily_limit) return fail("M23");
  }

  const hash = contentHash(s.salesman_id, cust.id, lines);
  const windowMin = await setting(db, "duplicate_window_minutes", 30);
  const [similar] = await db.query<{ invoice_number: string | null; ref_code: string; created_at: Date }>(
    `select invoice_number, ref_code, created_at from invoice_requests
      where salesman_id=$1 and customer_id=$2 and content_hash=$3 and status in ('received','queued','processing','cleared')
        and created_at > now() - make_interval(mins => $4::int) order by created_at desc limit 1`,
    [s.salesman_id, cust.id, hash, windowMin],
  );

  try {
    return await db.tx(async (tx) => {
      const status = similar ? "awaiting_approval" : "queued";
      const [r] = await tx.query<{ id: string; ref_code: string }>(
        `insert into invoice_requests (request_key, salesman_id, customer_id, lines, subtotal, vat, total, content_hash, status, queued_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, case when $9 = 'queued' then now() end) returning id, ref_code`,
        [`flow:${token}`, s.salesman_id, cust.id, JSON.stringify(lines), t.subtotal, t.vat, t.total, hash, status],
      );
      await tx.query(`update flow_sessions set request_id=$2, updated_at=now() where token=$1`, [token, r.id]);
      await tx.query(`insert into invoice_request_events (request_id, kind, detail) values ($1,$2,$3)`, [
        r.id,
        status === "queued" ? "queued" : "awaiting_approval",
        JSON.stringify({ lines: lines.length, total: t.total }),
      ]);
      if (similar) {
        await tx.query(`insert into approvals (request_id, reason) values ($1,$2)`, [
          r.id,
          `Same customer and items as ${similar.invoice_number ?? similar.ref_code} within ${windowMin} minutes`,
        ]);
        const time = new Date(similar.created_at).toLocaleTimeString("en-GB", {
          timeZone: "Asia/Riyadh",
          hour: "2-digit",
          minute: "2-digit",
        });
        return {
          ok: true as const,
          kind: "approval" as const,
          requestId: r.id,
          ref: r.ref_code,
          position: 0,
          similar: { time, number: similar.invoice_number ?? similar.ref_code },
        };
      }
      const [{ n }] = await tx.query<{ n: number }>(
        `select count(*)::int as n from invoice_requests where status in ('queued','processing') and id <> $1`,
        [r.id],
      );
      return { ok: true as const, kind: "queued" as const, requestId: r.id, ref: r.ref_code, position: n + 1 };
    });
  } catch (e) {
    if (!isUnique(e)) throw e;
    const [r] = await db.query<{ id: string; ref_code: string }>(
      `select id, ref_code from invoice_requests where request_key=$1`,
      [`flow:${token}`],
    );
    if (!r) throw e;
    return { ok: true, kind: "existing", requestId: r.id, ref: r.ref_code, position: 0 };
  }
}
