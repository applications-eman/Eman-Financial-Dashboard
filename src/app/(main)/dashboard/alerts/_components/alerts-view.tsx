"use client";

import { useCallback, useEffect, useState } from "react";

import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { adminSend } from "@/lib/admin-api";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { getSupabase } from "@/lib/supabase/client";

import { SimpleSelect } from "../../_components/common/simple-select";

interface AlertRow {
  id: number;
  rule_key: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: Record<string, unknown>;
  section: string;
  salesman_name: string | null;
  amount: number | null;
  status: "open" | "acknowledged" | "resolved";
  note: string | null;
  handled_by: string | null;
  handled_at: string | null;
  created_at: string;
}

const SEV_CLASS: Record<AlertRow["severity"], string> = {
  critical: "border-destructive text-destructive",
  warning: "border-amber-500 text-amber-600 dark:text-amber-400",
  info: "",
};
const SHOWN = [
  "number",
  "salesman",
  "customer",
  "segment",
  "amount_total",
  "invoice_date",
  "ref",
  "created_by",
  "zatca_state",
];

export function AlertsView() {
  const t = useT();
  const [rows, setRows] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("open");
  const [severity, setSeverity] = useState("");
  const [target, setTarget] = useState<AlertRow | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    let q = getSupabase().from("alerts").select("*").order("created_at", { ascending: false }).limit(300);
    if (status) q = q.eq("status", status);
    if (severity) q = q.eq("severity", severity);
    const { data, error: e } = await q;
    if (e) setError(e.message);
    else {
      setError(null);
      setRows(data as AlertRow[]);
    }
  }, [status, severity]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  // Realtime: new alerts appear without refreshing
  useEffect(() => {
    const sb = getSupabase();
    const ch = sb
      .channel("alerts-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, () => void load())
      .subscribe();
    return () => void sb.removeChannel(ch);
  }, [load]);

  async function act(next: AlertRow["status"]) {
    if (!target) return;
    setBusy(true);
    try {
      await adminSend(
        "PATCH",
        `/review/alerts/${target.id}`,
        next === "open" ? { status: next } : { status: next, note },
      );
      toast.success(t("common.saved"));
      setTarget(null);
      setNote("");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">{t("alerts.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("alerts.subtitle")}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <SimpleSelect
          label={t("alerts.status")}
          size="default"
          value={status}
          onChange={setStatus}
          allLabel={t("alerts.allStatuses")}
          options={(["open", "acknowledged", "resolved"] as const).map((s) => ({
            value: s,
            label: t(`alerts.status.${s}`),
          }))}
        />
        <SimpleSelect
          label={t("alerts.severity")}
          size="default"
          value={severity}
          onChange={setSeverity}
          allLabel={t("alerts.allSeverities")}
          options={(["critical", "warning", "info"] as const).map((s) => ({
            value: s,
            label: t(`alerts.severity.${s}`),
          }))}
        />
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {rows === null ? (
        <Skeleton className="h-48 w-full" />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground text-sm">{t("alerts.none")}</CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((a) => (
            <Card key={a.id} className="py-3">
              <CardContent className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={SEV_CLASS[a.severity]}>
                      {t(`alerts.severity.${a.severity}`)}
                    </Badge>
                    <span className="font-medium">{a.title}</span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {fmtDateTime(a.created_at)}
                    {a.amount != null ? ` · ${fmtMoney(a.amount)} ${t("common.sar")}` : ""}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {SHOWN.filter((k) => a.detail?.[k] != null && a.detail[k] !== "")
                      .map((k) => `${k.replace("_", " ")}: ${String(a.detail[k])}`)
                      .join(" · ")}
                  </p>
                  {a.note ? (
                    <p className="text-sm">
                      <span className="text-muted-foreground">{a.handled_by}: </span>
                      {a.note}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={a.status === "open" ? "default" : "secondary"}>
                    {t(`alerts.status.${a.status}`)}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setTarget(a);
                      setNote(a.note ?? "");
                    }}
                  >
                    {t("alerts.handle")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("alerts.handle")}</DialogTitle>
            <DialogDescription>{target?.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="al-note">{t("alerts.note")}</Label>
            <Textarea id="al-note" maxLength={1000} rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
            <p className="text-muted-foreground text-xs">{t("alerts.noteHelp")}</p>
          </div>
          <DialogFooter className="gap-2">
            {target && target.status !== "open" ? (
              <Button variant="ghost" disabled={busy} onClick={() => act("open")}>
                {t("alerts.reopen")}
              </Button>
            ) : null}
            <Button variant="outline" disabled={busy || !note.trim()} onClick={() => act("acknowledged")}>
              {t("alerts.acknowledge")}
            </Button>
            <Button disabled={busy || !note.trim()} onClick={() => act("resolved")}>
              {t("alerts.resolve")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
