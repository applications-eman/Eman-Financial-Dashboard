"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { addDays, riyadhDay, riyadhStartOfDay } from "@/lib/format";
import { getSupabase } from "@/lib/supabase/client";
import { type Expense, expenseTable, SECTIONS, type Section } from "@/lib/types";

export type LiveStatus = "connecting" | "live" | "error";
type Rows = Record<Section, Expense[]>;
const EMPTY: Rows = { bakery: [], grocery: [] };

interface Options {
  /** how many days back to load (dashboard needs current month + 14 day chart) */
  days?: number;
  /** called for every NEW invoice that arrives through Realtime */
  onInsert?: (section: Section, row: Expense) => void;
}

/**
 * Loads recent invoices straight from Supabase (admin session => RLS) and keeps them current through Realtime
 * postgres_changes on both expense tables. Re-loads on every (re)subscription so nothing is missed after a drop.
 */
export function useLiveExpenses({ days = 62, onInsert }: Options = {}) {
  const [rows, setRows] = useState<Rows>(EMPTY);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const onInsertRef = useRef(onInsert);
  onInsertRef.current = onInsert;

  const load = useCallback(async () => {
    const supabase = getSupabase();
    const since = riyadhStartOfDay(addDays(riyadhDay(new Date()), -days));
    try {
      const results = await Promise.all(
        SECTIONS.map((s) =>
          supabase
            .from(expenseTable(s))
            .select("*")
            // invoices dated in the window OR captured in the window (back-dated invoices still show as new activity)
            .or(`invoice_date.gte.${since},created_at.gte.${since}`)
            .order("invoice_date", { ascending: false })
            .limit(5000),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw new Error(failed.error.message);
      setRows({ bakery: (results[0].data ?? []) as Expense[], grocery: (results[1].data ?? []) as Expense[] });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    const supabase = getSupabase();
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const markFresh = (id: string) => {
      setFresh((prev) => new Set(prev).add(id));
      const t = setTimeout(() => {
        setFresh((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        timers.delete(t);
      }, 8000);
      timers.add(t);
    };

    const apply = (section: Section, type: string, next: Expense | null, prev: { id?: string } | null) => {
      setRows((cur) => {
        const list = cur[section];
        if (type === "DELETE") return { ...cur, [section]: list.filter((r) => r.id !== prev?.id) };
        if (!next) return cur;
        const exists = list.some((r) => r.id === next.id);
        const merged = exists ? list.map((r) => (r.id === next.id ? next : r)) : [next, ...list];
        return { ...cur, [section]: merged.sort((a, b) => (a.invoice_date < b.invoice_date ? 1 : -1)) };
      });
      if (type === "INSERT" && next) {
        markFresh(next.id);
        onInsertRef.current?.(section, next);
      }
    };

    let cleanup: () => void = () => undefined;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      if (cancelled) return;
      let channel = supabase.channel("expenses-live");
      for (const s of SECTIONS) {
        channel = channel.on("postgres_changes", { event: "*", schema: "public", table: expenseTable(s) }, (p) =>
          apply(s, p.eventType, (p.new as Expense) ?? null, (p.old as { id?: string }) ?? null),
        );
      }
      channel.subscribe((st) => {
        if (st === "SUBSCRIBED") {
          setStatus("live");
          void load();
        } else if (st === "CHANNEL_ERROR" || st === "TIMED_OUT" || st === "CLOSED") setStatus("error");
      });
      cleanup = () => void supabase.removeChannel(channel);
    })();

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      cleanup();
    };
  }, [load]);

  return { rows, status, error, loading, fresh, reload: load };
}
