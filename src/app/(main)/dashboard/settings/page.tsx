import type { Metadata } from "next";

import { SettingsView } from "./_components/settings-view";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return <SettingsView />;
}
