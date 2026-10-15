import type { Metadata } from "next";

import { getT } from "@/lib/i18n/server";
import { requireAdmin } from "@/lib/supabase/server";

import { LiveDashboard } from "./_components/home/live-dashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default async function Page() {
  await requireAdmin();
  const { t } = await getT();
  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">{t("dashboard.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("dashboard.subtitle")}</p>
      </div>
      <LiveDashboard />
    </div>
  );
}
