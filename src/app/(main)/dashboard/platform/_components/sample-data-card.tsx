"use client";

import { useState } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { platform } from "@/lib/platform-api";

import { change } from "./use-platform";

/** Test mode only: fills the platform with TEST customers, categories and products so the WhatsApp form can be tried with real-looking lists. */
export function SampleDataCard() {
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const added = await change(() => platform<{ customers: number; products: number }>("POST", "/sample-data"));
      if (!added) return;
      const linked = await change(() =>
        platform<{
          customers: { linked: number; unmatched: string[] };
          products: { linked: number; unmatched: string[] };
        }>("POST", "/odoo/link"),
      );
      const missing = (linked?.customers.unmatched.length ?? 0) + (linked?.products.unmatched.length ?? 0);
      toast.success(
        `Added ${added.customers} customers and ${added.products} products. Linked to Odoo: ${
          (linked?.customers.linked ?? 0) + (linked?.products.linked ?? 0)
        }.${missing > 0 ? ` ${missing} not found in Odoo yet (create them there with the same names).` : ""}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="font-medium text-sm">Sample data for testing</p>
      <p className="text-muted-foreground text-xs">
        Adds 7 TEST customers and 4 TEST categories with 5 products each, gives the customers to every active salesman,
        and links them to Odoo by name. Works only while Test mode is on. Safe to press again.
      </p>
      <Button variant="outline" size="sm" disabled={busy} onClick={load}>
        {busy ? "Adding…" : "Add sample data"}
      </Button>
    </div>
  );
}
