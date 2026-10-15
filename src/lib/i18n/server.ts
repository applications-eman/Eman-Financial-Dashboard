import { cookies } from "next/headers";

import { DEFAULT_LANG, isLang, LANG_COOKIE, type Lang } from "./config";
import { type MessageKey, translate } from "./messages";

export async function getLang(): Promise<Lang> {
  const v = (await cookies()).get(LANG_COOKIE)?.value;
  return isLang(v) ? v : DEFAULT_LANG;
}

export async function getT() {
  const lang = await getLang();
  return { lang, t: (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars) };
}
