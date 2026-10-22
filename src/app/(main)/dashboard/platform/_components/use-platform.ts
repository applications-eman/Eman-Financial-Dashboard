"use client";

import { useCallback, useEffect, useState } from "react";

import { toast } from "sonner";

import { platform } from "@/lib/platform-api";

/** Loads a list from the platform service and exposes reload + a guarded "do" for changes (toast on error). */
export function usePlatformList<T>(path: string) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await platform<T[]>("GET", path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { rows, error, load };
}

export async function change<T>(fn: () => Promise<T>, done?: string): Promise<T | undefined> {
  try {
    const out = await fn();
    if (done) toast.success(done);
    return out;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Something went wrong.");
    return undefined;
  }
}
