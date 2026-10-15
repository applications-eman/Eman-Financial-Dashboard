"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { riyadhStartOfDay } from "@/lib/format";
import { getSupabase } from "@/lib/supabase/client";
import { type Expense, expenseTable, type Section } from "@/lib/types";

export interface ExpenseFilters {
  from: string; // yyyy-MM-dd (Riyadh)
  to: string;
  supplier: string;
  category: string;
  status: string;
  submitter: string;
  source: string;
  warningsOnly: boolean;
  duplicatesOnly: boolean;
}
export const EMPTY_FILTERS: ExpenseFilters = {
  from: "",
  to: "",
  supplier: "",
  category: "",
  status: "",
  submitter: "",
  source: "",
  warningsOnly: false,
  duplicatesOnly: false,
};
export const PAGE_SIZE = 25;

/** PostgREST filter values must not contain these structural characters. */
const clean = (s: string) => s.replace(/[%,()*\\]/g, " ").trim();

export function useExpensesQuery(section: Section, filters: ExpenseFilters, page: number) {
  const [rows, setRows] = useState<Expense[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    let q = getSupabase()
      .from(expenseTable(section))
      .select("*", { count: "exact" })
      .order("invoice_date", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (filters.from) q = q.gte("invoice_date", riyadhStartOfDay(filters.from));
    if (filters.to) q = q.lt("invoice_date", riyadhStartOfDay(filters.to, 1));
    if (filters.supplier) q = q.ilike("seller_name", `%${clean(filters.supplier)}%`);
    if (filters.category) q = q.eq("category", filters.category);
    if (filters.status) q = q.eq("status", filters.status);
    if (filters.submitter) q = q.eq("submitted_by", filters.submitter);
    if (filters.source) q = q.eq("source", filters.source);
    if (filters.warningsOnly) q = q.filter("warnings", "neq", "{}");
    if (filters.duplicatesOnly) q = q.gt("duplicate_count", 0);
    const { data, count: total, error: err } = await q;
    if (mine !== seq.current) return; // a newer request superseded this one
    if (err) setError(err.message);
    else {
      setError(null);
      setRows((data ?? []) as Expense[]);
      setCount(total ?? 0);
    }
    setLoading(false);
  }, [section, filters, page]);

  useEffect(() => {
    void load();
  }, [load]);

  return { rows, count, loading, error, reload: load, setRows };
}
