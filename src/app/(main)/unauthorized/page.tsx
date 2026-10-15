import { Lock } from "lucide-react";
import type { Metadata } from "next";

import { Button } from "@/components/ui/button";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Not authorized", robots: { index: false, follow: false } };

export default async function Page() {
  const { t } = await getT();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12">
      <div className="mx-auto max-w-md text-center">
        <Lock className="mx-auto size-12 text-primary" aria-hidden="true" />
        <h1 className="mt-4 font-bold text-3xl tracking-tight">{t("unauthorized.title")}</h1>
        <p className="mt-4 text-muted-foreground">{t("unauthorized.body")}</p>
        <form action="/auth/signout" method="post" className="mt-6">
          <Button type="submit">{t("nav.signOut")}</Button>
        </form>
      </div>
    </main>
  );
}
