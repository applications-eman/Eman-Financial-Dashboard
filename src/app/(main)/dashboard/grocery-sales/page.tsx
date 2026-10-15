import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { GrocerySalesView } from "./_components/grocery-sales-view";

export const metadata: Metadata = { title: "Grocery Sales" };

export default async function Page() {
  await requireAdmin();
  return <GrocerySalesView />;
}
