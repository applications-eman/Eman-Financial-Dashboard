import type { Store } from "./store.ts";

export type Lang = "en" | "ar";
const FALLBACK_TEMPLATES: Record<string, Record<Lang, string>> = {
  welcome: { en: "Welcome {{name}}. Tap the button to record an invoice.", ar: "أهلاً {{name}}. اضغط الزر لتسجيل فاتورة." },
  saved: { en: "Saved ✅\nSection: {{section}}\nSeller: {{seller}}\nTotal: {{total}} SAR\nVAT: {{vat}} SAR", ar: "تم الحفظ ✅\nالقسم: {{section}}\nالمورد: {{seller}}\nالإجمالي: {{total}} ر.س\nالضريبة: {{vat}} ر.س" },
  duplicate: { en: "Duplicate ⚠️ This invoice was already recorded.", ar: "مكررة ⚠️ هذه الفاتورة مسجلة مسبقاً." },
  invalid: { en: "Could not read the invoice: {{reason}}", ar: "تعذرت قراءة الفاتورة: {{reason}}" },
  not_allowed: { en: "This number is not registered. Please contact the administrator.", ar: "هذا الرقم غير مسجل. يرجى التواصل مع المسؤول." },
  admin_duplicate: { en: "⚠️ Duplicate attempt by {{name}} in {{section}}: {{seller}} {{total}} SAR", ar: "⚠️ محاولة تكرار من {{name}} في {{section}}: {{seller}} {{total}} ر.س" },
  admin_vat_warning: { en: "⚠️ VAT looks off ({{section}}): {{seller}} total {{total}}, VAT {{vat}}", ar: "⚠️ الضريبة غير متوافقة ({{section}}): {{seller}} الإجمالي {{total}} الضريبة {{vat}}" },
};

export async function getSetting<T = unknown>(store: Store, key: string, fallback: T): Promise<T> {
  const { rows } = await store.select("app_settings", { filters: [["key", "eq", key]], limit: 1 });
  return rows[0] ? (rows[0].value as T) : fallback;
}
export async function flagEnabled(store: Store, key: string, fallback = true): Promise<boolean> {
  const { rows } = await store.select("feature_flags", { filters: [["key", "eq", key]], limit: 1 });
  return rows[0] ? Boolean(rows[0].enabled) : fallback;
}

export function render(tpl: string, vars: Record<string, string | number | undefined>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ""));
}

export async function template(store: Store, name: string, lang: Lang, vars: Record<string, string | number | undefined>): Promise<string> {
  const all = await getSetting<Record<string, Partial<Record<Lang, string>>>>(store, "message_templates", {});
  const t = all[name]?.[lang] ?? all[name]?.en ?? FALLBACK_TEMPLATES[name]?.[lang] ?? FALLBACK_TEMPLATES[name]?.en ?? name;
  return render(t, vars);
}

export const sectionLabel = (s: string, lang: Lang) => (lang === "ar" ? (s === "bakery" ? "المخبز" : "البقالة") : s === "bakery" ? "Bakery" : "Grocery");
export const money2 = (n: number) => n.toFixed(2);
export const detectLang = (text: string): Lang => (/[؀-ۿ]/.test(text) ? "ar" : "en");
