"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { fmtDate, fmtMoney, riyadhMonth } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { bySupplier } from "@/lib/stats";
import type { Expense } from "@/lib/types";

export function TopSuppliers({ rows, now }: { rows: Expense[]; now: Date }) {
  const t = useT();
  const month = riyadhMonth(now);
  const list = bySupplier(
    rows.filter((r) => riyadhMonth(r.invoice_date) === month),
    6,
  );
  const max = list[0]?.total ? list[0].total : 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-normal">{t("chart.topSuppliers")}</CardTitle>
      </CardHeader>
      <CardContent>
        {list.length === 0 ? (
          <p className="py-16 text-center text-muted-foreground text-sm">{t("common.noData")}</p>
        ) : (
          <ol className="space-y-3">
            {list.map((s, i) => (
              <li key={s.name || i} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate font-medium">{s.name || t("common.unknown")}</span>
                  <span className="shrink-0 tabular-nums">
                    {fmtMoney(s.total)} {t("common.sar")}
                  </span>
                </div>
                <Progress value={(s.total / max) * 100} aria-label={s.name} />
                <p className="text-muted-foreground text-xs">
                  {t("kpi.invoices", { n: s.count })} · {t("top.last")} {fmtDate(s.last)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
