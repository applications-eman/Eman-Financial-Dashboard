"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { riyadhMonth } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { bySupplier } from "@/lib/stats";
import type { Expense } from "@/lib/types";

export function SupplierChart({ rows, now }: { rows: Expense[]; now: Date }) {
  const t = useT();
  const month = riyadhMonth(now);
  const data = bySupplier(rows.filter((r) => riyadhMonth(r.invoice_date) === month)).map((s) => ({
    name: s.name || t("common.unknown"),
    total: s.total,
  }));
  const config = { total: { label: t("common.total"), color: "var(--chart-4)" } } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-normal">{t("chart.supplier")}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="py-16 text-center text-muted-foreground text-sm">{t("common.noData")}</p>
        ) : (
          <ChartContainer config={config} className="h-64 w-full">
            <BarChart
              accessibilityLayer
              data={data}
              layout="vertical"
              margin={{ left: 0, right: 8, top: 0, bottom: 0 }}
            >
              <CartesianGrid horizontal={false} />
              <YAxis
                dataKey="name"
                type="category"
                tickLine={false}
                axisLine={false}
                width={110}
                tick={{ fontSize: 12 }}
                tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
              />
              <XAxis type="number" hide />
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Bar dataKey="total" fill="var(--color-total)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
