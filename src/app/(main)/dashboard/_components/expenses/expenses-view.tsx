"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ChevronLeft, ChevronRight, Download, FileSpreadsheet, Plus } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EMPTY_FILTERS, type ExpenseFilters, PAGE_SIZE, useExpensesQuery } from "@/hooks/use-expenses-query";
import { adminJson, adminSend } from "@/lib/admin-api";
import { downloadExport } from "@/lib/download";
import { fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { getSupabase } from "@/lib/supabase/client";
import { type AppUser, type Category, type Expense, expenseTable, type Section, STATUSES } from "@/lib/types";

import { type Option, SimpleSelect } from "../common/simple-select";
import { ExpenseDialog } from "./expense-dialog";
import { ExpenseFilterBar } from "./expense-filters";
import { ExpensesTable } from "./expenses-table";
import { ImageDialog } from "./image-dialog";

export function ExpensesView({ section }: { section: Section }) {
  const t = useT();
  const [filters, setFilters] = useState<ExpenseFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const { rows, count, loading, error, reload, setRows } = useExpensesQuery(section, filters, page);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [categories, setCategories] = useState<Option[]>([]);
  const [submitters, setSubmitters] = useState<Option[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Expense | null | undefined>(undefined); // undefined = closed, null = new
  const [imageOf, setImageOf] = useState<Expense | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const [bulkStatus, setBulkStatus] = useState("reviewed");
  const [exporting, setExporting] = useState(false);

  const changeFilters = (f: ExpenseFilters) => {
    setFilters(f);
    setPage(0);
    setSelected(new Set());
  };

  // reference data: categories straight from Supabase (RLS), staff names via the admin API
  useEffect(() => {
    getSupabase()
      .from("categories")
      .select("*")
      .eq("section", section)
      .order("name")
      .then(({ data }) =>
        setCategories(
          ((data ?? []) as Category[]).filter((c) => c.active).map((c) => ({ value: c.name, label: c.name })),
        ),
      );
    adminJson<{ rows: AppUser[] }>("/admin/users")
      .then((r) => setSubmitters(r.rows.map((u) => ({ value: u.name, label: u.name }))))
      .catch(() => setSubmitters([]));
  }, [section]);

  // Realtime: new invoices refresh the list; edits/deletes by others patch rows in place
  const reloadRef = useCallback(() => void reload(), [reload]);
  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel(`expenses-${section}`)
      .on("postgres_changes", { event: "*", schema: "public", table: expenseTable(section) }, (p) => {
        if (p.eventType === "INSERT") {
          const row = p.new as Expense;
          setFresh((s) => new Set(s).add(row.id));
          setTimeout(
            () =>
              setFresh((s) => {
                const n = new Set(s);
                n.delete(row.id);
                return n;
              }),
            8000,
          );
          toast.info(t("dashboard.newInvoice"), {
            description: `${row.seller_name ?? row.vat_number} · ${fmtMoney(row.total_amount)} ${t("common.sar")}`,
          });
          reloadRef();
        } else if (p.eventType === "UPDATE") {
          const row = p.new as Expense;
          setRows((cur) => cur.map((r) => (r.id === row.id ? row : r)));
        } else if (p.eventType === "DELETE") {
          const id = (p.old as { id?: string }).id;
          setRows((cur) => cur.filter((r) => r.id !== id));
        }
      })
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [section, setRows, reloadRef, t]);

  async function patch(row: Expense, p: Partial<Pick<Expense, "category" | "status" | "notes">>) {
    const before = row;
    setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, ...p } : r))); // optimistic
    try {
      await adminSend("PATCH", `/admin/expenses/${section}/${row.id}`, p);
    } catch (e) {
      setRows((cur) => cur.map((r) => (r.id === row.id ? before : r)));
      toast.error(e instanceof Error ? e.message : t("common.error"));
    }
  }

  async function applyBulk() {
    try {
      const r = await adminSend<{ updated: number }>("POST", `/admin/expenses/${section}/bulk-status`, {
        ids: [...selected],
        status: bulkStatus,
      });
      toast.success(t("expenses.bulkDone", { n: r.updated }));
      setSelected(new Set());
      void reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await adminSend("DELETE", `/admin/expenses/${section}/${deleting.id}`);
      setRows((cur) => cur.filter((r) => r.id !== deleting.id));
      toast.success(t("common.deleted"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    }
    setDeleting(null);
  }

  async function doExport(format: "csv" | "xls") {
    setExporting(true);
    try {
      await downloadExport({
        section,
        format,
        from: filters.from,
        to: filters.to,
        supplier: filters.supplier,
        category: filters.category,
        status: filters.status,
        submitter: filters.submitter,
        source: filters.source,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setExporting(false);
    }
  }

  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const pageTotal = useMemo(() => rows.reduce((a, r) => a + Number(r.total_amount), 0), [rows]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl tracking-tight">{t(`expenses.title.${section}`)}</h1>
          <p className="text-muted-foreground text-sm">{t("expenses.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setEditing(null)}>
            <Plus data-icon="inline-start" />
            {t("expense.add")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={exporting}>
                <Download data-icon="inline-start" />
                {t("common.export")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => doExport("csv")}>
                <Download /> CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => doExport("xls")}>
                <FileSpreadsheet /> Excel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ExpenseFilterBar value={filters} onChange={changeFilters} categories={categories} submitters={submitters} />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {selected.size > 0 ? (
        <section
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2"
          aria-label={t("expenses.bulk")}
        >
          <span className="text-sm">{t("expenses.selected", { n: selected.size })}</span>
          <SimpleSelect
            className="w-36"
            label={t("table.status")}
            value={bulkStatus}
            onChange={setBulkStatus}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
          />
          <Button size="sm" onClick={applyBulk}>
            {t("expenses.applyStatus")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {t("common.cancel")}
          </Button>
        </section>
      ) : null}

      <ExpensesTable
        rows={rows}
        loading={loading}
        fresh={fresh}
        selected={selected}
        onSelect={(ids, on) =>
          setSelected((cur) => {
            const n = new Set(cur);
            for (const id of ids) on ? n.add(id) : n.delete(id);
            return n;
          })
        }
        categories={categories}
        onPatch={patch}
        onEdit={(r) => setEditing(r)}
        onDelete={setDeleting}
        onImage={setImageOf}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-sm">
        <span>
          {t("expenses.count", { n: count })} · {t("expenses.pageTotal")}:{" "}
          <span className="tabular-nums">{fmtMoney(pageTotal)}</span> {t("common.sar")}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            aria-label={t("common.prev")}
          >
            <ChevronLeft className="rtl:rotate-180" />
          </Button>
          <span aria-live="polite">{t("common.pageOf", { p: page + 1, n: pages })}</span>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
            aria-label={t("common.next")}
          >
            <ChevronRight className="rtl:rotate-180" />
          </Button>
        </div>
      </div>

      <ExpenseDialog
        section={section}
        expense={editing ?? null}
        open={editing !== undefined}
        onOpenChange={(o) => !o && setEditing(undefined)}
        categories={categories}
        onSaved={() => void reload()}
      />
      <ImageDialog section={section} expense={imageOf} onClose={() => setImageOf(null)} />
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("expense.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("expense.deleteBody", { name: deleting?.seller_name ?? deleting?.vat_number ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{t("common.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
