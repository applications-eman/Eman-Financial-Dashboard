import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { RevenueView } from "./_components/revenue-view";

export const metadata: Metadata = { title: "Revenue" };

export default async function Page() {
  await requireAdmin();
  return <RevenueView />;
}
