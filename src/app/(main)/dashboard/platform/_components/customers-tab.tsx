"use client";

import { type FormEvent, useState } from "react";

import { Plus, Trash2 } from "lucide-react";

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
  const [f, setF] = useState({ name: "", vat: "", street: "", district: "", city: "", zip: "", building: "" });

  async function add(e: FormEvent) {
    e.preventDefault();
    const r = await change(
      () =>
        platform("POST", "/customers", {
          name: f.name,
          vat: f.vat.trim() === "" ? null : f.vat.trim(),
          // the address is only sent when the customer has a VAT number (a company); the country and region fill themselves in
          ...(f.vat.trim() === ""
            ? {}
            : {
                street: f.street || null,
                district: f.district || null,
                city: f.city || null,
                zip: f.zip || null,
                building_number: f.building || null,
              }),
        }),
      "Customer added",
    );
    if (r) {
      setF({ name: "", vat: "", street: "", district: "", city: "", zip: "", building: "" });
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
              <TableHead className="text-end">
                <span className="sr-only">Actions</span>
              </TableHead>
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
                <TableCell>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${c.name}`}
                      onClick={async () => {
                        if (!confirm(`Delete the customer "${c.name}"? Only possible if it was never invoiced.`))
                          return;
                        await change(() => platform("DELETE", `/customers/${c.id}`), "Deleted");
                        void load();
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {rows?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
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
        {f.vat.trim() !== "" ? (
          <fieldset className="grid gap-2 rounded-lg border p-3 sm:col-span-3 sm:grid-cols-5">
            <legend className="px-1 text-muted-foreground text-xs">
              Address of the company (needed on its tax invoices). The country and region are filled in automatically.
            </legend>
            {(
              [
                ["street", "Street"],
                ["district", "District"],
                ["city", "City"],
                ["zip", "Postal code"],
                ["building", "Building no. (4 digits)"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`c-${key}`}>{label}</Label>
                <Input id={`c-${key}`} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
              </div>
            ))}
          </fieldset>
        ) : null}
        <Button type="submit">
          <Plus data-icon="inline-start" />
          Add customer
        </Button>
      </form>
      <p className="text-muted-foreground text-xs">
        A customer added here is created in Odoo at once. Nothing has to be entered twice.
      </p>
    </div>
  );
}
