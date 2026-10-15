"use client";

import { useMemo } from "react";

import { cn } from "cn";
import { MessageCircle, PenLine, Smartphone, Type } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import type { Expense, Section } from "@/lib/types";

const SOURCE_ICON = {
  whatsapp_flow: MessageCircle,
  whatsapp_text: Type,
  ios_shortcut: Smartphone,
  admin_manual: PenLine,
} as const;

export function ActivityFeed({
  rows,
  fresh,
  loading,
}: {
  rows: Record<Section, Expense[]>;
  fresh: ReadonlySet<string>;
  loading: boolean;
}) {
  const t = useT();
  const feed = useMemo(
    () =>
      [
        ...rows.bakery.map((r) => ({ ...r, section: "bakery" as const })),
        ...rows.grocery.map((r) => ({ ...r, section: "grocery" as const })),
      ]
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, 20),
    [rows],
  );
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="font-normal">{t("dashboard.activity")}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-64 w-full" />
        ) : feed.length === 0 ? (
          <p className="py-16 text-center text-muted-foreground text-sm">{t("common.noData")}</p>
        ) : (
          <ScrollArea className="h-64">
            <ul aria-live="polite" className="space-y-1 pe-3">
              {feed.map((r) => {
                const Icon = SOURCE_ICON[r.source] ?? Type;
                const isFresh = fresh.has(r.id);
                return (
                  <li
                    key={`${r.section}-${r.id}`}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-2 py-2 transition-colors duration-1000",
                      isFresh && "fade-in slide-in-from-top-2 animate-in bg-primary/10 ring-1 ring-primary/30",
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={t(`source.${r.source}`)} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-sm">{r.seller_name || r.vat_number}</p>
                      <p className="truncate text-muted-foreground text-xs">
                        {r.submitted_by ?? "—"} · {fmtDateTime(r.created_at)}
                      </p>
                    </div>
                    <div className="shrink-0 text-end">
                      <p className="font-medium text-sm tabular-nums">{fmtMoney(r.total_amount)}</p>
                      <Badge variant="outline" className="text-[10px]">
                        {t(`section.${r.section}`)}
                      </Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
