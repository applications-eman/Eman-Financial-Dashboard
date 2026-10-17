// Event rules: evaluated for every NEW or CHANGED Odoo document right after it is synced.
// Pure decision logic + small injected lookups, so every rule is unit-tested without a database.
import { riyadhParts } from "./reports.ts";
import { type AlertDraft, mergeRules, type RuleCfg, type RulesConfig, type SalesRow, segmentOf } from "./sales-types.ts";

export interface EventCtx {
  now: Date;
  rules: RulesConfig;
  hours: { start_hour: number; end_hour: number };
  /** average invoice amount per salesman over the last 30 days */
  avgBySalesman: Map<number, number>;
  originalInvoiceDate(odooId: number): Promise<string | null>;
  creditNotesOnDay(salesmanId: number, day: string): Promise<number>;
  /** the OTHER identical invoices (same salesman, customer and amount) created shortly before this one */
  similarInvoices(row: SalesRow, windowMinutes: number): Promise<{ number: string | null; odoo_created_at: string | null }[]>;
}
export interface InvoiceEvent { row: SalesRow; prev: SalesRow | null }

const money = (n: number) => n.toFixed(2);
const DAY = 86_400_000;
const parseIso = (s: string | null) => (s ? new Date(s).getTime() : NaN);

function base(rule: string, cfg: RuleCfg, row: SalesRow, title: string, extra: Record<string, unknown> = {}, fp?: string): AlertDraft {
  return {
    rule_key: rule, severity: cfg.severity, title, section: row.section, salesman_name: row.salesman_name, odoo_id: row.odoo_id,
    amount: row.amount_total, fingerprint: fp ?? `${rule}:${row.odoo_id}`,
    detail: {
      number: row.number, kind: row.kind, salesman: row.salesman_name, customer: row.customer_name, segment: segmentOf(row.customer_vat),
      issued_at: row.odoo_created_at, amount_total: row.amount_total, amount_untaxed: row.amount_untaxed, amount_tax: row.amount_tax, invoice_date: row.invoice_date, ref: row.ref,
      created_by: row.created_by_name, ...extra,
    },
  };
}

/** default Odoo reversal text that carries no human reason, e.g. "Reversal of: INV/2026/163747" */
export const isAutoReversalText = (ref: string | null) => !ref || /^\s*reversal of:?\s*[A-Za-z0-9/\-]+\s*\.?\s*$/i.test(ref);

const quarterEnd = (day: string) => {
  const [y, m] = day.split("-").map(Number);
  const qEndMonth = Math.floor((m - 1) / 3) * 3 + 3;
  return new Date(Date.UTC(y, qEndMonth, 0)); // last day of the quarter
};

export async function evaluateInvoiceEvent(ev: InvoiceEvent, ctx: EventCtx): Promise<AlertDraft[]> {
  const { row, prev } = ev;
  const R = ctx.rules;
  const out: AlertDraft[] = [];
  const on = (k: string) => R[k]?.enabled;
  const num = row.number ?? String(row.odoo_id);
  const who = row.salesman_name ?? "—";

  // ---- documents that were posted and are no longer (cancelled / reset to draft)
  if (on("invoice_cancelled") && row.state !== "posted" && ((prev && prev.state === "posted") || (row.number && row.number !== "/" && prev?.state !== row.state && row.state === "cancel"))) {
    out.push(base("invoice_cancelled", R.invoice_cancelled, row, `${num} was ${row.state === "cancel" ? "cancelled" : "reset to draft"} after posting`, { state: row.state, changed_by: row.write_by_name ?? null }));
  }
  if (row.state !== "posted") return out;
  const isNewlyPosted = !prev || prev.state !== "posted";
  const created = parseIso(row.odoo_created_at);
  const day = row.invoice_date ?? (row.odoo_created_at ?? "").slice(0, 10);

  if (row.kind === "credit_note") {
    if (isNewlyPosted) {
      if (on("credit_any")) out.push(base("credit_any", R.credit_any, row, `Credit note ${num} by ${who}: SAR ${money(row.amount_total)}`));
      if (on("credit_amount") && row.amount_total >= Number(R.credit_amount.min_amount)) {
        out.push(base("credit_amount", R.credit_amount, row, `Large credit note ${num}: SAR ${money(row.amount_total)}`, { threshold: R.credit_amount.min_amount }));
      }
      if (on("refund_unlinked") && !row.reversed_odoo_id) out.push(base("refund_unlinked", R.refund_unlinked, row, `Credit note ${num} is not linked to any invoice`));
      if (on("credit_no_reason") && row.reversed_odoo_id && isAutoReversalText(row.ref)) out.push(base("credit_no_reason", R.credit_no_reason, row, `Credit note ${num} has no reason written`));
      const office = (R.credit_by_office?.office_users ?? []) as string[];
      if (on("credit_by_office") && row.created_by_name && office.some((o) => o.toLowerCase() === row.created_by_name?.toLowerCase()) && row.salesman_name !== row.created_by_name) {
        out.push(base("credit_by_office", R.credit_by_office, row, `Credit note ${num} for ${who}'s invoice was issued by ${row.created_by_name}`));
      }
      if (on("credit_old_invoice") && row.reversed_odoo_id) {
        const orig = await ctx.originalInvoiceDate(row.reversed_odoo_id);
        if (orig && day) {
          const age = Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${orig}T00:00:00Z`)) / DAY);
          if (age > Number(R.credit_old_invoice.max_age_days)) out.push(base("credit_old_invoice", R.credit_old_invoice, row, `Credit note ${num} cancels an invoice that is ${age} days old`, { original_date: orig, age_days: age }));
        }
      }
      if (on("credit_period_end") && day) {
        const left = Math.floor((quarterEnd(day).getTime() - Date.parse(`${day}T00:00:00Z`)) / DAY);
        if (left <= Number(R.credit_period_end.days_before_quarter_end)) out.push(base("credit_period_end", R.credit_period_end, row, `Credit note ${num} issued ${left} day(s) before the VAT quarter ends`, { days_left: left }));
      }
      if (on("credit_per_salesman_day") && row.salesman_id != null && day) {
        const n = await ctx.creditNotesOnDay(row.salesman_id, day);
        if (n > Number(R.credit_per_salesman_day.max_per_day)) {
          out.push(base("credit_per_salesman_day", R.credit_per_salesman_day, row, `${who} issued ${n} credit notes on ${day}`, { count: n, day }, `credit_per_salesman_day:${row.salesman_id}:${day}`));
        }
      }
    }
    return out;
  }

  // ---- invoices
  if (isNewlyPosted) {
    if (on("tiny_invoice") && row.amount_total > 0 && row.amount_total <= Number(R.tiny_invoice.max_amount)) {
      out.push(base("tiny_invoice", R.tiny_invoice, row, `Very small invoice ${num}: SAR ${money(row.amount_total)}`));
    }
    if (on("zero_tax_invoice") && row.amount_untaxed > 0 && row.amount_tax === 0) {
      out.push(base("zero_tax_invoice", R.zero_tax_invoice, row, `Invoice ${num} has no VAT (SAR ${money(row.amount_untaxed)})`));
    }
    if (on("invoice_backdated") && row.invoice_date && Number.isFinite(created)) {
      const createdDay = riyadhParts(new Date(created)).date;
      const lag = Math.floor((Date.parse(`${createdDay}T00:00:00Z`) - Date.parse(`${row.invoice_date}T00:00:00Z`)) / DAY);
      if (lag > Number(R.invoice_backdated.max_days)) out.push(base("invoice_backdated", R.invoice_backdated, row, `Invoice ${num} is back-dated by ${lag} days`, { created_on: createdDay, lag_days: lag }));
    }
    if (on("off_hours") && Number.isFinite(created)) {
      const h = riyadhParts(new Date(created)).hour;
      if (h < ctx.hours.start_hour || h >= ctx.hours.end_hour) out.push(base("off_hours", R.off_hours, row, `Invoice ${num} created at ${String(h).padStart(2, "0")}:00 (outside working hours)`, { hour: h }));
    }
    if (on("unusual_amount") && row.salesman_id != null) {
      const avg = ctx.avgBySalesman.get(row.salesman_id);
      if (avg && row.amount_total >= Number(R.unusual_amount.min_amount) && row.amount_total > avg * Number(R.unusual_amount.multiplier)) {
        out.push(base("unusual_amount", R.unusual_amount, row, `${who}: invoice ${num} of SAR ${money(row.amount_total)} is ${(row.amount_total / avg).toFixed(1)}x their average`, { average: Math.round(avg * 100) / 100 }));
      }
    }
    if (on("duplicate_burst")) {
      const others = await ctx.similarInvoices(row, Number(R.duplicate_burst.window_minutes));
      const n = others.length + 1;
      if (n >= Number(R.duplicate_burst.min_count)) {
        const invoices = [...others, { number: row.number, odoo_created_at: row.odoo_created_at }]
          .sort((a, b) => String(a.odoo_created_at).localeCompare(String(b.odoo_created_at)))
          .map((i) => ({ number: i.number, issued_at: i.odoo_created_at }));
        out.push(base("duplicate_burst", R.duplicate_burst, row, `${who}: ${n} identical invoices (same customer, SAR ${money(row.amount_total)}) within ${R.duplicate_burst.window_minutes} min`, { count: n, invoices }, `duplicate_burst:${row.salesman_id}:${row.customer_id}:${row.amount_total}:${(row.odoo_created_at ?? "").slice(0, 13)}`));
      }
    }
  }
  return out;
}

export { mergeRules };
