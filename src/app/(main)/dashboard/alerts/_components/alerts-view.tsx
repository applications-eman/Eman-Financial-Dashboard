"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "cn";
import { FilterX, Search } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Textarea } from "@/components/ui/textarea";
import { adminSend } from "@/lib/admin-api";
import { addDays, fmtDateTime, fmtMoney, riyadhDay, riyadhStartOfDay } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n/messages";
import { useT } from "@/lib/i18n/provider";
import { today } from "@/lib/revenue";
import { getSupabase } from "@/lib/supabase/client";

import { SearchSelect } from "../../_components/common/search-select";
import { SimpleSelect } from "../../_components/common/simple-select";
import { AlertsReport } from "./alerts-report";
import {
  type AlertRow,
  fact,
  invoiceRefs,
  isCredit,
  SEVERITIES,
  type Severity,
  STYLE,
  type Status,
  str,
  totalsOf,
} from "./alerts-shared";

const FETCH_PAGE = 1000; // the database returns at most 1000 rows per request, so we read page after page
const MAX_PAGES = 12;
const LIMIT = FETCH_PAGE * MAX_PAGES;

export function AlertsView() {
  const t = useT();
  const [rows, setRows] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"open" | "done" | "all">("open");
  const [period, setPeriod] = useState<"today" | "7" | "30" | "all" | "custom">("7");
  const [from, setFrom] = useState(addDays(today(), -6));
  const [to, setTo] = useState(today());
  const [customer, setCustomer] = useState("");
  const [severity, setSeverity] = useState<Severity | "">("");
  const [rule, setRule] = useState("");
  const [salesman, setSalesman] = useState("");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<AlertRow | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    // an alert is always raised after its invoice, so this safely loads a superset; the exact day filter is applied on the invoice time below
    const lo =
      period === "all"
        ? null
        : period === "custom"
          ? from
          : period === "today"
            ? today()
            : addDays(today(), -Number(period) + 1);
    const all: AlertRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      let q = getSupabase()
        .from("alerts")
        .select("*")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(page * FETCH_PAGE, page * FETCH_PAGE + FETCH_PAGE - 1);
      if (status === "open") q = q.eq("status", "open");
      if (status === "done") q = q.in("status", ["acknowledged", "resolved"]);
      if (lo) q = q.gte("created_at", riyadhStartOfDay(lo));
      const { data, error: e } = await q;
      if (e) {
        setError(e.message);
        return;
      }
      all.push(...(data as AlertRow[]));
      if ((data?.length ?? 0) < FETCH_PAGE) break;
    }
    setError(null);
    setRows(all);
  }, [status, period, from]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  // Realtime: new alerts appear without refreshing
  useEffect(() => {
    const sb = getSupabase();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // many alerts can arrive in one sync: reload once after the burst
    const ch = sb
      .channel("alerts-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 800);
      })
      .subscribe();
    return () => {
      clearTimeout(timer);
      void sb.removeChannel(ch);
    };
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
    const lo =
      period === "all"
        ? ""
        : period === "custom"
          ? from
          : period === "today"
            ? today()
            : addDays(today(), -Number(period) + 1);
    const hi = period === "custom" ? to : period === "all" ? "" : today();
    const when = (a: AlertRow) => str(a.detail?.issued_at) || a.created_at;
    return (rows ?? [])
      .filter((a) => {
        const day = riyadhDay(when(a));
        if (lo && day < lo) return false;
        if (hi && day > hi) return false;
        if (rule && a.rule_key !== rule) return false;
        if (salesman && a.salesman_name !== salesman) return false;
        if (customer && str(a.detail?.customer) !== customer) return false;
        if (!needle) return true;
        const hay = [a.detail?.number, a.detail?.customer, a.salesman_name, a.title, a.detail?.ref]
          .map(str)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      })
      .sort((a, b) => Date.parse(when(b)) - Date.parse(when(a)));
  }, [rows, rule, salesman, customer, query, period, from, to]);
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
  const customers = useMemo(
    () =>
      [...new Set((rows ?? []).map((a) => str(a.detail?.customer)).filter(Boolean))]
        .sort()
        .map((c) => ({ value: c, label: c })),
    [rows],
  );
  const [page, setPage] = useState(1);
  const filtered = severity !== "" || rule !== "" || salesman !== "" || customer !== "" || query !== "";

  // master reset: every filter off, every status, all time - the full list again
  const dirty = filtered || status !== "all" || period !== "all";
  function resetAll() {
    setSeverity("");
    setRule("");
    setSalesman("");
    setCustomer("");
    setQuery("");
    setStatus("all");
    setPeriod("all");
    setFrom(addDays(today(), -6));
    setTo(today());
  }
  // back to page 1 whenever the list changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger list
  useEffect(() => setPage(1), [status, period, from, to, severity, rule, salesman, customer, query]);
  const totals = useMemo(() => totalsOf(shown), [shown]);

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

  const pill = (active: boolean, label: string, onClick: () => void) => (
    <Button size="sm" variant={active ? "default" : "outline"} aria-pressed={active} onClick={onClick}>
      {label}
    </Button>
  );

  const open = useCallback((a: AlertRow) => {
    setTarget(a);
    setNote(a.note ?? "");
  }, []);

  return (
    <div className="flex h-[calc(100svh-5.5rem)] min-h-96 flex-col gap-2">
      {/* fixed top: title, counters, filters and the totals of the filtered report */}
      <div className="max-h-[50%] shrink-0 space-y-2 overflow-y-auto pe-1">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h1 className="text-2xl tracking-tight">{t("alerts.title")}</h1>
          <p className="text-muted-foreground text-xs">{t("alerts.subtitle")}</p>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
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
                  "flex items-center gap-3 rounded-lg border bg-card px-3 py-1.5 text-start transition hover:shadow-md",
                  S.tile,
                )}
              >
                <span className={cn("rounded-md p-1.5", S.chip)}>
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span>
                  <span className="block font-semibold text-2xl tabular-nums leading-none">
                    {rows ? counts[s] : "…"}
                  </span>
                  <span className="text-muted-foreground text-sm">{t(`alerts.severity.${s}`)}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {pill(status === "open", t("alerts.statusOpen"), () => setStatus(status === "open" ? "all" : "open"))}
          {pill(status === "done", t("alerts.statusDone"), () => setStatus(status === "done" ? "all" : "done"))}
          {pill(status === "all", t("alerts.statusAll"), () => setStatus("all"))}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          {pill(period === "today", t("alerts.today"), () => setPeriod(period === "today" ? "all" : "today"))}
          {pill(period === "7", t("alerts.days7"), () => setPeriod(period === "7" ? "all" : "7"))}
          {pill(period === "30", t("alerts.days30"), () => setPeriod(period === "30" ? "all" : "30"))}
          {pill(period === "all", t("alerts.allTime"), () => setPeriod("all"))}
          {pill(period === "custom", t("alerts.custom"), () => setPeriod(period === "custom" ? "all" : "custom"))}
          {period === "custom" ? (
            <>
              <Input
                type="date"
                aria-label={t("exports.from")}
                className="w-40"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
              />
              <Input
                type="date"
                aria-label={t("exports.to")}
                className="w-40"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
              />
            </>
          ) : null}
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
          <SearchSelect
            label={t("alerts.salesman")}
            value={salesman}
            onChange={setSalesman}
            allLabel={t("alerts.allSalesmen")}
            options={salesmen}
          />
          <SearchSelect
            label={t("alerts.customer")}
            value={customer}
            onChange={setCustomer}
            allLabel={t("alerts.allCustomers")}
            options={customers}
          />
          <Button variant={dirty ? "default" : "outline"} size="sm" onClick={resetAll}>
            <FilterX data-icon="inline-start" />
            {t("alerts.clear")}
          </Button>
          <span className="ms-auto text-muted-foreground text-sm">{t("alerts.count", { n: shown.length })}</span>
        </div>

        {/* totals of exactly what the filters above are showing (each invoice / credit note counted once) */}
        {rows ? (
          <div
            className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border bg-card px-3 py-1.5 text-sm"
            title={t("alerts.totalsHelp")}
          >
            <span className="font-medium">{t("alerts.totals")}</span>
            <span>
              {t("alerts.totalInvoices", { n: totals.invoiceCount })}:{" "}
              <b className="tabular-nums">
                {fmtMoney(totals.invoiceTotal)} {t("common.sar")}
              </b>
            </span>
            <span>
              {t("alerts.totalCredits", { n: totals.creditCount })}:{" "}
              <b className="tabular-nums">
                {fmtMoney(totals.creditTotal)} {t("common.sar")}
              </b>
            </span>
            {totals.repeatedExtra > 0 ? (
              <span>
                {t("alerts.totalExtra")}:{" "}
                <b className="tabular-nums">
                  {fmtMoney(totals.repeatedExtra)} {t("common.sar")}
                </b>
              </span>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {rows && rows.length >= LIMIT ? (
          <p className="text-muted-foreground text-xs">{t("alerts.limit", { n: LIMIT })}</p>
        ) : null}
      </div>

      {/* the report: cards scroll here, the page buttons stay at the bottom */}
      <AlertsReport
        alerts={rows === null ? null : shown}
        loading={rows === null}
        page={page}
        onPage={setPage}
        ruleLabel={ruleLabel}
        onOpen={open}
      />

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
                {invoiceRefs(target).length
                  ? null
                  : fact(
                      isCredit(target) ? t("alerts.creditNote") : t("alerts.invoice"),
                      str(target.detail?.number),
                      true,
                    )}
                {isCredit(target)
                  ? fact(t("alerts.issuedBy"), str(target.detail?.issued_by ?? target.detail?.created_by))
                  : null}
                {isCredit(target)
                  ? fact(
                      t("alerts.originalInvoice"),
                      str(target.detail?.original_invoice) || t("alerts.notLinked"),
                      true,
                    )
                  : null}
                {isCredit(target)
                  ? fact(
                      t("alerts.reason"),
                      target.detail?.no_reason || !str(target.detail?.reason)
                        ? t("alerts.noReason")
                        : str(target.detail?.reason),
                    )
                  : null}
                {target.rule_key === "unusual_amount"
                  ? fact(
                      t("alerts.dayTotal"),
                      `${fmtMoney(Number(target.detail?.day_total ?? target.amount))} ${t("common.sar")} (${t("alerts.dayInvoices", { n: Number(target.detail?.day_invoices ?? 1) })})`,
                    )
                  : null}
                {target.rule_key === "unusual_amount"
                  ? fact(
                      t("alerts.usualDay"),
                      Number(target.detail?.usual_count ?? 0) > 0
                        ? t("alerts.usualDayValue", {
                            usual: fmtMoney(Number(target.detail?.usual_amount)),
                            highest: fmtMoney(Number(target.detail?.usual_highest)),
                            n: Number(target.detail?.usual_count),
                          })
                        : t("alerts.noUsual"),
                    )
                  : null}
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
