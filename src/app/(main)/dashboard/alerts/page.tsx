import type { Metadata } from "next";

import { AlertsView } from "./_components/alerts-view";

export const metadata: Metadata = { title: "Alerts" };

// open to admin and accounts users (the dashboard layout already blocks everybody else)
export default function Page() {
  return <AlertsView />;
}
