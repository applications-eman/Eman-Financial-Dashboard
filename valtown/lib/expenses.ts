import { z } from "npm:zod@4.6.7";
import { logger } from "./log.ts";
import type { Row, Store } from "./store.ts";
import { parseZatcaQr, QrParseError } from "./tlv.ts";
import { type ExpenseFields, expenseFieldsSchema, type Section, sectionTable, type Source, vatWarnings } from "./validate.ts";

export interface SaveResult {
  status: "saved" | "duplicate" | "invalid";
  message: string;
  row?: Row;
  existing?: Row;
  warnings?: string[];
  errors?: string[];
}

/** Resolve incoming fields from raw_qr (preferred, server-side parse) and/or explicit fields. */
export function resolveFields(input: Record<string, unknown>): { ok: true; fields: ExpenseFields } | { ok: false; errors: string[] } {
  let merged: Record<string, unknown> = { ...input };
  if (typeof input.raw_qr === "string" && input.raw_qr.trim()) {
    try {
      const p = parseZatcaQr(input.raw_qr);
      // QR content is authoritative for the five signed fields; caller can still add category/notes.
      merged = { ...merged, seller_name: p.seller_name, vat_number: p.vat_number, invoice_date: p.invoice_date, total_amount: p.total_amount, vat_amount: p.vat_amount, raw_qr: p.raw_qr };
      // Only trusted internal callers (the Flow confirm screen) pass total_override; public endpoints strip it.
      if (input.total_override != null) merged.total_amount = input.total_override;
    } catch (e) {
      const hasFields = input.vat_number && input.invoice_date && input.total_amount != null && input.vat_amount != null;
      if (!hasFields) return { ok: false, errors: [e instanceof QrParseError ? e.message : "invalid QR"] };
    }
  }
  const r = expenseFieldsSchema.safeParse(merged);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`) };
  return { ok: true, fields: r.data };
}

export async function saveExpense(
  store: Store,
  section: Section,
  input: Record<string, unknown>,
  ctx: { source: Source; submitted_by: string; image_path?: string; actor?: string },
): Promise<SaveResult> {
  const r = resolveFields(input);
  if (!r.ok) return { status: "invalid", message: r.errors.join("; "), errors: r.errors };
  const f = r.fields;
  const table = sectionTable(section);
  const row = {
    seller_name: f.seller_name || null, vat_number: f.vat_number, invoice_date: f.invoice_date,
    total_amount: f.total_amount, vat_amount: f.vat_amount, raw_qr: f.raw_qr ?? null,
    source: ctx.source, submitted_by: ctx.submitted_by, category: f.category || null, notes: f.notes || null,
    image_path: ctx.image_path ?? null,
  };
  const ins = await store.insert(table, row, ctx.actor ?? ctx.submitted_by);
  if (ins.ok) return { status: "saved", message: "saved", row: ins.row, warnings: ins.row.warnings ?? vatWarnings(f.total_amount, f.vat_amount) };
  if (ins.conflict) {
    let { rows } = await store.select(table, {
      filters: [["vat_number", "eq", f.vat_number], ["invoice_date", "eq", f.invoice_date], ["total_amount", "eq", f.total_amount]], limit: 1,
    });
    // an edited total changes the triple, but the same QR can only ever be recorded once
    if (!rows[0] && f.raw_qr) rows = (await store.select(table, { filters: [["raw_qr", "eq", f.raw_qr]], limit: 1 })).rows;
    const existing = rows[0];
    if (existing) {
      await store.update(table, [["id", "eq", existing.id]], { duplicate_count: (existing.duplicate_count ?? 0) + 1 }, ctx.actor ?? ctx.submitted_by).catch(() => []);
    }
    return { status: "duplicate", message: "duplicate invoice", existing };
  }
  logger.error("expense insert failed", { table, error: ins.error });
  return { status: "invalid", message: "could not save the invoice", errors: [ins.error] };
}

export const zodMessage = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
