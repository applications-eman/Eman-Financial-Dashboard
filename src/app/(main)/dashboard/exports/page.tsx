import type { Metadata } from "next";

import { ExportsView } from "./_components/exports-view";

export const metadata: Metadata = { title: "Exports" };

export default function Page() {
  return <ExportsView />;
}
