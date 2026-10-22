import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { PlatformView } from "./_components/platform-view";

export const metadata: Metadata = { title: "WhatsApp Platform" };

export default async function Page() {
  await requireAdmin();
  return <PlatformView />;
}
