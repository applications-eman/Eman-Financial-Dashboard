"use client";

import { useCallback, useEffect, useState } from "react";

import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminSend } from "@/lib/admin-api";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { monthStart, today } from "@/lib/revenue";
import { getSupabase } from "@/lib/supabase/client";

interface Check {
  metric: string;
  odoo: number;
  dashboard: number;
  diff: number;
  ok: boolean;
}
interface Result {
  from: string;
  to: string;
  ok: boolean;
  checks: Check[];
  zatca: Check[];
  checked_at: string;
}
interface Run {
  id: number;
  period_from: string;
  period_to: string;
  ok: boolean;
  created_at: string;
  result: Result;
}

/** Live re-read of Odoo for a period, compared with the stored dashboard figures. History of runs is kept. */
export function VerifyDialog({ initialFrom, initialTo }: { initialFrom?: string; initialTo?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(initialFrom ?? monthStart());
  const [to, setTo] = useState(initialTo ?? today());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<Run[]>([]);

  const loadHistory = useCallback(async () => {
    const { data } = await getSupabase()
      .from("verification_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(8);
    setHistory((data as Run[]) ?? []);
  }, []);
  useEffect(() => {
    if (open) {
      setFrom(initialFrom ?? monthStart());
      setTo(initialTo ?? today());
      void loadHistory();
    }
  }, [open, initialFrom, initialTo, loadHistory]);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await adminSend<Result>("POST", "/admin/verify", { from, to }));
      void loadHistory();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const rows = result ? [...result.checks, ...result.zatca] : [];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <ShieldCheck data-icon="inline-start" />
          {t("verify.button")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("verify.title")}</DialogTitle>
          <DialogDescription>{t("verify.help")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="v-from">{t("exports.from")}</Label>
            <Input id="v-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="v-to">{t("exports.to")}</Label>
            <Input id="v-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button onClick={run} disabled={busy || !from || !to}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {t("verify.run")}
          </Button>
        </div>
        {result ? (
          <div className="space-y-2">
            <Badge variant={result.ok ? "default" : "destructive"}>
              {result.ok ? t("verify.allMatch") : t("verify.differences")}
            </Badge>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("verify.metric")}</TableHead>
                  <TableHead className="text-end">Odoo</TableHead>
                  <TableHead className="text-end">{t("verify.dashboard")}</TableHead>
                  <TableHead className="text-end">{t("verify.diff")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.metric} className={c.ok ? "" : "bg-destructive/10"}>
                    <TableCell>{c.metric}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(c.odoo)}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(c.dashboard)}</TableCell>
                    <TableCell className="text-end tabular-nums">{c.ok ? "✓" : fmtMoney(c.diff)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        {history.length ? (
          <div className="space-y-1">
            <h3 className="font-medium text-sm">{t("verify.history")}</h3>
            <ul className="space-y-1 text-muted-foreground text-sm">
              {history.map((h) => (
                <li key={h.id} className="flex items-center gap-2">
                  <Badge variant={h.ok ? "secondary" : "destructive"}>{h.ok ? "✓" : "✗"}</Badge>
                  {fmtDateTime(h.created_at)} · {fmtDate(h.period_from)} – {fmtDate(h.period_to)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
