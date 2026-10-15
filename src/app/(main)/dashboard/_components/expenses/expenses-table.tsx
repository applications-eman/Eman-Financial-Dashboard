"use client";

import { useState } from "react";

import { cn } from "cn";
import { AlertTriangle, CopyX, ImageIcon, Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDate, fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { type Expense, STATUSES } from "@/lib/types";

import { type Option, SimpleSelect } from "../common/simple-select";

interface Props {
  rows: Expense[];
  loading: boolean;
  fresh: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onSelect: (ids: string[], on: boolean) => void;
  categories: Option[];
  onPatch: (row: Expense, patch: Partial<Pick<Expense, "category" | "status" | "notes">>) => void;
  onEdit: (row: Expense) => void;
  onDelete: (row: Expense) => void;
  onImage: (row: Expense) => void;
}

function NotesCell({ row, onSave }: { row: Expense; onSave: (v: string) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(row.notes ?? "");
  if (!editing)
    return (
      <button
        type="button"
        onClick={() => {
          setV(row.notes ?? "");
          setEditing(true);
        }}
        className="max-w-48 truncate rounded px-1 text-start text-muted-foreground text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("table.editNotes")}
      >
        {row.notes ? row.notes : "—"}
      </button>
    );
  return (
    <Input
      autoFocus
      className="h-7 w-48"
      value={v}
      maxLength={1000}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (v !== (row.notes ?? "")) onSave(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setV(row.notes ?? "");
          setEditing(false);
        }
      }}
    />
  );
}

export function ExpensesTable({
  rows,
  loading,
  fresh,
  selected,
  onSelect,
  categories,
  onPatch,
  onEdit,
  onDelete,
  onImage,
}: Props) {
  const t = useT();
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const catOptions = (current: string | null): Option[] =>
    current && !categories.some((c) => c.value === current)
      ? [...categories, { value: current, label: current }]
      : categories;

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <Checkbox
                checked={allOn}
                onCheckedChange={(c) =>
                  onSelect(
                    rows.map((r) => r.id),
                    c === true,
                  )
                }
                aria-label={t("table.selectAll")}
              />
            </TableHead>
            <TableHead>{t("table.date")}</TableHead>
            <TableHead>{t("table.supplier")}</TableHead>
            <TableHead>{t("table.vatNumber")}</TableHead>
            <TableHead className="min-w-40">{t("table.category")}</TableHead>
            <TableHead className="text-end">{t("table.total")}</TableHead>
            <TableHead className="text-end">{t("table.vat")}</TableHead>
            <TableHead className="min-w-32">{t("table.status")}</TableHead>
            <TableHead>{t("table.flags")}</TableHead>
            <TableHead>{t("table.source")}</TableHead>
            <TableHead>{t("table.submitter")}</TableHead>
            <TableHead>{t("table.notes")}</TableHead>
            <TableHead className="w-28 text-end">
              <span className="sr-only">{t("table.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && rows.length === 0
            ? ["a", "b", "c", "d", "e"].map((k) => (
                <TableRow key={k}>
                  <TableCell colSpan={13}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            : null}
          {!loading && rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={13} className="h-32 text-center text-muted-foreground">
                {t("common.noData")}
              </TableCell>
            </TableRow>
          ) : null}
          {rows.map((r) => (
            <TableRow
              key={r.id}
              data-state={selected.has(r.id) ? "selected" : undefined}
              className={cn(fresh.has(r.id) && "animate-in bg-primary/10 duration-500")}
            >
              <TableCell>
                <Checkbox
                  checked={selected.has(r.id)}
                  onCheckedChange={(c) => onSelect([r.id], c === true)}
                  aria-label={t("table.selectRow")}
                />
              </TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(r.invoice_date)}</TableCell>
              <TableCell className="max-w-56 truncate font-medium" title={r.seller_name ?? ""}>
                {r.seller_name || "—"}
              </TableCell>
              <TableCell className="tabular-nums" dir="ltr">
                {r.vat_number}
              </TableCell>
              <TableCell>
                <SimpleSelect
                  className="w-40"
                  label={t("table.category")}
                  allLabel={t("common.uncategorized")}
                  value={r.category ?? ""}
                  options={catOptions(r.category)}
                  onChange={(v) => onPatch(r, { category: v === "" ? null : v })}
                />
              </TableCell>
              <TableCell className="text-end font-medium tabular-nums">{fmtMoney(r.total_amount)}</TableCell>
              <TableCell className="text-end tabular-nums">{fmtMoney(r.vat_amount)}</TableCell>
              <TableCell>
                <SimpleSelect
                  className="w-32"
                  label={t("table.status")}
                  value={r.status}
                  options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
                  onChange={(v) => onPatch(r, { status: v as Expense["status"] })}
                />
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {r.warnings?.includes("vat_rate_mismatch") ? (
                    <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">
                      <AlertTriangle aria-hidden="true" />
                      {t("badge.vatWarning")}
                    </Badge>
                  ) : null}
                  {r.warnings?.includes("vat_number_invalid") ? (
                    <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">
                      <AlertTriangle aria-hidden="true" />
                      {t("badge.vatInvalid")}
                    </Badge>
                  ) : null}
                  {r.warnings?.includes("future_date") ? (
                    <Badge variant="outline">{t("badge.futureDate")}</Badge>
                  ) : null}
                  {r.duplicate_count > 0 ? (
                    <Badge variant="destructive">
                      <CopyX aria-hidden="true" />
                      {t("badge.duplicate", { n: r.duplicate_count })}
                    </Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                {t(`source.${r.source}`)}
              </TableCell>
              <TableCell className="whitespace-nowrap text-sm">{r.submitted_by ?? "—"}</TableCell>
              <TableCell>
                <NotesCell row={r} onSave={(v) => onPatch(r, { notes: v === "" ? null : v })} />
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={!r.image_path}
                    onClick={() => onImage(r)}
                    aria-label={t("expense.image")}
                  >
                    <ImageIcon />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => onEdit(r)} aria-label={t("common.edit")}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => onDelete(r)} aria-label={t("common.delete")}>
                    <Trash2 />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
