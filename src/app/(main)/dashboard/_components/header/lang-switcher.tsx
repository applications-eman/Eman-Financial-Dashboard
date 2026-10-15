"use client";

import { Languages } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";

export function LangSwitcher() {
  const { lang, setLang, t } = useI18n();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => setLang(lang === "en" ? "ar" : "en")}
      aria-label={`${t("common.language")}: ${lang === "en" ? "العربية" : "English"}`}
      title={lang === "en" ? "العربية" : "English"}
    >
      <Languages />
    </Button>
  );
}
