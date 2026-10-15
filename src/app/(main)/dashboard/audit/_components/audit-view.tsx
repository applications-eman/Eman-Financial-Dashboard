"use client";

import { useEffect, useState } from "react";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { getSupabase } from "@/lib/supabase/client";
import type { AuditRow } from "@/lib/types";

import { SimpleSelect } from "../../_components/common/simple-select";

const PAGE = 50;
const TABLES = ["bakery_expenses", "grocery_expenses", "app_users", "app_settings", "feature_flags", "categories"];

function changedKeys(r: AuditRow): string[] {
  if (r.action !== "UPDATE" || !r.before || !r.after) return [];
  return Object.keys(r.after).filter(
    (k) => JSON.stringify(r.before?.[k]) !== JSON.stringify(r.after?.[k]) && k !== "updated_at",
  );
}

export function AuditView() {
  const t = useT();
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [table, setTable] = useState("");
  const [actor, setActor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AuditRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    let q = getSupabase()
      .from("audit_log")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (table) q = q.eq("table_name", table);
    if (actor.trim()) q = q.ilike("actor", `%${actor.replace(/[%,()*\\]/g, " ").trim()}%`);
    q.then(({ data, count: total, error: err }) => {
      if (cancelled) return;
      if (err) setError(err.message);
      else {
        setError(null);
        setRows(data as AuditRow[]);
        setCount(total ?? 0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [page, table, actor]);

  const pages = Math.max(1, Math.ceil(count / PAGE));
  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">{t("audit.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("audit.subtitle")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <SimpleSelect
          className="w-48"
          label={t("audit.table")}
          allLabel={t("audit.allTables")}
          value={table}
          onChange={(v) => {
            setTable(v);
            setPage(0);
          }}
          options={TABLES.map((x) => ({ value: x, label: x }))}
        />
        <Input
          className="h-8 w-52"
          placeholder={t("audit.actor")}
          aria-label={t("audit.actor")}
          value={actor}
          onChange={(e) => {
            setActor(e.target.value);
            setPage(0);
          }}
        />
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("audit.when")}</TableHead>
              <TableHead>{t("audit.actor")}</TableHead>
              <TableHead>{t("audit.action")}</TableHead>
              <TableHead>{t("audit.table")}</TableHead>
              <TableHead>{t("audit.changes")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  {t("common.noData")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() => setOpen(r)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && setOpen(r)}
                >
                  <TableCell className="whitespace-nowrap tabular-nums">{fmtDateTime(r.created_at)}</TableCell>
                  <TableCell className="max-w-48 truncate">{r.actor ?? "—"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={r.action === "DELETE" ? "destructive" : r.action === "INSERT" ? "secondary" : "outline"}
                    >
                      {r.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs" dir="ltr">
                    {r.table_name}
                  </TableCell>
                  <TableCell className="max-w-72 truncate text-muted-foreground text-sm">
                    {changedKeys(r).join(", ") || r.record_id}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-muted-foreground text-sm">
        <span>{t("expenses.count", { n: count })}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            aria-label={t("common.prev")}
          >
            <ChevronLeft className="rtl:rotate-180" />
          </Button>
          <span>{t("common.pageOf", { p: page + 1, n: pages })}</span>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
            aria-label={t("common.next")}
          >
            <ChevronRight className="rtl:rotate-180" />
          </Button>
        </div>
      </div>
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {open?.action} · {open?.table_name}
            </DialogTitle>
            <DialogDescription>
              {open?.actor} · {fmtDateTime(open?.created_at)}
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-3 overflow-auto sm:grid-cols-2" dir="ltr">
            {(["before", "after"] as const).map((k) => (
              <div key={k}>
                <p className="mb-1 font-medium text-sm">{t(`audit.${k}`)}</p>
                <pre className="overflow-auto rounded-md border bg-muted p-3 text-xs">
                  {open?.[k] ? JSON.stringify(open[k], null, 2) : "—"}
                </pre>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
