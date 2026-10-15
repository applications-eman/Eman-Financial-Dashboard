import type { Metadata } from "next";

import { CategoriesView } from "./_components/categories-view";

export const metadata: Metadata = { title: "Categories" };

export default function Page() {
  return <CategoriesView />;
}
