// Pure alert types and totals (no UI), so they can be unit-tested.
export type Severity = "critical" | "warning" | "info";
export type Status = "open" | "acknowledged" | "resolved";

export interface AlertRow {
  id: number;
  rule_key: string;
  severity: Severity;
  title: string;
  detail: Record<string, unknown>;
  section: string;
  salesman_name: string | null;
  amount: number | null;
  status: Status;
  note: string | null;
  handled_by: string | null;
  handled_at: string | null;
  created_at: string;
}

export interface InvoiceRef {
  number: string | null;
  issued_at: string | null;
}

export const isCredit = (a: AlertRow) => a.detail?.kind === "credit_note";
export const invoiceRefs = (a: AlertRow): InvoiceRef[] =>
  Array.isArray(a.detail?.invoices) ? (a.detail.invoices as InvoiceRef[]) : [];
export const str = (v: unknown) => (v == null || v === "" ? "" : String(v));

export interface AlertTotals {
  alerts: number;
  invoiceCount: number;
  invoiceTotal: number;
  creditCount: number;
  creditTotal: number;
  /** value of the EXTRA copies in repeated-invoice alerts (every copy after the first) */
  repeatedExtra: number;
}

/**
 * Totals for a list of alerts. Every invoice / credit note is counted ONCE, even when several alerts point to it
 * (a credit note can raise 3 alerts; a repeated-invoice alert lists all of its invoices).
 */
export function totalsOf(list: AlertRow[]): AlertTotals {
  const docs = new Map<string, { credit: boolean; amount: number }>();
  let repeatedExtra = 0;
  for (const a of list) {
    const amount = Number(a.amount ?? 0);
    const refs = invoiceRefs(a);
    if (refs.length) {
      for (const r of refs) docs.set(`n:${r.number}`, { credit: false, amount });
      if (a.rule_key === "duplicate_burst") repeatedExtra += amount * Math.max(0, refs.length - 1);
    } else {
      const key = str(a.detail?.number) ? `n:${str(a.detail?.number)}` : `id:${a.id}`;
      docs.set(key, { credit: isCredit(a), amount });
    }
  }
  const out: AlertTotals = {
    alerts: list.length,
    invoiceCount: 0,
    invoiceTotal: 0,
    creditCount: 0,
    creditTotal: 0,
    repeatedExtra,
  };
  for (const d of docs.values()) {
    if (d.credit) {
      out.creditCount++;
      out.creditTotal += d.amount;
    } else {
      out.invoiceCount++;
      out.invoiceTotal += d.amount;
    }
  }
  return out;
}
