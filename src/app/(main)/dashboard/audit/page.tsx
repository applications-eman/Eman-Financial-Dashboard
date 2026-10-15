import type { Metadata } from "next";

import { AuditView } from "./_components/audit-view";

export const metadata: Metadata = { title: "Audit Log" };

export default function Page() {
  return <AuditView />;
}
