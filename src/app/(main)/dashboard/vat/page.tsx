import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { VatView } from "./_components/vat-view";

export const metadata: Metadata = { title: "VAT Return" };

export default async function Page() {
  await requireAdmin();
  return <VatView />;
}
