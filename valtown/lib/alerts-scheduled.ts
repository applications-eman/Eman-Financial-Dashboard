// Scheduled rules: evaluated on a timer against the database (ZATCA delays, gaps, sudden drops...).
// Every alert has a deterministic fingerprint, so running a check twice never creates duplicates.
import { riyadhParts } from "./reports.ts";
import { type AlertDraft, DEFAULT_HOURS, DEFAULT_ZATCA, type RulesConfig, type SalesRow, segmentOf } from "./sales-types.ts";
import type { Row, Store } from "./store.ts";

export interface CheckCtx {
  now: Date;
  rules: RulesConfig;
  zatca: { b2b_minutes: number; b2c_hours: number; b2c_warn_hours: number };
  hours: { start_hour: number; end_hour: number };
}
const MIN = 60_000;
const money = (n: number) => n.toFixed(2);

function draft(rule: string, cfg: { severity: AlertDraft["severity"] }, r: Row, title: string, fp: string, extra: Record<string, unknown> = {}, severity?: AlertDraft["severity"]): AlertDraft {
  return {
    rule_key: rule, severity: severity ?? cfg.severity, title, section: r.section ?? "bakery", salesman_name: r.salesman_name ?? null, odoo_id: r.odoo_id ?? null,
    amount: r.amount_total != null ? Number(r.amount_total) : null, fingerprint: fp,
    detail: { number: r.number, issued_at: r.odoo_created_at, kind: r.kind, salesman: r.salesman_name, customer: r.customer_name, segment: segmentOf(r.customer_vat), amount_total: r.amount_total, zatca_state: r.zatca_state, zatca_error: r.zatca_error, ...extra },
  };
}

/** ZATCA: B2B (standard) invoices are cleared BEFORE issue => flag quickly; B2C (simplified) must be reported within 24h. */
export function zatcaChecks(rows: Row[], ctx: CheckCtx): AlertDraft[] {
  const out: AlertDraft[] = [];
  const R = ctx.rules;
  for (const r of rows) {
    if (r.state !== "posted") continue;
    const created = Date.parse(r.odoo_created_at);
    if (!Number.isFinite(created)) continue;
    const ageMin = (ctx.now.getTime() - created) / MIN;
    const b2b = segmentOf(r.customer_vat) === "B2B";
    const sent = r.zatca_state === "sent";
    if (R.zatca_error?.enabled && r.zatca_error && !sent) {
      out.push(draft("zatca_error", R.zatca_error, r, `ZATCA rejected or failed ${r.number}: ${String(r.zatca_error).slice(0, 140)}`, `zatca_error:${r.odoo_id}`, { age_minutes: Math.round(ageMin) }));
    }
    if (sent) continue;
    if (b2b && R.zatca_delay_b2b?.enabled && ageMin > ctx.zatca.b2b_minutes) {
      out.push(draft("zatca_delay_b2b", R.zatca_delay_b2b, r, `B2B ${r.number} not cleared by ZATCA after ${Math.round(ageMin)} min`, `zatca_delay_b2b:${r.odoo_id}`, { age_minutes: Math.round(ageMin), limit_minutes: ctx.zatca.b2b_minutes }));
    }
    if (!b2b && R.zatca_delay_b2c?.enabled) {
      const h = ageMin / 60;
      if (h > ctx.zatca.b2c_hours) out.push(draft("zatca_delay_b2c", R.zatca_delay_b2c, r, `B2C ${r.number} NOT reported to ZATCA within ${ctx.zatca.b2c_hours} h (${h.toFixed(1)} h)`, `zatca_delay_b2c:${r.odoo_id}`, { age_hours: Math.round(h * 10) / 10, limit_hours: ctx.zatca.b2c_hours }, "critical"));
      else if (h > ctx.zatca.b2c_warn_hours) out.push(draft("zatca_delay_b2c", R.zatca_delay_b2c, r, `B2C ${r.number} still not reported to ZATCA after ${h.toFixed(1)} h (limit ${ctx.zatca.b2c_hours} h)`, `zatca_delay_b2c_warn:${r.odoo_id}`, { age_hours: Math.round(h * 10) / 10 }, "info"));
    }
  }
  return out;
}

/** gaps in the ZATCA invoice chain counter (a missing index means a document was removed or never recorded) */
export function chainGapChecks(indexes: number[], ctx: CheckCtx): AlertDraft[] {
  if (!ctx.rules.zatca_chain_gap?.enabled) return [];
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const out: AlertDraft[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > 1) {
      const from = sorted[i - 1] + 1, to = sorted[i] - 1;
      out.push({ rule_key: "zatca_chain_gap", severity: ctx.rules.zatca_chain_gap.severity, title: `ZATCA chain gap: index ${from}${to > from ? `–${to}` : ""} missing`, detail: { from, to, missing: to - from + 1 }, fingerprint: `zatca_chain_gap:${from}-${to}`, section: "bakery" });
    }
  }
  return out;
}

export function numberGapChecks(gaps: { gap_from: number; gap_to: number; prefix: string }[], ctx: CheckCtx): AlertDraft[] {
  if (!ctx.rules.number_gap?.enabled) return [];
  return gaps.map((g) => ({
    rule_key: "number_gap", severity: ctx.rules.number_gap.severity,
    title: `Invoice number gap in ${g.prefix}: ${g.gap_from}${g.gap_to > g.gap_from ? `–${g.gap_to}` : ""} missing`,
    detail: { prefix: g.prefix, from: Number(g.gap_from), to: Number(g.gap_to) }, fingerprint: `number_gap:${g.prefix}:${g.gap_from}-${g.gap_to}`, section: "bakery",
  }));
}

export interface DailyTotal { salesman_id: number; salesman_name: string; day: string; total: number; invoices: number }

/** salesmen far below their usual day (checked once, after `check_after_hour` Riyadh) and, optionally, silent salesmen */
export function salesmanDayChecks(totals: DailyTotal[], ctx: CheckCtx): AlertDraft[] {
  const out: AlertDraft[] = [];
  const { date: today, hour } = riyadhParts(ctx.now);
  const by = new Map<number, DailyTotal[]>();
  for (const t of totals) (by.get(t.salesman_id) ?? by.set(t.salesman_id, []).get(t.salesman_id)!).push({ ...t, total: Number(t.total) });
  for (const [id, list] of by) {
    const past = list.filter((t) => t.day < today);
    if (past.length < 5) continue; // not a regular salesman
    const avg = past.reduce((a, t) => a + t.total, 0) / past.length;
    const mine = list.find((t) => t.day === today);
    const name = list[0].salesman_name;
    const sd = ctx.rules.sales_drop;
    if (sd?.enabled && hour >= Number(sd.check_after_hour) && avg >= Number(sd.min_usual_amount)) {
      const t = mine?.total ?? 0;
      if (t < avg * (1 - Number(sd.drop_pct) / 100)) {
        out.push({ rule_key: "sales_drop", severity: sd.severity, title: `${name}: sales today SAR ${money(t)} vs usual SAR ${money(avg)}`, detail: { salesman: name, today: t, usual_average: Math.round(avg * 100) / 100, drop_pct: sd.drop_pct, day: today }, fingerprint: `sales_drop:${id}:${today}`, salesman_name: name, amount: t, section: "bakery" });
      }
    }
    const ns = ctx.rules.no_sales_by_time;
    if (ns?.enabled && hour >= Number(ns.by_hour) && !mine) {
      out.push({ rule_key: "no_sales_by_time", severity: ns.severity, title: `${name} has no sales yet today (after ${String(ns.by_hour).padStart(2, "0")}:00)`, detail: { salesman: name, day: today }, fingerprint: `no_sales_by_time:${id}:${today}`, salesman_name: name, section: "bakery" });
    }
  }
  return out;
}

export interface SalesmanStat { salesman_id: number; salesman_name: string; invoices: number; zero_tax_invoices: number }
export function zeroTaxRatioChecks(stats: SalesmanStat[], ctx: CheckCtx): AlertDraft[] {
  const c = ctx.rules.zero_tax_ratio;
  if (!c?.enabled) return [];
  const out: AlertDraft[] = [];
  const { date } = riyadhParts(ctx.now);
  for (const s of stats) {
    const inv = Number(s.invoices), z = Number(s.zero_tax_invoices);
    if (inv < Number(c.min_invoices)) continue;
    const pct = (z / inv) * 100;
    if (pct >= Number(c.min_ratio_pct)) {
      out.push({ rule_key: "zero_tax_ratio", severity: c.severity, title: `${s.salesman_name}: ${pct.toFixed(0)}% of invoices have no VAT (${z} of ${inv})`, detail: { salesman: s.salesman_name, zero_tax: z, invoices: inv, ratio_pct: Math.round(pct) }, fingerprint: `zero_tax_ratio:${s.salesman_id}:${date}`, salesman_name: s.salesman_name, section: "bakery" });
    }
  }
  return out;
}

export function unpaidChecks(rows: Row[], ctx: CheckCtx): AlertDraft[] {
  const c = ctx.rules.unpaid_invoice;
  if (!c?.enabled) return [];
  return rows.filter((r) => r.kind === "invoice" && r.state === "posted" && !["paid", "in_payment", "reversed"].includes(r.payment_state) && (ctx.now.getTime() - Date.parse(r.odoo_created_at)) / 3_600_000 > Number(c.after_hours))
    .map((r) => draft("unpaid_invoice", c, r, `Invoice ${r.number} unpaid after ${c.after_hours} h`, `unpaid_invoice:${r.odoo_id}`));
}

export async function loadAndRunScheduled(store: Store, ctx: CheckCtx, which: { zatca: boolean; hourly: boolean }): Promise<AlertDraft[]> {
  const out: AlertDraft[] = [];
  const sinceIso = new Date(ctx.now.getTime() - 14 * 86_400_000).toISOString();
  if (which.zatca) {
    const notSent = await store.select("sales_invoices", { filters: [["state", "eq", "posted"], ["zatca_state", "neq", "sent"], ["odoo_created_at", "gte", sinceIso]], limit: 2000 });
    const nullState = await store.select("sales_invoices", { filters: [["state", "eq", "posted"], ["zatca_state", "is", "null"], ["odoo_created_at", "gte", sinceIso]], limit: 2000 });
    const withError = await store.select("sales_invoices", { filters: [["state", "eq", "posted"], ["zatca_error", "neq", ""], ["odoo_created_at", "gte", sinceIso]], limit: 500 }).catch(() => ({ rows: [] as Row[] }));
    const byId = new Map<number, Row>();
    for (const r of [...notSent.rows, ...nullState.rows, ...withError.rows]) byId.set(r.odoo_id, r);
    out.push(...zatcaChecks([...byId.values()], ctx));
  }
  if (which.hourly) {
    const recent = await store.select("sales_invoices", { columns: "zatca_chain_index", filters: [["state", "eq", "posted"], ["zatca_chain_index", "gte", 1], ["odoo_created_at", "gte", new Date(ctx.now.getTime() - 3 * 86_400_000).toISOString()], ["odoo_created_at", "lte", new Date(ctx.now.getTime() - 30 * MIN).toISOString()]], limit: 5000 });
    out.push(...chainGapChecks(recent.rows.map((r) => Number(r.zatca_chain_index)), ctx));
    out.push(...numberGapChecks((await store.rpc("invoice_number_gaps", { p_since: riyadhParts(new Date(ctx.now.getTime() - 3 * 86_400_000)).date })) as any, ctx));
    out.push(...salesmanDayChecks((await store.rpc("salesman_daily_totals", { p_days: 15 })) as any, ctx));
    out.push(...zeroTaxRatioChecks((await store.rpc("salesman_stats", { p_days: Number(ctx.rules.zero_tax_ratio?.window_days ?? 7) })) as any, ctx));
    if (ctx.rules.unpaid_invoice?.enabled) {
      const unpaid = await store.select("sales_invoices", { filters: [["state", "eq", "posted"], ["kind", "eq", "invoice"], ["payment_state", "eq", "not_paid"], ["odoo_created_at", "gte", sinceIso]], limit: 1000 });
      out.push(...unpaidChecks(unpaid.rows, ctx));
    }
  }
  return out;
}
export { DEFAULT_HOURS, DEFAULT_ZATCA };
export type { SalesRow };
