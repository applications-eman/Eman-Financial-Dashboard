"use client";

import { useMemo } from "react";

import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveExpenses } from "@/hooks/use-live-expenses";
import { fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { SECTIONS } from "@/lib/types";

import { ActivityFeed } from "./activity-feed";
import { CategoryChart } from "./category-chart";
import { DailyChart } from "./daily-chart";
import { KpiCards } from "./kpi-cards";
import { SupplierChart } from "./supplier-chart";
import { TopSuppliers } from "./top-suppliers";

export function LiveDashboard() {
  const t = useT();
  const { rows, status, error, loading, fresh } = useLiveExpenses({
    onInsert: (section, row) =>
      toast.success(t("dashboard.newInvoice"), {
        description: `${t(`section.${section}`)} · ${row.seller_name ?? row.vat_number} · ${fmtMoney(row.total_amount)} ${t("common.sar")}`,
      }),
  });
  const now = useMemo(() => new Date(), []);
  const all = useMemo(() => [...rows.bakery, ...rows.grocery], [rows]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Badge variant={status === "live" ? "default" : status === "error" ? "destructive" : "secondary"} role="status">
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${status === "live" ? "animate-pulse bg-current" : "bg-current opacity-60"}`}
          />
          {t(`dashboard.status.${status}`)}
        </Badge>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t("common.loadError")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-4">
          {["a", "b", "c", "d"].map((k) => (
            <Skeleton key={k} className="h-28" />
          ))}
        </div>
      ) : (
        SECTIONS.map((s) => <KpiCards key={s} section={s} rows={rows[s]} now={now} />)
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <DailyChart bakery={rows.bakery} grocery={rows.grocery} now={now} loading={loading} />
        </div>
        <div className="xl:col-span-5">
          <ActivityFeed rows={rows} fresh={fresh} loading={loading} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <CategoryChart rows={all} now={now} />
        <SupplierChart rows={all} now={now} />
        <TopSuppliers rows={all} now={now} />
      </div>
    </div>
  );
}
