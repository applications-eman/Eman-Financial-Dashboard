"use client";

import { useState } from "react";

import { CalendarRange, FilterX } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EMPTY_FILTERS, type ExpenseFilters } from "@/hooks/use-expenses-query";
import { fmtDate } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { SOURCES, STATUSES } from "@/lib/types";

import { type Option, SimpleSelect } from "../common/simple-select";

const toDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromDay = (s: string) => (s ? new Date(`${s}T12:00:00`) : undefined);

export function ExpenseFilterBar({
  value,
  onChange,
  categories,
  submitters,
}: {
  value: ExpenseFilters;
  onChange: (v: ExpenseFilters) => void;
  categories: Option[];
  submitters: Option[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const set = <K extends keyof ExpenseFilters>(k: K, v: ExpenseFilters[K]) => onChange({ ...value, [k]: v });
  const range: DateRange | undefined = value.from ? { from: fromDay(value.from), to: fromDay(value.to) } : undefined;
  const rangeLabel = value.from
    ? `${fmtDate(`${value.from}T12:00:00+03:00`)}${value.to ? ` – ${fmtDate(`${value.to}T12:00:00+03:00`)}` : ""}`
    : t("filters.dates");
  const dirty = JSON.stringify(value) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <search className="flex flex-wrap items-center gap-2" aria-label={t("filters.title")}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="font-normal">
            <CalendarRange data-icon="inline-start" />
            {rangeLabel}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={range}
            onSelect={(r) => onChange({ ...value, from: r?.from ? toDay(r.from) : "", to: r?.to ? toDay(r.to) : "" })}
          />
        </PopoverContent>
      </Popover>
      <Input
        className="h-8 w-44"
        placeholder={t("filters.supplier")}
        aria-label={t("filters.supplier")}
        value={value.supplier}
        onChange={(e) => set("supplier", e.target.value)}
      />
      <SimpleSelect
        className="w-40"
        label={t("table.category")}
        allLabel={t("filters.allCategories")}
        value={value.category}
        onChange={(v) => set("category", v)}
        options={categories}
      />
      <SimpleSelect
        className="w-36"
        label={t("table.status")}
        allLabel={t("filters.allStatuses")}
        value={value.status}
        onChange={(v) => set("status", v)}
        options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
      />
      <SimpleSelect
        className="w-40"
        label={t("table.submitter")}
        allLabel={t("filters.allSubmitters")}
        value={value.submitter}
        onChange={(v) => set("submitter", v)}
        options={submitters}
      />
      <SimpleSelect
        className="w-40"
        label={t("table.source")}
        allLabel={t("filters.allSources")}
        value={value.source}
        onChange={(v) => set("source", v)}
        options={SOURCES.map((s) => ({ value: s, label: t(`source.${s}`) }))}
      />
      <div className="flex items-center gap-1.5">
        <Checkbox id="f-warn" checked={value.warningsOnly} onCheckedChange={(c) => set("warningsOnly", c === true)} />
        <Label htmlFor="f-warn" className="font-normal text-sm">
          {t("filters.warningsOnly")}
        </Label>
      </div>
      <div className="flex items-center gap-1.5">
        <Checkbox
          id="f-dup"
          checked={value.duplicatesOnly}
          onCheckedChange={(c) => set("duplicatesOnly", c === true)}
        />
        <Label htmlFor="f-dup" className="font-normal text-sm">
          {t("filters.duplicatesOnly")}
        </Label>
      </div>
      {dirty ? (
        <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTERS)}>
          <FilterX data-icon="inline-start" />
          {t("filters.clear")}
        </Button>
      ) : null}
    </search>
  );
}
