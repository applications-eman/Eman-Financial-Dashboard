"use client";

import { type FormEvent, useEffect, useState } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { adminSend } from "@/lib/admin-api";
import { useT } from "@/lib/i18n/provider";
import type { Expense, Section, Status } from "@/lib/types";

import { type Option, SimpleSelect } from "../common/simple-select";

interface Props {
  section: Section;
  /** null => create a manual expense */
  expense: Expense | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: Option[];
  onSaved: () => void;
}

// <input type="datetime-local"> value for a Riyadh wall-clock time
const toLocal = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 16);
const fromLocal = (v: string) => `${v}:00+03:00`;

export function ExpenseDialog({ section, expense, open, onOpenChange, categories, onSaved }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    seller_name: "",
    vat_number: "",
    invoice_date: "",
    total: "",
    vat: "",
    category: "",
    notes: "",
    status: "new" as Status,
  });

  useEffect(() => {
    if (!open) return;
    setF(
      expense
        ? {
            seller_name: expense.seller_name ?? "",
            vat_number: expense.vat_number ?? "",
            invoice_date: toLocal(expense.invoice_date),
            total: String(expense.total_amount),
            vat: String(expense.vat_amount),
            category: expense.category ?? "",
            notes: expense.notes ?? "",
            status: expense.status,
          }
        : {
            seller_name: "",
            vat_number: "",
            invoice_date: toLocal(new Date().toISOString()),
            total: "",
            vat: "",
            category: "",
            notes: "",
            status: "new",
          },
    );
  }, [open, expense]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const base = {
        seller_name: f.seller_name,
        vat_number: f.vat_number.trim(),
        invoice_date: fromLocal(f.invoice_date),
        total_amount: Number(f.total),
        vat_amount: Number(f.vat),
        category: f.category || (expense ? null : undefined),
        notes: f.notes || (expense ? null : undefined),
      };
      if (expense) await adminSend("PATCH", `/admin/expenses/${section}/${expense.id}`, { ...base, status: f.status });
      else await adminSend("POST", `/admin/expenses/${section}`, base);
      toast.success(t("common.saved"));
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const field = (id: string, label: string, el: React.ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {el}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{expense ? t("expense.edit") : t("expense.add")}</DialogTitle>
            <DialogDescription>{t(`section.${section}`)}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {field(
              "e-seller",
              t("table.supplier"),
              <Input
                id="e-seller"
                value={f.seller_name}
                onChange={(e) => setF({ ...f, seller_name: e.target.value })}
              />,
            )}
            {field(
              "e-vatno",
              t("table.vatNumber"),
              <Input
                id="e-vatno"
                dir="ltr"
                inputMode="numeric"
                maxLength={20}
                value={f.vat_number}
                onChange={(e) => setF({ ...f, vat_number: e.target.value })}
              />,
            )}
            {field(
              "e-date",
              t("table.date"),
              <Input
                id="e-date"
                type="datetime-local"
                required
                value={f.invoice_date}
                onChange={(e) => setF({ ...f, invoice_date: e.target.value })}
              />,
            )}
            {field(
              "e-cat",
              t("table.category"),
              <SimpleSelect
                size="default"
                className="w-full"
                label={t("table.category")}
                allLabel={t("common.uncategorized")}
                value={f.category}
                onChange={(v) => setF({ ...f, category: v })}
                options={categories}
              />,
            )}
            {field(
              "e-total",
              t("table.total"),
              <Input
                id="e-total"
                type="number"
                step="0.01"
                min="0"
                required
                value={f.total}
                onChange={(e) => setF({ ...f, total: e.target.value })}
              />,
            )}
            {field(
              "e-vat",
              t("table.vat"),
              <Input
                id="e-vat"
                type="number"
                step="0.01"
                min="0"
                required
                value={f.vat}
                onChange={(e) => setF({ ...f, vat: e.target.value })}
              />,
            )}
          </div>
          {field(
            "e-notes",
            t("table.notes"),
            <Textarea
              id="e-notes"
              rows={2}
              maxLength={1000}
              value={f.notes}
              onChange={(e) => setF({ ...f, notes: e.target.value })}
            />,
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
