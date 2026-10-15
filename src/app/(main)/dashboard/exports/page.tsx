import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { ExportsView } from "./_components/exports-view";

export const metadata: Metadata = { title: "Exports" };

export default async function Page() {
  await requireAdmin();
  return <ExportsView />;
}
