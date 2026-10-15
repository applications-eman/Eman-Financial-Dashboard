"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n/provider";
import { dailySeries } from "@/lib/stats";
import type { Expense } from "@/lib/types";

export function DailyChart({
  bakery,
  grocery,
  now,
  loading,
}: {
  bakery: Expense[];
  grocery: Expense[];
  now: Date;
  loading: boolean;
}) {
  const t = useT();
  const data = dailySeries(bakery, grocery, 14, now);
  const config = {
    bakery: { label: t("section.bakery"), color: "var(--chart-1)" },
    grocery: { label: t("section.grocery"), color: "var(--chart-2)" },
  } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-normal">{t("chart.daily")}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <ChartContainer config={config} className="h-64 w-full">
            <BarChart accessibilityLayer data={data} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 12 }} />
              <YAxis hide />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="bakery" stackId="a" fill="var(--color-bakery)" radius={[0, 0, 0, 0]} />
              <Bar dataKey="grocery" stackId="a" fill="var(--color-grocery)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
