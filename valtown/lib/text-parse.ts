// Parses a WhatsApp text message into invoice input: Base64 QR payload, labelled lines, or five plain fields.
import { normalizeDigits } from "./tlv.ts";
import type { Section } from "./validate.ts";

export interface TextParse {
  section?: Section;
  input?: Record<string, unknown>;
  error?: string;
}

const BAKERY = /(bakery|مخبز|مخابز|مخبزة)/i;
const GROCERY = /(grocery|بقالة|بقاله|سوبر)/i;

export function detectSection(text: string): Section | undefined {
  const b = BAKERY.test(text), g = GROCERY.test(text);
  return b === g ? undefined : b ? "bakery" : "grocery";
}

const LABELS: Record<string, RegExp> = {
  seller_name: /^(seller|supplier|vendor|name|المورد|البائع|اسم)/i,
  vat_number: /^(vat\s*(no|number|#)?|tax\s*(no|number)?|الرقم الضريبي|رقم ضريبي|الضريبي)/i,
  invoice_date: /^(date|time|التاريخ|تاريخ)/i,
  total_amount: /^(total|amount|grand|الإجمالي|الاجمالي|المجموع|المبلغ)/i,
  vat_amount: /^(vat\s*(amount|value)|tax\s*amount|ضريبة|الضريبة|قيمة الضريبة)/i,
};

export function parseTextMessage(raw: string): TextParse {
  const text = normalizeDigits(raw).trim();
  const section = detectSection(raw);

  // 1) Base64 QR string anywhere in the message
  const b64 = text.match(/[A-Za-z0-9+/_-]{40,}={0,2}/);
  if (b64 && !/\s/.test(b64[0])) return { section, input: { raw_qr: b64[0] } };

  // 2) labelled lines "label: value"
  const lines = text.split(/\r?\n|;|،|,(?=\s*[A-Za-z؀-ۿ]+\s*[:：])/).map((l) => l.trim()).filter(Boolean);
  const labelled: Record<string, string> = {};
  for (const l of lines) {
    const m = l.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (!m) continue;
    const label = m[1].trim();
    // vat_amount must be tested before vat_number since both start with "vat"
    const order = ["vat_amount", "vat_number", "seller_name", "invoice_date", "total_amount"];
    const key = order.find((k) => LABELS[k].test(label));
    if (key && !labelled[key]) labelled[key] = m[2].trim();
  }
  if (labelled.vat_number && labelled.total_amount && labelled.vat_amount && labelled.invoice_date) return { section, input: labelled };

  // 3) five fields separated by newlines or commas, in canonical order
  const parts = text.split(/\r?\n|\s*[|;]\s*/).map((s) => s.trim()).filter(Boolean);
  const cand = parts.length >= 5 ? parts : text.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  if (cand.length >= 5) {
    const [seller_name, vat_number, invoice_date, total_amount, vat_amount] = cand;
    return { section, input: { seller_name, vat_number, invoice_date, total_amount, vat_amount } };
  }
  return { section, error: "no invoice data found" };
}
