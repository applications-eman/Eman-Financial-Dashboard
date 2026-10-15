export interface SalesRow {
  odoo_id: number;
  section: "bakery" | "grocery";
  number: string | null;
  kind: "invoice" | "credit_note";
  state: string;
  invoice_date: string | null;
  odoo_created_at: string | null;
  odoo_write_at: string | null;
  salesman_id: number | null;
  salesman_name: string | null;
  created_by_id: number | null;
  created_by_name: string | null;
  write_by_name?: string | null; // not stored; used in alert details
  customer_id: number | null;
  customer_name: string | null;
  customer_vat: string | null;
  amount_untaxed: number;
  amount_tax: number;
  amount_total: number;
  payment_state: string | null;
  origin: string | null;
  ref: string | null;
  reversed_odoo_id: number | null;
  reversed_number: string | null;
  zatca_state: string | null;
  zatca_uuid: string | null;
  zatca_chain_index: number | null;
  zatca_confirmed_at: string | null;
  zatca_error: string | null;
  segment?: "B2B" | "B2C";
}

export type Severity = "info" | "warning" | "critical";

export interface AlertDraft {
  rule_key: string;
  severity: Severity;
  title: string;
  detail: Record<string, unknown>;
  section?: string;
  salesman_name?: string | null;
  odoo_id?: number | null;
  amount?: number | null;
  fingerprint: string;
}

export type RuleCfg = { enabled: boolean; severity: Severity; [k: string]: any };
export type RulesConfig = Record<string, RuleCfg>;

export const DEFAULT_RULES: RulesConfig = {
  credit_any: { enabled: true, severity: "warning" },
  credit_amount: { enabled: true, severity: "critical", min_amount: 500 },
  credit_per_salesman_day: { enabled: true, severity: "warning", max_per_day: 3 },
  credit_old_invoice: { enabled: true, severity: "warning", max_age_days: 3 },
  credit_by_office: { enabled: true, severity: "info", office_users: ["EMAN BAKERY"] },
  credit_no_reason: { enabled: true, severity: "warning" },
  credit_period_end: { enabled: true, severity: "warning", days_before_quarter_end: 5 },
  refund_unlinked: { enabled: true, severity: "warning" },
  tiny_invoice: { enabled: true, severity: "info", max_amount: 2 },
  zero_tax_invoice: { enabled: true, severity: "warning" },
  zero_tax_ratio: { enabled: true, severity: "warning", min_ratio_pct: 20, min_invoices: 10, window_days: 7 },
  invoice_cancelled: { enabled: true, severity: "critical" },
  invoice_backdated: { enabled: true, severity: "warning", max_days: 1 },
  number_gap: { enabled: true, severity: "critical" },
  duplicate_burst: { enabled: true, severity: "warning", window_minutes: 10, min_count: 3 },
  unusual_amount: { enabled: true, severity: "warning", multiplier: 8, min_amount: 1000 },
  off_hours: { enabled: true, severity: "info" },
  sales_drop: { enabled: true, severity: "warning", drop_pct: 60, check_after_hour: 15, min_usual_amount: 500 },
  no_sales_by_time: { enabled: false, severity: "info", by_hour: 11 },
  unpaid_invoice: { enabled: false, severity: "info", after_hours: 72 },
  zatca_delay_b2b: { enabled: true, severity: "critical" },
  zatca_delay_b2c: { enabled: true, severity: "warning" },
  zatca_error: { enabled: true, severity: "critical" },
  zatca_chain_gap: { enabled: true, severity: "critical" },
};
export const DEFAULT_ZATCA = { b2b_minutes: 5, b2c_hours: 24, b2c_warn_hours: 12 };
export const DEFAULT_HOURS = { start_hour: 5, end_hour: 23 };

export function mergeRules(stored: unknown): RulesConfig {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, Partial<RuleCfg>>;
  const out: RulesConfig = {};
  for (const [k, d] of Object.entries(DEFAULT_RULES)) out[k] = { ...d, ...(s[k] ?? {}) } as RuleCfg;
  return out;
}

export const segmentOf = (vat: string | null | undefined): "B2B" | "B2C" => (vat && vat.trim() ? "B2B" : "B2C");
