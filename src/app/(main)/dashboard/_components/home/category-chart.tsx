"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { riyadhMonth } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { byCategory } from "@/lib/stats";
import type { Expense } from "@/lib/types";

export function CategoryChart({ rows, now }: { rows: Expense[]; now: Date }) {
  const t = useT();
  const month = riyadhMonth(now);
  const data = byCategory(rows.filter((r) => riyadhMonth(r.invoice_date) === month)).map((d) => ({
    ...d,
    name: d.name || t("common.uncategorized"),
  }));
  const config = { value: { label: t("common.total"), color: "var(--chart-3)" } } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-normal">{t("chart.category")}</CardTitle>
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
                width={96}
                tick={{ fontSize: 12 }}
              />
              <XAxis type="number" hide />
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Bar dataKey="value" fill="var(--color-value)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
