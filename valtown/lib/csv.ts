export const EXPORT_COLUMNS = ["section", "id", "invoice_date", "seller_name", "vat_number", "category", "total_amount", "vat_amount", "status", "source", "submitted_by", "notes", "warnings", "created_at"] as const;

const cell = (v: unknown) => {
  let s = Array.isArray(v) ? v.join("|") : v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(rows: Record<string, unknown>[]): string {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => cell(r[c])).join(","));
  return `﻿${lines.join("\r\n")}`; // BOM so Excel reads Arabic as UTF-8
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Excel-readable .xls (HTML table). */
export function toXls(rows: Record<string, unknown>[]): string {
  const head = `<tr>${EXPORT_COLUMNS.map((c) => `<th>${c}</th>`).join("")}</tr>`;
  const body = rows.map((r) => `<tr>${EXPORT_COLUMNS.map((c) => `<td>${esc(Array.isArray(r[c]) ? (r[c] as unknown[]).join("|") : String(r[c] ?? ""))}</td>`).join("")}</tr>`).join("");
  return `<html dir="rtl"><head><meta charset="utf-8"></head><body><table>${head}${body}</table></body></html>`;
}
