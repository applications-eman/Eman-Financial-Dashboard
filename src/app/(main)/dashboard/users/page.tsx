import type { Metadata } from "next";

import { UsersView } from "./_components/users-view";

export const metadata: Metadata = { title: "Users" };

export default function Page() {
  return <UsersView />;
}
