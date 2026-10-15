export const LANGS = ["en", "ar"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "en";
export const LANG_COOKIE = "lang";
export const dirOf = (lang: Lang) => (lang === "ar" ? "rtl" : "ltr");
export const isLang = (v: string | undefined): v is Lang => v === "en" || v === "ar";
