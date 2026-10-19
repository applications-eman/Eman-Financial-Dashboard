// Event rules: evaluated for every NEW or CHANGED Odoo document right after it is synced.
// Pure decision logic + small injected lookups, so every rule is unit-tested without a database.
import { riyadhParts } from "./reports.ts";
import { type AlertDraft, mergeRules, type RuleCfg, type RulesConfig, type SalesRow, segmentOf } from "./sales-types.ts";

export interface EventCtx {
  now: Date;
  rules: RulesConfig;
  hours: { start_hour: number; end_hour: number };
  /**
   * How this salesman invoices this customer, per DAY: the daily totals of the earlier days in the look-back window,
   * and what was already invoiced to them today (excluding this invoice).
   */
  amountHistory(row: SalesRow): Promise<{ days: number[]; todayOthers: number; todayCount: number }>;
  /** this salesman's recent invoices to ANY customer: the median invoice and how many there were */
  salesmanTypical(row: SalesRow): Promise<{ median: number; count: number }>;
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
      created_by: row.created_by_name, issued_by: row.created_by_name,
      ...(row.kind === "credit_note" ? { reason: row.ref, no_reason: isAutoReversalText(row.ref), original_invoice: row.reversed_number } : {}),
      ...extra,
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

export interface UnusualVerdict { reason: "above_usual" | "no_history"; median: number; highest: number; days: number; similar: number; ratio: number; z: number }

const medianOf = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Layer 1 - behaviour of ONE salesman towards ONE customer, per day (a robust outlier test, the way fraud/anomaly tools do it).
 *  history = the daily totals of the days this salesman invoiced this customer in the look-back window (earlier days only).
 *  dayTotal = what has been invoiced to this customer by this salesman today, including the new invoice.
 * The day is "unusual" when ALL of these are true:
 *  - dayTotal reaches the minimum amount (checked by the caller);
 *  - there is a pattern to compare with (>= min_history earlier days); with no pattern it is flagged as "no history";
 *  - it is clearly above a normal day: at least `clear_factor` x the usual (median) day, AND a robust z-score on the log scale
 *    (median + MAD, so past outliers cannot blind the rule the way a plain average or "highest day" would) of at least `z_threshold`;
 *  - a day this big has hardly happened: fewer than `accept_if_similar` earlier days reached `similar_ratio` x dayTotal
 *    (a size that keeps happening becomes the customer's normal behaviour).
 */
export function judgeUnusual(dayTotal: number, days: number[], cfg: { [k: string]: unknown }): UnusualVerdict | null {
  const minN = Number(cfg.min_history ?? 3);
  if (days.length < minN) return { reason: "no_history", median: 0, highest: 0, days: days.length, similar: 0, ratio: 0, z: 0 };
  const clear = Number(cfg.clear_factor ?? 1.5);
  const zThreshold = Number(cfg.z_threshold ?? 3.5);
  const sigmaFloor = Number(cfg.sigma_floor ?? 0.35);
  const acceptIfSimilar = Number(cfg.accept_if_similar ?? 3);
  const similarRatio = Number(cfg.similar_ratio ?? 0.8);
  const positive = days.filter((x) => x > 0);
  const med = medianOf(days);
  const highest = Math.max(...days);
  const logs = positive.map(Math.log);
  const lm = logs.length ? medianOf(logs) : 0;
  const mad = logs.length ? medianOf(logs.map((x) => Math.abs(x - lm))) : 0;
  const sigma = Math.max(1.4826 * mad, sigmaFloor);
  const z = dayTotal > 0 && logs.length ? (Math.log(dayTotal) - lm) / sigma : 0;
  const similar = days.filter((x) => x >= dayTotal * similarRatio).length;
  if (dayTotal < med * clear || z < zThreshold || similar >= acceptIfSimilar) return null;
  return { reason: "above_usual", median: med, highest, days: days.length, similar, ratio: med > 0 ? dayTotal / med : Infinity, z };
}

/** Layer 2 - one invoice far above what this salesman normally invoices to anybody (recent typical invoice = median). */
export function judgeSalesmanLevel(amount: number, typical: { median: number; count: number }, cfg: { [k: string]: unknown }): boolean {
  return (
    amount >= Number(cfg.salesman_min_amount ?? 1000) &&
    typical.count >= Number(cfg.salesman_min_count ?? 10) &&
    typical.median > 0 &&
    amount >= typical.median * Number(cfg.salesman_factor ?? 3)
  );
}

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
    if (on("unusual_amount")) {
      const cfg = R.unusual_amount;
      const hist = await ctx.amountHistory(row);
      const dayTotal = hist.todayOthers + row.amount_total;
      const reasons: { code: string; [k: string]: unknown }[] = [];
      // layer 1: this salesman + this customer, per day
      if (dayTotal >= Number(cfg.min_amount)) {
        const v = judgeUnusual(dayTotal, hist.days, cfg);
        if (v) reasons.push({ code: v.reason, median: v.median, highest: v.highest, days: v.days, similar: v.similar, ratio: v.ratio, z: v.z });
      }
      // layer 2: one invoice far above this salesman's typical invoice (to anybody)
      let sm: { median: number; count: number } | null = null;
      if (row.amount_total >= Number(cfg.salesman_min_amount ?? 1000)) {
        sm = await ctx.salesmanTypical(row);
        if (judgeSalesmanLevel(row.amount_total, sm, cfg)) reasons.push({ code: "above_salesman", median: sm.median, count: sm.count, ratio: row.amount_total / sm.median });
      }
      // layer 3: a hard ceiling for a single invoice
      if (row.amount_total >= Number(cfg.max_single_amount ?? 10000)) reasons.push({ code: "above_ceiling", ceiling: Number(cfg.max_single_amount ?? 10000) });
      if (reasons.length) {
        const cust = row.customer_name ?? "this customer";
        const day = row.invoice_date ?? (row.odoo_created_at ?? "").slice(0, 10);
        const r1 = reasons.find((r) => r.code === "above_usual" || r.code === "no_history");
        const r2 = reasons.find((r) => r.code === "above_salesman");
        const r3 = reasons.find((r) => r.code === "above_ceiling");
        const head = `${who}: SAR ${money(dayTotal)} invoiced to ${cust} on ${day}`;
        const title = r1?.code === "above_usual"
          ? `${head} - a usual day is about SAR ${money(Number(r1.median))} (highest SAR ${money(Number(r1.highest))})`
          : r1
            ? `${head} - ${who} has no usual pattern with this customer yet`
            : r2
              ? `${who}: invoice SAR ${money(row.amount_total)} to ${cust} - ${(Number(r2.ratio)).toFixed(1)}x ${who}'s typical invoice (SAR ${money(Number(r2.median))})`
              : `${who}: invoice SAR ${money(row.amount_total)} to ${cust} - above the SAR ${money(Number(r3?.ceiling))} single-invoice limit`;
        const usual = r1 && r1.code === "above_usual" ? r1 : null;
        out.push(base("unusual_amount", cfg, row, title, {
          reason_code: reasons[0].code, reasons: reasons.map((r) => r.code), day, day_total: Math.round(dayTotal * 100) / 100, day_invoices: hist.todayCount + 1,
          usual_amount: usual ? Math.round(Number(usual.median) * 100) / 100 : null, usual_highest: usual ? Math.round(Number(usual.highest) * 100) / 100 : null,
          usual_count: r1 ? Number(r1.days) : hist.days.length, similar_before: usual ? Number(usual.similar) : null, ratio: usual ? Math.round(Number(usual.ratio) * 10) / 10 : null,
          salesman_usual: r2 ? Math.round(Number(r2.median) * 100) / 100 : sm ? Math.round(sm.median * 100) / 100 : null,
          salesman_ratio: r2 ? Math.round(Number(r2.ratio) * 10) / 10 : null,
        }, `unusual_amount:${row.salesman_id}:${row.customer_id}:${day}`));
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
