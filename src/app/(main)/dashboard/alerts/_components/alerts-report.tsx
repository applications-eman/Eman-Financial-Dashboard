"use client";

import { useEffect, useMemo, useRef } from "react";

import { cn } from "cn";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n/messages";
import { useT } from "@/lib/i18n/provider";

import { type AlertRow, fact, invoiceRefs, isCredit, SEVERITIES, type Severity, STYLE, str } from "./alerts-shared";

export const ITEMS_PER_PAGE = 15;

const sectionTitle: Record<Severity, MessageKey> = {
  critical: "alerts.sectionCritical",
  warning: "alerts.sectionWarning",
  info: "alerts.sectionInfo",
};

function AlertCard({ a, label, onOpen }: { a: AlertRow; label: string; onOpen: (a: AlertRow) => void }) {
  const t = useT();
  const S = STYLE[a.severity];
  const Icon = S.icon;
  const segment = str(a.detail?.segment);
  return (
    <button
      type="button"
      onClick={() => onOpen(a)}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border border-s-4 bg-card p-3 text-start shadow-xs transition hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring",
        S.bar,
        a.status !== "open" && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn("inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 font-medium text-xs", S.chip)}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
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
        {invoiceRefs(a).length
          ? null
          : fact(isCredit(a) ? t("alerts.creditNote") : t("alerts.invoice"), str(a.detail?.number), true)}
        {fact(t("alerts.salesman"), str(a.salesman_name ?? a.detail?.salesman))}
        {fact(t("alerts.customer"), str(a.detail?.customer))}
        {isCredit(a) ? fact(t("alerts.issuedBy"), str(a.detail?.issued_by ?? a.detail?.created_by)) : null}
        {isCredit(a)
          ? fact(t("alerts.originalInvoice"), str(a.detail?.original_invoice) || t("alerts.notLinked"), true)
          : null}
      </dl>
      {isCredit(a) ? (
        <p className="rounded-md bg-muted/60 p-2 text-xs">
          <span className="text-muted-foreground">{t("alerts.reason")}: </span>
          {a.detail?.no_reason || !str(a.detail?.reason) ? (
            <span className="text-amber-600 dark:text-amber-400">{t("alerts.noReason")}</span>
          ) : (
            str(a.detail?.reason)
          )}
        </p>
      ) : null}
      {a.rule_key === "unusual_amount" ? (
        <div className="space-y-0.5 rounded-md bg-muted/60 p-2 text-xs">
          <p>
            <span className="text-muted-foreground">{t("alerts.dayTotal")}: </span>
            <b className="tabular-nums">
              {fmtMoney(Number(a.detail?.day_total ?? a.amount))} {t("common.sar")}
            </b>{" "}
            ({t("alerts.dayInvoices", { n: Number(a.detail?.day_invoices ?? 1) })})
          </p>
          <p>
            <span className="text-muted-foreground">{t("alerts.usualDay")}: </span>
            {Number(a.detail?.usual_count ?? 0) > 0
              ? t("alerts.usualDayValue", {
                  usual: fmtMoney(Number(a.detail?.usual_amount)),
                  highest: fmtMoney(Number(a.detail?.usual_highest)),
                  n: Number(a.detail?.usual_count),
                })
              : t("alerts.noUsual")}
          </p>
        </div>
      ) : null}
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

/**
 * The report: 15 alert cards per page, grouped by severity, with the page buttons fixed at the bottom.
 * The cards scroll inside this component; the filters above it and the page buttons below it stay in place.
 */
export function AlertsReport({
  alerts,
  loading,
  page,
  onPage,
  ruleLabel,
  onOpen,
}: {
  alerts: AlertRow[] | null;
  loading: boolean;
  page: number;
  onPage: (p: number) => void;
  ruleLabel: (a: AlertRow) => string;
  onOpen: (a: AlertRow) => void;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);

  // most serious first; the order inside each group (newest first) is kept
  const ordered = useMemo(
    () => [...(alerts ?? [])].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)),
    [alerts],
  );
  const pages = Math.max(1, Math.ceil(ordered.length / ITEMS_PER_PAGE));
  const current = Math.min(Math.max(1, page), pages);
  const slice = ordered.slice((current - 1) * ITEMS_PER_PAGE, current * ITEMS_PER_PAGE);

  // a new page starts at the top of the list
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on page change only
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [current]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto pe-1 pb-3">
        {loading || alerts === null ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40 w-full" />
            ))}
          </div>
        ) : ordered.length === 0 ? (
          <p className="rounded-lg border bg-card py-12 text-center text-muted-foreground text-sm">
            {t("alerts.none")}
          </p>
        ) : (
          SEVERITIES.map((s) => {
            const part = slice.filter((a) => a.severity === s);
            if (!part.length) return null;
            return (
              <section key={s} className="space-y-2">
                <h2 className="font-medium text-sm">
                  {t(sectionTitle[s])}{" "}
                  <span className="text-muted-foreground">({ordered.filter((a) => a.severity === s).length})</span>
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {part.map((a) => (
                    <AlertCard key={a.id} a={a} label={ruleLabel(a)} onOpen={onOpen} />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
      {alerts !== null && ordered.length > 0 ? (
        <nav
          aria-label={t("alerts.pagination")}
          className="flex shrink-0 items-center justify-between gap-3 border-t bg-background pt-2"
        >
          <Button variant="outline" size="sm" disabled={current <= 1} onClick={() => onPage(current - 1)}>
            <ChevronLeft className="rtl:rotate-180" data-icon="inline-start" />
            {t("common.prev")}
          </Button>
          <span className="text-muted-foreground text-sm tabular-nums">
            {t("common.pageOf", { p: current, n: pages })}
          </span>
          <Button variant="outline" size="sm" disabled={current >= pages} onClick={() => onPage(current + 1)}>
            {t("common.next")}
            <ChevronRight className="rtl:rotate-180" data-icon="inline-end" />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
