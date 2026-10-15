// "Verify data": re-reads Odoo live (read-only aggregates) for a period and compares it with what the dashboard stored.
// Also re-computes the output VAT from the raw Odoo totals. Every run is saved in verification_runs.
import type { Domain, OdooReader } from "./odoo.ts";
import type { Row, Store } from "./store.ts";

export interface Check { metric: string; odoo: number; dashboard: number; diff: number; ok: boolean }
export interface VerifyResult { from: string; to: string; ok: boolean; checks: Check[]; zatca: Check[]; vat: { odoo_output_vat: number; dashboard_output_vat: number; quarter?: string; vat_return_output_vat?: number }; checked_at: string }

const r2 = (n: number) => Math.round(n * 100) / 100;
const TOL = 0.01;
const mk = (metric: string, odoo: number, dashboard: number): Check => ({ metric, odoo: r2(odoo), dashboard: r2(dashboard), diff: r2(odoo - dashboard), ok: Math.abs(odoo - dashboard) <= TOL });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function quarterOf(from: string, to: string): { year: number; quarter: number } | null {
  const [y, m, d] = from.split("-").map(Number);
  if (d !== 1 || (m - 1) % 3 !== 0) return null;
  const end = new Date(Date.UTC(y, m - 1 + 3, 0)).toISOString().slice(0, 10);
  return end === to ? { year: y, quarter: (m - 1) / 3 + 1 } : null;
}

export async function verifyPeriod(store: Store, odoo: OdooReader, from: string, to: string, runBy: string): Promise<VerifyResult> {
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw new Error("invalid period");
  const base: Domain = [["move_type", "in", ["out_invoice", "out_refund"]], ["state", "=", "posted"], ["invoice_date", ">=", from], ["invoice_date", "<=", to]];
  const byType = await odoo.readGroup("account.move", base, ["amount_untaxed:sum", "amount_tax:sum", "amount_total:sum"], ["move_type"]);
  const o = { inv: { n: 0, net: 0, vat: 0, tot: 0 }, cn: { n: 0, net: 0, vat: 0, tot: 0 } };
  for (const g of byType) {
    const t = g.move_type === "out_refund" ? o.cn : o.inv;
    t.n += Number(g.__count ?? g.move_type_count ?? 0); t.net += Number(g.amount_untaxed ?? 0); t.vat += Number(g.amount_tax ?? 0); t.tot += Number(g.amount_total ?? 0);
  }
  const rows = (await store.rpc("revenue_summary", { p_from: from, p_to: to, p_group: "segment", p_segment: null, p_section: "bakery" })) as Row[];
  const d = rows.reduce((a, r) => ({
    n: a.n + Number(r.invoice_count), net: a.net + Number(r.net_sales), vat: a.vat + Number(r.vat), tot: a.tot + Number(r.total),
    cn: a.cn + Number(r.credit_count), cnet: a.cnet + Number(r.credit_net), cvat: a.cvat + Number(r.credit_vat), ctot: a.ctot + Number(r.credit_total),
  }), { n: 0, net: 0, vat: 0, tot: 0, cn: 0, cnet: 0, cvat: 0, ctot: 0 });
  const checks = [
    mk("invoices (count)", o.inv.n, d.n), mk("sales excl. VAT", o.inv.net, d.net), mk("VAT on sales", o.inv.vat, d.vat), mk("sales incl. VAT", o.inv.tot, d.tot),
    mk("credit notes (count)", o.cn.n, d.cn), mk("credit notes excl. VAT", o.cn.net, d.cnet), mk("credit notes VAT", o.cn.vat, d.cvat), mk("credit notes incl. VAT", o.cn.tot, d.ctot),
  ];

  const zg = await odoo.readGroup("account.move", base, ["id:count"], ["edi_state"]);
  const zatca: Check[] = [];
  for (const g of zg) {
    const st = g.edi_state === false || g.edi_state == null ? null : String(g.edi_state);
    const filters = [["state", "eq", "posted"], ["section", "eq", "bakery"], ["invoice_date", "gte", from], ["invoice_date", "lte", to], st === null ? ["zatca_state", "is", "null"] : ["zatca_state", "eq", st]] as [string, any, unknown][];
    const { count } = await store.select("sales_invoices", { columns: "odoo_id", filters, limit: 1 });
    zatca.push(mk(`ZATCA status: ${st ?? "none"}`, Number(g.__count ?? g.edi_state_count ?? 0), count));
  }
  // states that exist only in the dashboard
  const seen = new Set(zg.map((g) => (g.edi_state ? String(g.edi_state) : "none")));
  for (const st of ["sent", "to_send", "to_cancel", "cancelled"]) {
    if (seen.has(st)) continue;
    const { count } = await store.select("sales_invoices", { columns: "odoo_id", filters: [["state", "eq", "posted"], ["section", "eq", "bakery"], ["invoice_date", "gte", from], ["invoice_date", "lte", to], ["zatca_state", "eq", st]], limit: 1 });
    if (count) zatca.push(mk(`ZATCA status: ${st}`, 0, count));
  }

  const vat: VerifyResult["vat"] = { odoo_output_vat: r2(o.inv.vat - o.cn.vat), dashboard_output_vat: r2(d.vat - d.cvat) };
  const q = quarterOf(from, to);
  checks.push(mk("output VAT (net of credit notes)", vat.odoo_output_vat, vat.dashboard_output_vat));
  if (q) {
    const vr = (await store.rpc("vat_return", { p_year: q.year, p_quarter: q.quarter })) as unknown as Row;
    const b = (vr as any)?.bakery_sales ?? (vr as any)?.sales?.bakery;
    if (b) {
      vat.quarter = `${q.year} Q${q.quarter}`;
      vat.vat_return_output_vat = r2(Number(b.vat) - Number(b.credit_vat));
      checks.push(mk("VAT return screen vs Odoo", vat.odoo_output_vat, vat.vat_return_output_vat));
    }
  }
  const result: VerifyResult = { from, to, ok: [...checks, ...zatca].every((c) => c.ok), checks, zatca, vat, checked_at: new Date().toISOString() };
  await store.insert("verification_runs", { kind: "odoo_compare", period_from: from, period_to: to, ok: result.ok, result, run_by: runBy });
  return result;
}
