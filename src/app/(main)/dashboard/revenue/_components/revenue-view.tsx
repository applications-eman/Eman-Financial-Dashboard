"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Download } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminFetch } from "@/lib/admin-api";
import { fmtDate, fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { type Group, monthStart, num, type SummaryRow, sumRows, today, toSummary } from "@/lib/revenue";
import { getSupabase } from "@/lib/supabase/client";

import { SimpleSelect } from "../../_components/common/simple-select";
import { SyncStatusBar } from "./sync-status";
import { VerifyDialog } from "./verify-dialog";

interface GroceryDay {
  sale_date: string;
  net_sales: number;
  vat_amount: number;
  credit_net: number;
  credit_vat: number;
  invoice_count: number;
}

function groceryToRows(days: GroceryDay[], group: Group): SummaryRow[] {
  const by = new Map<string, SummaryRow>();
  for (const d of days) {
    const key = group === "month" ? d.sale_date.slice(0, 7) : group === "segment" ? "B2C" : d.sale_date;
    const cur = by.get(key) ?? toSummary({ bucket: key, label: key });
    const net = num(d.net_sales);
    const vat = num(d.vat_amount);
    const cn = num(d.credit_net);
    const cv = num(d.credit_vat);
    cur.invoice_count += num(d.invoice_count);
    cur.net_sales += net;
    cur.vat += vat;
    cur.total += net + vat;
    cur.credit_net += cn;
    cur.credit_vat += cv;
    cur.credit_total += cn + cv;
    cur.net_after_credit += net - cn;
    cur.vat_after_credit += vat - cv;
    cur.total_after_credit += net + vat - cn - cv;
    by.set(key, cur);
  }
  return [...by.values()];
}

function mergeRows(a: SummaryRow[], b: SummaryRow[]): SummaryRow[] {
  const by = new Map<string, SummaryRow>();
  for (const r of [...a, ...b]) {
    const cur = by.get(r.bucket);
    if (!cur) by.set(r.bucket, { ...r });
    else
      for (const k of Object.keys(r) as (keyof SummaryRow)[])
        if (typeof r[k] === "number") (cur[k] as number) += r[k] as number;
  }
  return [...by.values()];
}

export function RevenueView() {
  const t = useT();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [group, setGroup] = useState<Group>("day");
  const [segment, setSegment] = useState("");
  const [scope, setScope] = useState("bakery");
  const [rows, setRows] = useState<SummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getSupabase();
    setError(null);
    try {
      let out: SummaryRow[] = [];
      if (scope !== "grocery") {
        const { data, error: e } = await sb.rpc("revenue_summary", {
          p_from: from,
          p_to: to,
          p_group: group,
          p_segment: segment || null,
          p_section: "bakery",
        });
        if (e) throw new Error(e.message);
        out = (data as Record<string, unknown>[]).map(toSummary);
      }
      const groceryGroups: Group[] = ["day", "month", "segment"];
      if (scope !== "bakery" && groceryGroups.includes(group) && segment !== "B2B") {
        const { data, error: e } = await sb
          .from("grocery_sales_daily")
          .select("*")
          .gte("sale_date", from)
          .lte("sale_date", to);
        if (e) throw new Error(e.message);
        out = mergeRows(out, groceryToRows(data as GroceryDay[], group));
      }
      setRows(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
      setRows([]);
    }
  }, [from, to, group, segment, scope, t]);
  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const r = [...rows];
    if (group === "salesman" || group === "customer") r.sort((a, b) => b.total_after_credit - a.total_after_credit);
    else r.sort((a, b) => (a.bucket < b.bucket ? 1 : -1));
    return r;
  }, [rows, group]);
  const total = useMemo(() => sumRows(rows ?? []), [rows]);
  const max = Math.max(1, ...(sorted ?? []).map((r) => Math.abs(r.net_after_credit)));
  const bucketLabel = (r: SummaryRow) => (group === "day" ? fmtDate(r.bucket) : r.label);

  async function exportCsv() {
    try {
      const res = await adminFetch(`/admin/revenue/export?from=${from}&to=${to}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `sales-${from}_${to}.csv`;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    }
  }

  const card = (label: string, value: number, hint?: string) => (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="font-normal text-2xl tabular-nums">
          {fmtMoney(value)} <span className="text-muted-foreground text-sm">{t("common.sar")}</span>
        </CardTitle>
        {hint ? <CardDescription>{hint}</CardDescription> : null}
      </CardHeader>
    </Card>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl tracking-tight">{t("revenue.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("revenue.subtitle")}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <SyncStatusBar onSynced={load} />
          <div className="flex gap-2">
            <VerifyDialog initialFrom={from} initialTo={to} />
            <Button size="sm" variant="outline" onClick={exportCsv}>
              <Download data-icon="inline-start" />
              {t("common.export")}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="r-from">{t("exports.from")}</Label>
          <Input id="r-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="r-to">{t("exports.to")}</Label>
          <Input id="r-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("revenue.groupBy")}</Label>
          <SimpleSelect
            label={t("revenue.groupBy")}
            size="default"
            value={group}
            onChange={(v) => setGroup(v as Group)}
            options={(["day", "month", "salesman", "customer", "segment"] as Group[]).map((g) => ({
              value: g,
              label: t(`revenue.group.${g}`),
            }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("revenue.segment")}</Label>
          <SimpleSelect
            label={t("revenue.segment")}
            size="default"
            value={segment}
            onChange={setSegment}
            allLabel={t("revenue.allSegments")}
            options={[
              { value: "B2B", label: t("revenue.b2b") },
              { value: "B2C", label: t("revenue.b2c") },
            ]}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("users.sections")}</Label>
          <SimpleSelect
            label={t("users.sections")}
            size="default"
            value={scope}
            onChange={setScope}
            options={[
              { value: "bakery", label: t("section.bakery") },
              { value: "grocery", label: t("section.grocery") },
              { value: "all", label: t("exports.bothSections") },
            ]}
          />
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {card(t("revenue.netAfterCredit"), total.net_after_credit)}
        {card(t("revenue.vatAfterCredit"), total.vat_after_credit)}
        {card(t("revenue.totalAfterCredit"), total.total_after_credit)}
        {card(t("revenue.creditNotes"), total.credit_total, t("revenue.creditCount", { n: total.credit_count }))}
      </div>

      <Card>
        <CardContent className="overflow-x-auto">
          {sorted === null ? (
            <Skeleton className="h-48 w-full" />
          ) : sorted.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">{t("common.noData")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t(`revenue.group.${group}`)}</TableHead>
                  <TableHead className="text-end">{t("revenue.invoices")}</TableHead>
                  <TableHead className="text-end">{t("revenue.net")}</TableHead>
                  <TableHead className="text-end">{t("revenue.vat")}</TableHead>
                  <TableHead className="text-end">{t("common.total")}</TableHead>
                  <TableHead className="text-end">{t("revenue.creditNotes")}</TableHead>
                  <TableHead className="text-end">{t("revenue.netAfterCredit")}</TableHead>
                  <TableHead className="text-end">{t("revenue.vatAfterCredit")}</TableHead>
                  <TableHead className="text-end">{t("revenue.totalAfterCredit")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r) => (
                  <TableRow key={r.bucket}>
                    <TableCell className="font-medium">{bucketLabel(r)}</TableCell>
                    <TableCell className="text-end tabular-nums">{r.invoice_count}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(r.net_sales)}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(r.vat)}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(r.total)}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {r.credit_count ? `${fmtMoney(r.credit_total)} (${r.credit_count})` : "—"}
                    </TableCell>
                    <TableCell className="min-w-40 text-end tabular-nums">
                      <div
                        className="ms-auto h-1 rounded bg-primary/30"
                        style={{ width: `${(Math.abs(r.net_after_credit) / max) * 100}%` }}
                      />
                      {fmtMoney(r.net_after_credit)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(r.vat_after_credit)}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(r.total_after_credit)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>{t("common.total")}</TableCell>
                  <TableCell className="text-end tabular-nums">{total.invoice_count}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmtMoney(total.net_sales)}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmtMoney(total.vat)}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmtMoney(total.total)}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmtMoney(total.credit_total)}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmtMoney(total.net_after_credit)}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmtMoney(total.vat_after_credit)}</TableCell>
                  <TableCell className="text-end tabular-nums">{fmtMoney(total.total_after_credit)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>
      <p className="text-muted-foreground text-xs">{t("revenue.note")}</p>
    </div>
  );
}
