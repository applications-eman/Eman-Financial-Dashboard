"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { kpis } from "@/lib/stats";
import type { Expense, Section } from "@/lib/types";

export function KpiCards({ section, rows, now }: { section: Section; rows: Expense[]; now: Date }) {
  const t = useT();
  const k = kpis(rows, now);
  const sar = t("common.sar");
  const items = [
    {
      label: t("kpi.today"),
      value: `${fmtMoney(k.today.total)} ${sar}`,
      hint: t("kpi.invoices", { n: k.today.count }),
    },
    {
      label: t("kpi.month"),
      value: `${fmtMoney(k.month.total)} ${sar}`,
      hint: t("kpi.invoices", { n: k.month.count }),
    },
    { label: t("kpi.vat"), value: `${fmtMoney(k.month.vat)} ${sar}`, hint: t("kpi.thisMonth") },
    { label: t("kpi.count"), value: String(k.month.count), hint: t("kpi.thisMonth") },
  ];
  return (
    <section aria-labelledby={`kpi-${section}`} className="space-y-2">
      <h2 id={`kpi-${section}`} className="font-medium text-muted-foreground text-sm">
        {t(`section.${section}`)}
      </h2>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {items.map((i) => (
          <Card key={i.label} size="sm">
            <CardHeader>
              <CardTitle className="font-normal text-muted-foreground text-sm">{i.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-semibold text-xl tabular-nums sm:text-2xl">{i.value}</div>
              <p className="text-muted-foreground text-xs">{i.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
