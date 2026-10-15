"use client";

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import { useRouter } from "next/navigation";

import { DirectionProvider } from "@/components/ui/direction";

import { dirOf, LANG_COOKIE, type Lang } from "./config";
import { type MessageKey, translate } from "./messages";

interface I18n {
  lang: Lang;
  dir: "ltr" | "rtl";
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  setLang: (lang: Lang) => void;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ initialLang, children }: { initialLang: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const router = useRouter();

  const setLang = useCallback(
    (next: Lang) => {
      document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      document.documentElement.lang = next;
      document.documentElement.dir = dirOf(next);
      setLangState(next);
      router.refresh();
    },
    [router],
  );

  const value = useMemo<I18n>(
    () => ({ lang, dir: dirOf(lang), setLang, t: (key, vars) => translate(lang, key, vars) }),
    [lang, setLang],
  );

  return (
    <Ctx.Provider value={value}>
      <DirectionProvider dir={value.dir}>{children}</DirectionProvider>
    </Ctx.Provider>
  );
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n must be used inside <I18nProvider>");
  return v;
}
export const useT = () => useI18n().t;
