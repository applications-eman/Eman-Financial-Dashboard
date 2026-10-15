"use client";

import { Languages } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/provider";

export function LangToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => setLang(lang === "en" ? "ar" : "en")}
      aria-label={t("common.language")}
    >
      <Languages data-icon="inline-start" />
      {lang === "en" ? "العربية" : "English"}
    </Button>
  );
}
