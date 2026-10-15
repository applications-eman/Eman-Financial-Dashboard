import type { Metadata } from "next";

import { ExpensesView } from "../_components/expenses/expenses-view";

export const metadata: Metadata = { title: "Bakery Expenses" };

export default function Page() {
  return <ExpensesView section="bakery" />;
}
