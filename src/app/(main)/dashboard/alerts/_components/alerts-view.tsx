"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "cn";
import { AlertTriangle, CheckCircle2, Info, Search, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { adminSend } from "@/lib/admin-api";
import { addDays, fmtDateTime, fmtMoney, riyadhStartOfDay } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n/messages";
import { useT } from "@/lib/i18n/provider";
import { today } from "@/lib/revenue";
import { getSupabase } from "@/lib/supabase/client";

import { SimpleSelect } from "../../_components/common/simple-select";

type Severity = "critical" | "warning" | "info";
type Status = "open" | "acknowledged" | "resolved";

interface AlertRow {
  id: number;
  rule_key: string;
  severity: Severity;
  title: string;
  detail: Record<string, unknown>;
  section: string;
  salesman_name: string | null;
  amount: number | null;
  status: Status;
  note: string | null;
  handled_by: string | null;
  handled_at: string | null;
  created_at: string;
}

const LIMIT = 1000;
const SEVERITIES: Severity[] = ["critical", "warning", "info"];
const STYLE: Record<Severity, { bar: string; chip: string; tile: string; icon: typeof Info }> = {
  critical: {
    bar: "border-s-destructive",
    chip: "bg-destructive/10 text-destructive",
    tile: "border-destructive/50 data-[active=true]:bg-destructive/10",
    icon: ShieldAlert,
  },
  warning: {
    bar: "border-s-amber-500",
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    tile: "border-amber-500/50 data-[active=true]:bg-amber-500/10",
    icon: AlertTriangle,
  },
  info: {
    bar: "border-s-sky-500",
    chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    tile: "border-sky-500/50 data-[active=true]:bg-sky-500/10",
    icon: Info,
  },
};

interface InvoiceRef {
  number: string | null;
  issued_at: string | null;
}
const invoiceRefs = (a: AlertRow): InvoiceRef[] =>
  Array.isArray(a.detail?.invoices) ? (a.detail.invoices as InvoiceRef[]) : [];

const str = (v: unknown) => (v == null || v === "" ? "" : String(v));

export function AlertsView() {
  const t = useT();
  const [rows, setRows] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"open" | "done" | "all">("open");
  const [period, setPeriod] = useState<"today" | "7" | "30" | "all">("30");
  const [severity, setSeverity] = useState<Severity | "">("");
  const [rule, setRule] = useState("");
  const [salesman, setSalesman] = useState("");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<AlertRow | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    let q = getSupabase().from("alerts").select("*").order("created_at", { ascending: false }).limit(LIMIT);
    if (status === "open") q = q.eq("status", "open");
    if (status === "done") q = q.in("status", ["acknowledged", "resolved"]);
    if (period !== "all")
      q = q.gte("created_at", riyadhStartOfDay(period === "today" ? today() : addDays(today(), -Number(period) + 1)));
    const { data, error: e } = await q;
    if (e) setError(e.message);
    else {
      setError(null);
      setRows(data as AlertRow[]);
    }
  }, [status, period]);

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

  const ruleLabel = useCallback(
    (a: AlertRow) => {
      const label = t(`alerts.rule.${a.rule_key}` as MessageKey);
      return label.startsWith("alerts.rule.") ? a.title : label;
    },
    [t],
  );
  const ruleHelp = (a: AlertRow) => {
    const h = t(`alerts.help.${a.rule_key}` as MessageKey);
    return h.startsWith("alerts.help.") ? "" : h;
  };

  // everything except the severity filter, so the three tiles always show what each choice would give
  const base = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (rows ?? []).filter((a) => {
      if (rule && a.rule_key !== rule) return false;
      if (salesman && a.salesman_name !== salesman) return false;
      if (!needle) return true;
      const hay = [a.detail?.number, a.detail?.customer, a.salesman_name, a.title, a.detail?.ref]
        .map(str)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, rule, salesman, query]);
  const counts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
    for (const a of base) c[a.severity]++;
    return c;
  }, [base]);
  const shown = severity ? base.filter((a) => a.severity === severity) : base;

  const rules = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of rows ?? []) if (!map.has(a.rule_key)) map.set(a.rule_key, ruleLabel(a));
    return [...map].map(([value, label]) => ({ value, label })).sort((x, y) => x.label.localeCompare(y.label));
  }, [rows, ruleLabel]);
  const salesmen = useMemo(
    () =>
      [...new Set((rows ?? []).map((a) => a.salesman_name).filter((x): x is string => Boolean(x)))]
        .sort()
        .map((s) => ({ value: s, label: s })),
    [rows],
  );
  const filtered = severity !== "" || rule !== "" || salesman !== "" || query !== "";

  async function act(next: Status) {
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

  const fact = (label: string, value: string, mono = false) =>
    value ? (
      <div className="min-w-0">
        <dt className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</dt>
        <dd
          className={cn("truncate text-sm", mono && "font-mono text-xs")}
          dir={mono ? "ltr" : undefined}
          title={value}
        >
          {value}
        </dd>
      </div>
    ) : null;

  function card(a: AlertRow) {
    const S = STYLE[a.severity];
    const Icon = S.icon;
    const segment = str(a.detail?.segment);
    return (
      <button
        key={a.id}
        type="button"
        onClick={() => {
          setTarget(a);
          setNote(a.note ?? "");
        }}
        className={cn(
          "flex min-w-0 flex-col gap-2 rounded-lg border border-s-4 bg-card p-3 text-start shadow-xs transition hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring",
          S.bar,
          a.status !== "open" && "opacity-70",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className={cn(
              "inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 font-medium text-xs",
              S.chip,
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{ruleLabel(a)}</span>
          </span>
          <span
            className="shrink-0 text-muted-foreground text-xs"
            title={`${t("alerts.issued")} / ${t("alerts.created")}`}
          >
            {fmtDateTime(str(a.detail?.issued_at) || a.created_at)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold text-lg tabular-nums">
            {a.amount != null ? fmtMoney(a.amount) : "—"}{" "}
            <span className="font-normal text-muted-foreground text-xs">{t("common.sar")}</span>
          </span>
          {segment ? <Badge variant="outline">{segment}</Badge> : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          {invoiceRefs(a).length ? null : fact(t("alerts.invoice"), str(a.detail?.number), true)}
          {fact(t("alerts.salesman"), str(a.salesman_name ?? a.detail?.salesman))}
          {fact(t("alerts.customer"), str(a.detail?.customer))}
        </dl>
        {invoiceRefs(a).length ? (
          <ul className="space-y-0.5 rounded-md bg-muted/60 p-2" dir="ltr">
            {invoiceRefs(a).map((i) => (
              <li key={i.number} className="flex items-center justify-between gap-2 font-mono text-xs">
                <span>{i.number}</span>
                <span className="text-muted-foreground">{i.issued_at ? fmtDateTime(i.issued_at).slice(11) : ""}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center justify-between pt-1">
          <Badge variant={a.status === "open" ? "default" : "secondary"}>
            {a.status !== "open" ? <CheckCircle2 aria-hidden="true" /> : null}
            {t(`alerts.status.${a.status}`)}
          </Badge>
          <span className="text-muted-foreground text-xs">{t("alerts.cardHint")}</span>
        </div>
      </button>
    );
  }

  const sectionTitle: Record<Severity, MessageKey> = {
    critical: "alerts.sectionCritical",
    warning: "alerts.sectionWarning",
    info: "alerts.sectionInfo",
  };
  const pill = (active: boolean, label: string, onClick: () => void) => (
    <Button size="sm" variant={active ? "default" : "outline"} aria-pressed={active} onClick={onClick}>
      {label}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">{t("alerts.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("alerts.subtitle")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {SEVERITIES.map((s) => {
          const S = STYLE[s];
          const Icon = S.icon;
          return (
            <button
              key={s}
              type="button"
              data-active={severity === s}
              aria-pressed={severity === s}
              onClick={() => setSeverity(severity === s ? "" : s)}
              className={cn(
                "flex items-center gap-3 rounded-lg border bg-card p-3 text-start transition hover:shadow-md",
                S.tile,
              )}
            >
              <span className={cn("rounded-md p-2", S.chip)}>
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <span>
                <span className="block font-semibold text-2xl tabular-nums leading-none">{rows ? counts[s] : "…"}</span>
                <span className="text-muted-foreground text-sm">{t(`alerts.severity.${s}`)}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {pill(status === "open", t("alerts.statusOpen"), () => setStatus("open"))}
        {pill(status === "done", t("alerts.statusDone"), () => setStatus("done"))}
        {pill(status === "all", t("alerts.statusAll"), () => setStatus("all"))}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        {pill(period === "today", t("alerts.today"), () => setPeriod("today"))}
        {pill(period === "7", t("alerts.days7"), () => setPeriod("7"))}
        {pill(period === "30", t("alerts.days30"), () => setPeriod("30"))}
        {pill(period === "all", t("alerts.allTime"), () => setPeriod("all"))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute start-2.5 top-2.5 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label={t("alerts.search")}
            placeholder={t("alerts.search")}
            className="ps-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <SimpleSelect
          size="default"
          label={t("alerts.type")}
          value={rule}
          onChange={setRule}
          allLabel={t("alerts.allRules")}
          options={rules}
        />
        <SimpleSelect
          size="default"
          label={t("alerts.salesman")}
          value={salesman}
          onChange={setSalesman}
          allLabel={t("alerts.allSalesmen")}
          options={salesmen}
        />
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSeverity("");
              setRule("");
              setSalesman("");
              setQuery("");
            }}
          >
            {t("alerts.clear")}
          </Button>
        ) : null}
        <span className="ms-auto text-muted-foreground text-sm">{t("alerts.count", { n: shown.length })}</span>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {rows && rows.length >= LIMIT ? (
        <p className="text-muted-foreground text-xs">{t("alerts.limit", { n: LIMIT })}</p>
      ) : null}

      {rows === null ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-lg border bg-card py-12 text-center text-muted-foreground text-sm">{t("alerts.none")}</p>
      ) : (
        SEVERITIES.map((s) => {
          const list = shown.filter((a) => a.severity === s);
          if (!list.length) return null;
          return (
            <section key={s} className="space-y-2">
              <h2 className="font-medium text-sm">
                {t(sectionTitle[s])} <span className="text-muted-foreground">({list.length})</span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{list.map(card)}</div>
            </section>
          );
        })
      )}

      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {target ? (
            <>
              <DialogHeader>
                <DialogTitle>{ruleLabel(target)}</DialogTitle>
                <DialogDescription>{target.title}</DialogDescription>
              </DialogHeader>
              {ruleHelp(target) ? (
                <div className="rounded-md bg-muted p-3 text-sm">
                  <span className="font-medium">{t("alerts.whatMeans")}: </span>
                  {ruleHelp(target)}
                </div>
              ) : null}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                {fact(
                  t("alerts.issued"),
                  str(target.detail?.issued_at) ? fmtDateTime(str(target.detail?.issued_at)) : "",
                )}
                {fact(t("alerts.created"), fmtDateTime(target.created_at))}
                {fact(t("alerts.amount"), target.amount != null ? `${fmtMoney(target.amount)} ${t("common.sar")}` : "")}
                {invoiceRefs(target).length ? null : fact(t("alerts.invoice"), str(target.detail?.number), true)}
                {fact(t("alerts.salesman"), str(target.salesman_name ?? target.detail?.salesman))}
                {fact(t("alerts.customer"), str(target.detail?.customer))}
                {fact("B2B / B2C", str(target.detail?.segment))}
                {fact(t("alerts.created_by"), str(target.detail?.created_by))}
                {fact("Odoo ref", str(target.detail?.ref), true)}
              </dl>
              {invoiceRefs(target).length ? (
                <div>
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{t("alerts.invoices")}</p>
                  <ul className="mt-1 space-y-1 rounded-md bg-muted/60 p-2" dir="ltr">
                    {invoiceRefs(target).map((i) => (
                      <li key={i.number} className="flex justify-between gap-2 font-mono text-xs">
                        <span>{i.number}</span>
                        <span className="text-muted-foreground">{i.issued_at ? fmtDateTime(i.issued_at) : ""}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {target.status !== "open" ? (
                <p className="text-sm">
                  <span className="text-muted-foreground">
                    {t("alerts.handledBy", { name: target.handled_by ?? "" })}:{" "}
                  </span>
                  {target.note}
                </p>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="al-note">{t("alerts.note")}</Label>
                <Textarea
                  id="al-note"
                  maxLength={1000}
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">{t("alerts.noteHelp")}</p>
              </div>
              <DialogFooter className="gap-2">
                {target.status !== "open" ? (
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
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
