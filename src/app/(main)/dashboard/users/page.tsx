import type { Metadata } from "next";

import { requireAdmin } from "@/lib/supabase/server";

import { UsersView } from "./_components/users-view";

export const metadata: Metadata = { title: "Users" };

export default async function Page() {
  await requireAdmin();
  return <UsersView />;
}
