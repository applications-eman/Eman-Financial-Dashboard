import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { CategoriesView } from "./_components/categories-view";

export const metadata: Metadata = { title: "Categories" };

export default async function Page() {
  await requireAdmin();
  return <CategoriesView />;
}
