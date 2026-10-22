"use client";

import { type ReactNode, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { platform } from "@/lib/platform-api";

import { change } from "./use-platform";

interface Status {
  configured: boolean;
  company?: string;
  error?: string;
}
interface LinkResult {
  customers: { linked: number; unmatched: string[] };
  products: { linked: number; unmatched: string[] };
}

export function OdooCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [result, setResult] = useState<LinkResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    platform<Status>("GET", "/odoo/status")
      .then(setStatus)
      .catch((e: Error) => setStatus({ configured: true, error: e.message }));
  }, []);

  async function link() {
    setBusy(true);
    const r = await change(() => platform<LinkResult>("POST", "/odoo/link"), "Done");
    setBusy(false);
    if (r) setResult(r);
  }

  let badge: ReactNode = null;
  if (status) {
    if (status.configured && !status.error) badge = <Badge>Connected: {status.company}</Badge>;
    else badge = <Badge variant="destructive">{status.configured ? "Problem" : "Not connected yet"}</Badge>;
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Odoo connection</h2>
        {badge}
      </div>
      {status?.error ? <p className="text-destructive text-sm">{status.error}</p> : null}
      {status?.configured === false ? (
        <p className="text-muted-foreground text-sm">
          Invoicing is switched on after Odoo and WhatsApp are connected to the service.
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          Every customer and product must be linked to its Odoo record before it can be invoiced. Matching uses the VAT
          number, then the exact name.
        </p>
        <Button
          className="w-fit"
          variant="outline"
          onClick={link}
          disabled={busy || !status?.configured || Boolean(status?.error)}
        >
          Link customers and products to Odoo
        </Button>
      </div>
      {result ? (
        <div className="text-sm">
          <p>
            Customers linked: {result.customers.linked}. Products linked: {result.products.linked}.
          </p>
          {[
            ...result.customers.unmatched.map((n) => `Customer: ${n}`),
            ...result.products.unmatched.map((n) => `Product: ${n}`),
          ].length > 0 ? (
            <p className="mt-1 text-muted-foreground">
              Not found in Odoo (check the name or VAT number, or create it in Odoo):{" "}
              {[
                ...result.customers.unmatched.map((n) => `customer ${n}`),
                ...result.products.unmatched.map((n) => `product ${n}`),
              ].join("; ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
