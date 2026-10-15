import type { Metadata } from "next";

import { ZatcaView } from "./_components/zatca-view";

export const metadata: Metadata = { title: "ZATCA" };

export default function Page() {
  return <ZatcaView />;
}
