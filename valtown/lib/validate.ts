import { z } from "npm:zod@4.6.7";
import { normalizeDigits, normalizeTimestamp, parseAmount } from "./tlv.ts";

export const SECTIONS = ["bakery", "grocery"] as const;
export type Section = (typeof SECTIONS)[number];
export const SOURCES = ["whatsapp_flow", "whatsapp_text", "ios_shortcut", "admin_manual"] as const;
export type Source = (typeof SOURCES)[number];
export const sectionTable = (s: Section) => `${s}_expenses` as const;
export const isSection = (s: unknown): s is Section => s === "bakery" || s === "grocery";

const money = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    try { return typeof v === "number" ? Math.round(v * 100) / 100 : parseAmount(v); }
    catch { ctx.addIssue({ code: "custom", message: "invalid amount" }); return z.NEVER; }
  })
  .pipe(z.number().min(0, "amount must be >= 0").max(9_999_999_999.99));

const date = z.string().transform((v, ctx) => {
  try { return normalizeTimestamp(v); } catch { ctx.addIssue({ code: "custom", message: "invalid invoice_date" }); return z.NEVER; }
});

export const expenseFieldsSchema = z
  .object({
    seller_name: z.string().trim().max(300).default(""),
    vat_number: z.string().transform((v) => normalizeDigits(v).replace(/\s/g, "")).pipe(z.string().regex(/^\d{15}$/, "vat_number must be 15 digits")),
    invoice_date: date,
    total_amount: money,
    vat_amount: money,
    raw_qr: z.string().max(5000).optional(),
    category: z.string().trim().max(100).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.vat_amount <= v.total_amount, { message: "vat_amount cannot exceed total_amount", path: ["vat_amount"] });
export type ExpenseFields = z.infer<typeof expenseFieldsSchema>;

/** Mirrors the DB trigger compute_expense_warnings(): flags VAT that is not ~ vatRate of the net amount. */
export function vatWarnings(total: number, vat: number, vatRate = 0.15): string[] {
  const net = total - vat;
  const expected = Math.round(net * vatRate * 100) / 100;
  if (net <= 0 && vat > 0) return ["vat_rate_mismatch"];
  return Math.abs(vat - expected) > 0.05 + 0.005 * net ? ["vat_rate_mismatch"] : [];
}

export const shortcutBodySchema = z.object({
  section: z.enum(SECTIONS),
  token: z.string().min(10).max(200),
  raw_qr: z.string().optional(),
  seller_name: z.string().optional(),
  vat_number: z.string().optional(),
  invoice_date: z.string().optional(),
  total_amount: z.union([z.number(), z.string()]).optional(),
  vat_amount: z.union([z.number(), z.string()]).optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
});

export const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "phone must be E.164, e.g. +9665XXXXXXXX");
export const normalizePhone = (p: string) => {
  const d = normalizeDigits(p).replace(/[^\d]/g, "");
  return d ? `+${d}` : "";
};
