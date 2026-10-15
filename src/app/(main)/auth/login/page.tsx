import { Command } from "lucide-react";
import type { Metadata } from "next";

import { APP_CONFIG } from "@/config/app-config";
import { getT } from "@/lib/i18n/server";

import { LangToggle } from "../_components/lang-toggle";
import { LoginForm } from "../_components/login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { t } = await getT();
  const { next, error } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <Command className="size-5" aria-hidden="true" />
            {APP_CONFIG.name}
          </div>
          <LangToggle />
        </div>
        <div className="space-y-1">
          <h1 className="font-semibold text-2xl tracking-tight">{t("auth.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("auth.subtitle")}</p>
        </div>
        <LoginForm next={next} callbackError={error === "callback"} />
      </div>
    </main>
  );
}
