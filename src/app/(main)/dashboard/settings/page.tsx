import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { SettingsView } from "./_components/settings-view";

export const metadata: Metadata = { title: "Settings" };

export default async function Page() {
  await requireAdmin();
  return <SettingsView />;
}
