"use client";

import { useCallback, useEffect, useState } from "react";

import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { adminJson, adminSend } from "@/lib/admin-api";
import { fmtDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";

export interface SyncStatus {
  configured: boolean;
  enabled: boolean;
  last_success: { at: string; caught_up: boolean } | null;
  runs: { id: number; started_at: string; error: string | null; fetched: number }[];
  db_bytes: number | null;
}

/** "Last synced" indicator + manual "Sync now" (admin API). Calls onSynced after a manual run. */
export function SyncStatusBar({ onSynced }: { onSynced?: () => void }) {
  const t = useT();
  const [s, setS] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setS(await adminJson<SyncStatus>("/admin/sync/status"));
    } catch {
      setS(null);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  async function syncNow() {
    setBusy(true);
    try {
      await adminSend("POST", "/admin/sync/run");
      toast.success(t("sync.done"));
      await load();
      onSynced?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const lastError = s?.runs[0]?.error;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {s === null ? null : !s.configured ? (
        <Badge variant="outline">{t("sync.notConfigured")}</Badge>
      ) : !s.enabled ? (
        <Badge variant="outline">{t("sync.off")}</Badge>
      ) : (
        <span className="text-muted-foreground">
          {t("sync.last")}: {s.last_success ? fmtDateTime(s.last_success.at) : t("sync.never")}
          {s.last_success && !s.last_success.caught_up ? ` · ${t("sync.catchingUp")}` : ""}
        </span>
      )}
      {lastError ? <Badge variant="destructive">{t("sync.failed")}</Badge> : null}
      {s?.db_bytes ? (
        <span className="text-muted-foreground text-xs" title={t("sync.dbSizeHelp")}>
          {t("sync.dbSize", {
            mb: Math.round(s.db_bytes / 1_048_576),
            pct: Math.round((s.db_bytes / 524_288_000) * 100),
          })}
        </span>
      ) : null}
      <Button size="sm" variant="outline" onClick={syncNow} disabled={busy || !s?.configured}>
        {busy ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
        {t("sync.now")}
      </Button>
    </div>
  );
}
