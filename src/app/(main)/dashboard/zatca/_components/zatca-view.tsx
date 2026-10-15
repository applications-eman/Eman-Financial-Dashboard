"use client";

import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { getSupabase } from "@/lib/supabase/client";

interface Doc {
  odoo_id: number;
  number: string | null;
  kind: string;
  state: string;
  segment: "B2B" | "B2C";
  odoo_created_at: string | null;
  amount_total: number;
  salesman_name: string | null;
  zatca_state: string | null;
  zatca_error: string | null;
  zatca_confirmed_at: string | null;
}
interface AlertLite {
  id: number;
  title: string;
  severity: string;
  created_at: string;
  status: string;
}

const DAY = 86_400_000;

/** Documents not yet cleared/reported (RLS lets accounts staff see exactly these), plus open ZATCA alerts. */
export function ZatcaView() {
  const t = useT();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [alerts, setAlerts] = useState<AlertLite[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getSupabase();
    const since = new Date(Date.now() - 14 * DAY).toISOString();
    const d = await sb
      .from("sales_invoices")
      .select(
        "odoo_id,number,kind,state,segment,odoo_created_at,amount_total,salesman_name,zatca_state,zatca_error,zatca_confirmed_at",
      )
      .eq("state", "posted")
      .or("zatca_state.is.null,zatca_state.neq.sent")
      .gte("odoo_created_at", since)
      .order("odoo_created_at", { ascending: true })
      .limit(500);
    if (d.error) setError(d.error.message);
    else setDocs(d.data as Doc[]);
    const a = await sb
      .from("alerts")
      .select("id,title,severity,created_at,status")
      .like("rule_key", "zatca%")
      .neq("status", "resolved")
      .order("created_at", { ascending: false })
      .limit(50);
    setAlerts((a.data as AlertLite[]) ?? []);
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const b2b = docs?.filter((x) => x.segment === "B2B").length ?? 0;
  const b2c = docs?.filter((x) => x.segment === "B2C").length ?? 0;
  const age = (iso: string | null) => {
    if (!iso) return "";
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
    return m < 120 ? `${m} ${t("zatca.min")}` : `${Math.round(m / 60)} ${t("zatca.hours")}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">{t("zatca.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("zatca.subtitle")}</p>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>{t("zatca.pendingB2b")}</CardDescription>
            <CardTitle className="font-normal text-2xl">{docs ? b2b : "…"}</CardTitle>
            <CardDescription>{t("zatca.b2bRule")}</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>{t("zatca.pendingB2c")}</CardDescription>
            <CardTitle className="font-normal text-2xl">{docs ? b2c : "…"}</CardTitle>
            <CardDescription>{t("zatca.b2cRule")}</CardDescription>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>{t("zatca.openAlerts")}</CardDescription>
            <CardTitle className="font-normal text-2xl">{alerts.length}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {alerts.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="font-normal">{t("zatca.alerts")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {alerts.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-2">
                <Badge variant={a.severity === "critical" ? "destructive" : "outline"}>{a.severity}</Badge>
                <span>{a.title}</span>
                <span className="text-muted-foreground text-xs">{fmtDateTime(a.created_at)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="font-normal">{t("zatca.docs")}</CardTitle>
          <CardDescription>{t("zatca.docsHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {docs === null ? (
            <Skeleton className="h-40 w-full" />
          ) : docs.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">{t("zatca.allGood")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("zatca.number")}</TableHead>
                  <TableHead>{t("revenue.segment")}</TableHead>
                  <TableHead>{t("zatca.status")}</TableHead>
                  <TableHead>{t("zatca.age")}</TableHead>
                  <TableHead>{t("revenue.group.salesman")}</TableHead>
                  <TableHead className="text-end">{t("common.total")}</TableHead>
                  <TableHead>{t("zatca.error")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((d) => (
                  <TableRow key={d.odoo_id}>
                    <TableCell dir="ltr" className="font-mono text-xs">
                      {d.number}
                      {d.kind === "credit_note" ? ` (${t("zatca.credit")})` : ""}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{d.segment}</Badge>
                    </TableCell>
                    <TableCell>{d.zatca_state ?? t("zatca.noStatus")}</TableCell>
                    <TableCell>{age(d.odoo_created_at)}</TableCell>
                    <TableCell>{d.salesman_name ?? "—"}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(d.amount_total)}</TableCell>
                    <TableCell className="max-w-64 truncate text-destructive text-xs">{d.zatca_error ?? ""}</TableCell>
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
