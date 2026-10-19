import { cn } from "cn";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";

export type { AlertRow, AlertTotals, InvoiceRef, Severity, Status } from "./alerts-types";
export { invoiceRefs, isCredit, str, totalsOf } from "./alerts-types";

import type { Severity } from "./alerts-types";

export const SEVERITIES: Severity[] = ["critical", "warning", "info"];
export const STYLE: Record<Severity, { bar: string; chip: string; tile: string; icon: typeof Info }> = {
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

/** One labelled value (used on the cards and in the detail window). */
export const fact = (label: string, value: string, mono = false) =>
  value ? (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</dt>
      <dd className={cn("truncate text-sm", mono && "font-mono text-xs")} dir={mono ? "ltr" : undefined} title={value}>
        {value}
      </dd>
    </div>
  ) : null;
