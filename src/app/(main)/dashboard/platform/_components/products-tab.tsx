"use client";

import { type FormEvent, useState } from "react";

import { Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { platform } from "@/lib/platform-api";

import { change, usePlatformList } from "./use-platform";

interface Product {
  id: string;
  name: string;
  category: string | null;
  max_price: string | null;
  status: string;
}

/** CSV lines "name, category, max price" (a header line is skipped; Excel can save/copy as CSV). */
function parseRows(text: string) {
  const rows: { name: string; category?: string; max_price: number | null }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/[,\t;]/).map((s) => s.trim());
    if (!cells[0]) continue;
    const price = cells[2] === undefined || cells[2] === "" ? null : Number(cells[2]);
    if (price !== null && Number.isNaN(price)) continue; // header or bad line
    rows.push({ name: cells[0], category: cells[1] || undefined, max_price: price });
  }
  return rows;
}

export function ProductsTab() {
  const { rows, error, load } = usePlatformList<Product>("/products");
  const [f, setF] = useState({ name: "", category: "", price: "" });
  const [bulk, setBulk] = useState("");

  async function add(e: FormEvent) {
    e.preventDefault();
    const price = f.price.trim() === "" ? null : Number(f.price);
    const r = await change(
      () =>
        platform("POST", "/products/bulk", {
          rows: [{ name: f.name, category: f.category || undefined, max_price: price }],
        }),
      "Saved",
    );
    if (r) {
      setF({ name: "", category: "", price: "" });
      void load();
    }
  }

  async function upload() {
    const parsed = parseRows(bulk);
    if (parsed.length === 0) return toast.error("No usable lines found.");
    const r = await change(() =>
      platform<{ created: number; updated: number; priceChanges: number }>("POST", "/products/bulk", { rows: parsed }),
    );
    if (r) {
      toast.success(`${r.created} new, ${r.updated} updated, ${r.priceChanges} price limits changed`);
      setBulk("");
      void load();
    }
  }

  async function setLimit(p: Product) {
    const v = prompt(
      `Maximum price before VAT for "${p.name}" (empty = no limit, cannot be invoiced)`,
      p.max_price ?? "",
    );
    if (v === null) return;
    const max_price = v.trim() === "" ? null : Number(v);
    if (max_price !== null && Number.isNaN(max_price)) return toast.error("Enter a number.");
    await change(() => platform("PATCH", `/products/${p.id}`, { max_price }), "Saved");
    void load();
  }

  const noLimit = (rows ?? []).filter((p) => p.max_price === null).length;

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {noLimit > 0 ? (
        <Alert>
          <AlertDescription>{noLimit} product(s) have no price limit and cannot be invoiced yet.</AlertDescription>
        </Alert>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-end">Max price (before VAT)</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows ?? []).map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell>{p.category ?? <Badge variant="outline">none</Badge>}</TableCell>
                <TableCell className="text-end tabular-nums">{p.max_price ?? "—"}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Button variant="ghost" size="sm" onClick={() => setLimit(p)}>
                      Change limit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${p.name}`}
                      onClick={async () => {
                        if (!confirm(`Delete the product "${p.name}"?`)) return;
                        await change(() => platform("DELETE", `/products/${p.id}`), "Deleted");
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
                <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                  No products yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <form onSubmit={add} className="grid items-end gap-2 sm:grid-cols-[2fr_1.5fr_1fr_auto]">
        <div className="space-y-1">
          <Label htmlFor="p-name">Product</Label>
          <Input id="p-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-cat">Category</Label>
          <Input id="p-cat" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="p-price">Max price</Label>
          <Input
            id="p-price"
            dir="ltr"
            inputMode="decimal"
            value={f.price}
            onChange={(e) => setF({ ...f, price: e.target.value })}
          />
        </div>
        <Button type="submit">
          <Plus data-icon="inline-start" />
          Add / update
        </Button>
      </form>

      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <Label htmlFor="p-bulk">
          Upload many at once: one product per line as &quot;name, category, max price&quot; (copy from Excel)
        </Label>
        <Textarea id="p-bulk" rows={5} dir="ltr" value={bulk} onChange={(e) => setBulk(e.target.value)} />
        <Button className="w-fit" variant="outline" onClick={upload} disabled={bulk.trim() === ""}>
          <Upload data-icon="inline-start" />
          Upload
        </Button>
        <p className="text-muted-foreground text-xs">
          Products are matched by name. Every price-limit change is kept in the history.
        </p>
      </div>
    </div>
  );
}
