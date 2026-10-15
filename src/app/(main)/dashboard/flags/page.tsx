import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { FlagsView } from "./_components/flags-view";

export const metadata: Metadata = { title: "Feature Flags" };

export default async function Page() {
  await requireAdmin();
  return <FlagsView />;
}
