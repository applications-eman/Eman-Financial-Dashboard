// Pure aggregation helpers for the live dashboard (all day/month boundaries are Asia/Riyadh).
import { addDays, riyadhDay, riyadhMonth, shortDay } from "./format.ts";

export interface Row {
  seller_name: string | null;
  invoice_date: string;
  total_amount: number;
  vat_amount: number;
  category: string | null;
}
export interface Totals {
  count: number;
  total: number;
  vat: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function sumRows(rows: readonly Row[]): Totals {
  let total = 0;
  let vat = 0;
  for (const r of rows) {
    total += Number(r.total_amount);
    vat += Number(r.vat_amount);
  }
  return { count: rows.length, total: round2(total), vat: round2(vat) };
}

export function kpis(rows: readonly Row[], now: Date) {
  const today = riyadhDay(now);
  const month = riyadhMonth(now);
  return {
    today: sumRows(rows.filter((r) => riyadhDay(r.invoice_date) === today)),
    month: sumRows(rows.filter((r) => riyadhMonth(r.invoice_date) === month)),
  };
}

export interface DayPoint {
  day: string;
  label: string;
  bakery: number;
  grocery: number;
}
export function dailySeries(bakery: readonly Row[], grocery: readonly Row[], days: number, now: Date): DayPoint[] {
  const end = riyadhDay(now);
  const out: DayPoint[] = [];
  const index = new Map<string, DayPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(end, -i);
    const p = { day, label: shortDay(day), bakery: 0, grocery: 0 };
    out.push(p);
    index.set(day, p);
  }
  for (const [key, rows] of [
    ["bakery", bakery],
    ["grocery", grocery],
  ] as const) {
    for (const r of rows) {
      const p = index.get(riyadhDay(r.invoice_date));
      if (p) p[key] = round2(p[key] + Number(r.total_amount));
    }
  }
  return out;
}

export function byCategory(rows: readonly Row[], top = 8): { name: string; value: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.category ?? "", (m.get(r.category ?? "") ?? 0) + Number(r.total_amount));
  return [...m.entries()]
    .map(([name, value]) => ({ name, value: round2(value) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, top);
}

export interface SupplierStat {
  name: string;
  total: number;
  count: number;
  last: string;
}
export function bySupplier(rows: readonly Row[], top = 8): SupplierStat[] {
  const m = new Map<string, SupplierStat>();
  for (const r of rows) {
    const name = (r.seller_name ?? "").trim();
    const s = m.get(name) ?? { name, total: 0, count: 0, last: r.invoice_date };
    s.total += Number(r.total_amount);
    s.count += 1;
    if (r.invoice_date > s.last) s.last = r.invoice_date;
    m.set(name, s);
  }
  return [...m.values()]
    .map((s) => ({ ...s, total: round2(s.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, top);
}
