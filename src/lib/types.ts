export const SECTIONS = ["bakery", "grocery"] as const;
export type Section = (typeof SECTIONS)[number];
export const SOURCES = ["whatsapp_flow", "whatsapp_text", "ios_shortcut", "admin_manual"] as const;
export const STATUSES = ["new", "reviewed", "exported"] as const;
export type Status = (typeof STATUSES)[number];

export interface Expense {
  id: string;
  seller_name: string | null;
  vat_number: string | null;
  invoice_date: string;
  total_amount: number;
  vat_amount: number;
  raw_qr: string | null;
  source: (typeof SOURCES)[number];
  submitted_by: string | null;
  category: string | null;
  notes: string | null;
  image_path: string | null;
  status: Status;
  warnings: string[];
  duplicate_count: number;
  created_at: string;
  updated_at: string | null;
}

export interface AppUser {
  id: string;
  auth_user_id: string | null;
  name: string;
  phone_e164: string | null;
  role: "admin" | "staff" | "accounts";
  sections: Section[];
  active: boolean;
  has_token: boolean;
  created_at: string;
}

export interface Category {
  id: string;
  section: Section;
  name: string;
  name_ar: string | null;
  active: boolean;
}

export interface Setting {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: string;
}

export interface Flag {
  key: string;
  enabled: boolean;
  description: string | null;
}

export interface AuditRow {
  id: number;
  actor: string | null;
  action: "INSERT" | "UPDATE" | "DELETE";
  table_name: string;
  record_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

export const expenseTable = (s: Section) => `${s}_expenses` as const;
export const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s);
