import { addDays, riyadhDay } from "@/lib/format";

export interface SummaryRow {
  bucket: string;
  label: string;
  invoice_count: number;
  net_sales: number;
  vat: number;
  total: number;
  credit_count: number;
  credit_net: number;
  credit_vat: number;
  credit_total: number;
  net_after_credit: number;
  vat_after_credit: number;
  total_after_credit: number;
}

export type Group = "day" | "month" | "salesman" | "customer" | "segment";

export const num = (v: unknown) => Number(v ?? 0);

/** Supabase returns numeric columns as strings; normalise a revenue_summary row. */
export function toSummary(r: Record<string, unknown>): SummaryRow {
  return {
    bucket: String(r.bucket),
    label: String(r.label ?? r.bucket),
    invoice_count: num(r.invoice_count),
    net_sales: num(r.net_sales),
    vat: num(r.vat),
    total: num(r.total),
    credit_count: num(r.credit_count),
    credit_net: num(r.credit_net),
    credit_vat: num(r.credit_vat),
    credit_total: num(r.credit_total),
    net_after_credit: num(r.net_after_credit),
    vat_after_credit: num(r.vat_after_credit),
    total_after_credit: num(r.total_after_credit),
  };
}

export function sumRows(rows: SummaryRow[]): SummaryRow {
  const z = toSummary({ bucket: "", label: "" });
  for (const r of rows)
    for (const k of Object.keys(z) as (keyof SummaryRow)[])
      if (typeof z[k] === "number") (z[k] as number) += r[k] as number;
  return z;
}

export const today = () => riyadhDay(new Date());
export const monthStart = (day = today()) => `${day.slice(0, 7)}-01`;
export const weekAgo = () => addDays(today(), -6);

export function currentQuarter(day = today()): { year: number; quarter: number } {
  const [y, m] = day.split("-").map(Number);
  return { year: y, quarter: Math.floor((m - 1) / 3) + 1 };
}
export function quarterRange(year: number, quarter: number): { from: string; to: string } {
  const m = (quarter - 1) * 3 + 1;
  const from = `${year}-${String(m).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(year, m + 2, 0)).getUTCDate();
  return { from, to: `${year}-${String(m + 2).padStart(2, "0")}-${end}` };
}
