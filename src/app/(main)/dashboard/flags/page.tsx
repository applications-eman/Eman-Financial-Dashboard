import type { Metadata } from "next";

import { FlagsView } from "./_components/flags-view";

export const metadata: Metadata = { title: "Feature Flags" };

export default function Page() {
  return <FlagsView />;
}
