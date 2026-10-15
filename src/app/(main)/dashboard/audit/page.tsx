import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { AuditView } from "./_components/audit-view";

export const metadata: Metadata = { title: "Audit Log" };

export default async function Page() {
  await requireAdmin();
  return <AuditView />;
}
