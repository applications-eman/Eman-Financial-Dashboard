"use client";

import { useCallback, useEffect, useState } from "react";

import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminSend } from "@/lib/admin-api";
import { addDays, fmtDate, fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { num, today } from "@/lib/revenue";
import { getSupabase } from "@/lib/supabase/client";

interface Day {
  sale_date: string;
  net_sales: number;
  vat_amount: number;
  credit_net: number;
  credit_vat: number;
  invoice_count: number;
  notes: string | null;
  entered_by: string | null;
}
const empty = { sale_date: addDays(today(), -1), net: "", vat: "", cnet: "", cvat: "", count: "", notes: "" };

/** Grocery runs on a different system with no API: daily totals are typed in here (all sales are B2C). */
export function GrocerySalesView() {
  const t = useT();
  const [rows, setRows] = useState<Day[] | null>(null);
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await getSupabase()
      .from("grocery_sales_daily")
      .select("*")
      .order("sale_date", { ascending: false })
      .limit(120);
    setRows((data as Day[]) ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // typing the net amount suggests 15% VAT (editable)
  const suggestVat = (net: string) => (net && !Number.isNaN(Number(net)) ? (Number(net) * 0.15).toFixed(2) : "");

  async function save() {
    setBusy(true);
    try {
      await adminSend("PUT", "/admin/grocery-sales", [
        {
          sale_date: f.sale_date,
          net_sales: Number(f.net || 0),
          vat_amount: Number(f.vat || 0),
          credit_net: Number(f.cnet || 0),
          credit_vat: Number(f.cvat || 0),
          invoice_count: Math.round(Number(f.count || 0)),
          notes: f.notes || null,
        },
      ]);
      toast.success(t("common.saved"));
      setF({ ...empty, sale_date: addDays(f.sale_date, 1) });
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }
  async function remove(d: string) {
    try {
      await adminSend("DELETE", `/admin/grocery-sales/${d}`);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    }
  }

  const field = (id: string, label: string, key: keyof typeof empty, type = "number") => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        step={type === "number" ? "0.01" : undefined}
        min={type === "number" ? "0" : undefined}
        dir="ltr"
        value={f[key]}
        onChange={(e) => setF({ ...f, [key]: e.target.value })}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">{t("grocerySales.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("grocerySales.subtitle")}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="font-normal">{t("grocerySales.enter")}</CardTitle>
          <CardDescription>{t("grocerySales.help")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {field("g-date", t("grocerySales.date"), "sale_date", "date")}
            <div className="space-y-1.5">
              <Label htmlFor="g-net">{t("revenue.net")}</Label>
              <Input
                id="g-net"
                type="number"
                step="0.01"
                min="0"
                required
                dir="ltr"
                value={f.net}
                onChange={(e) => setF({ ...f, net: e.target.value, vat: suggestVat(e.target.value) })}
              />
            </div>
            {field("g-vat", t("revenue.vat"), "vat")}
            {field("g-count", t("revenue.invoices"), "count")}
            {field("g-cnet", t("grocerySales.creditNet"), "cnet")}
            {field("g-cvat", t("grocerySales.creditVat"), "cvat")}
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="g-notes">{t("grocerySales.notes")}</Label>
              <Input
                id="g-notes"
                maxLength={500}
                value={f.notes}
                onChange={(e) => setF({ ...f, notes: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
              <Button type="submit" disabled={busy}>
                {t("common.save")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="overflow-x-auto">
          {rows === null ? (
            <Skeleton className="h-40 w-full" />
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">{t("common.noData")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("grocerySales.date")}</TableHead>
                  <TableHead className="text-end">{t("revenue.invoices")}</TableHead>
                  <TableHead className="text-end">{t("revenue.net")}</TableHead>
                  <TableHead className="text-end">{t("revenue.vat")}</TableHead>
                  <TableHead className="text-end">{t("common.total")}</TableHead>
                  <TableHead className="text-end">{t("revenue.creditNotes")}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.sale_date}
                    className="cursor-pointer"
                    onClick={() =>
                      setF({
                        sale_date: r.sale_date,
                        net: String(r.net_sales),
                        vat: String(r.vat_amount),
                        cnet: String(r.credit_net),
                        cvat: String(r.credit_vat),
                        count: String(r.invoice_count),
                        notes: r.notes ?? "",
                      })
                    }
                  >
                    <TableCell>{fmtDate(r.sale_date)}</TableCell>
                    <TableCell className="text-end tabular-nums">{r.invoice_count}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(num(r.net_sales))}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(num(r.vat_amount))}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {fmtMoney(num(r.net_sales) + num(r.vat_amount))}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {fmtMoney(num(r.credit_net) + num(r.credit_vat))}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("common.delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(r.sale_date);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
