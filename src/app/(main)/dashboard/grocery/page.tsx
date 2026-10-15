import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { ExpensesView } from "../_components/expenses/expenses-view";

export const metadata: Metadata = { title: "Grocery Expenses" };

export default async function Page() {
  await requireAdmin();
  return <ExpensesView section="grocery" />;
}
