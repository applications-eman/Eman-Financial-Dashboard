"use client";

import { type FormEvent, useState } from "react";

import { Plus } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { platform } from "@/lib/platform-api";

import { change, usePlatformList } from "./use-platform";

interface Customer {
  id: string;
  name: string;
  vat: string | null;
  status: "active" | "frozen";
  salesmen: number;
}

export function CustomersTab() {
  const [q, setQ] = useState("");
  const { rows, error, load } = usePlatformList<Customer>(`/customers?limit=500&q=${encodeURIComponent(q.trim())}`);
  const [f, setF] = useState({ name: "", vat: "" });

  async function add(e: FormEvent) {
    e.preventDefault();
    const r = await change(
      () => platform("POST", "/customers", { name: f.name, vat: f.vat.trim() === "" ? null : f.vat.trim() }),
      "Customer added",
    );
    if (r) {
      setF({ name: "", vat: "" });
      void load();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Input
        className="max-w-sm"
        placeholder="Search by name or VAT number"
        aria-label="Search customers"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>VAT number</TableHead>
              <TableHead>Salesmen</TableHead>
              <TableHead>Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows ?? []).map((c) => (
              <TableRow key={c.id} className={c.status === "frozen" ? "opacity-60" : undefined}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell dir="ltr" className="text-start tabular-nums">
                  {c.vat ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{c.salesmen}</Badge>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={c.status === "active"}
                    aria-label={`Customer ${c.name} active`}
                    onCheckedChange={async (on) => {
                      await change(() => platform("PATCH", `/customers/${c.id}`, { status: on ? "active" : "frozen" }));
                      void load();
                    }}
                  />
                </TableCell>
              </TableRow>
            ))}
            {rows?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                  No customers found.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <form onSubmit={add} className="grid items-end gap-2 sm:grid-cols-[2fr_1.5fr_auto]">
        <div className="space-y-1">
          <Label htmlFor="c-name">Customer name</Label>
          <Input id="c-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="c-vat">VAT number (15 digits, optional)</Label>
          <Input id="c-vat" dir="ltr" value={f.vat} onChange={(e) => setF({ ...f, vat: e.target.value })} />
        </div>
        <Button type="submit">
          <Plus data-icon="inline-start" />
          Add customer
        </Button>
      </form>
    </div>
  );
}
