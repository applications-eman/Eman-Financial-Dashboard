"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { adminSend } from "@/lib/admin-api";
import { useT } from "@/lib/i18n/provider";
import { getSupabase } from "@/lib/supabase/client";
import type { Flag } from "@/lib/types";

export function FlagsView() {
  const t = useT();
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [desc, setDesc] = useState("");

  const load = useCallback(async () => {
    const { data, error: err } = await getSupabase().from("feature_flags").select("*").order("key");
    if (err) setError(err.message);
    else setFlags(data as Flag[]);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(f: Flag, enabled: boolean) {
    setFlags((cur) => cur?.map((x) => (x.key === f.key ? { ...x, enabled } : x)) ?? null);
    try {
      await adminSend("PUT", `/admin/flags/${f.key}`, { enabled, description: f.description ?? undefined });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
      void load();
    }
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await adminSend("PUT", `/admin/flags/${key.trim()}`, { enabled: false, description: desc || undefined });
      setKey("");
      setDesc("");
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">{t("flags.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("flags.subtitle")}</p>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent className="divide-y">
          {flags === null ? (
            <Skeleton className="h-32 w-full" />
          ) : flags.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">{t("common.noData")}</p>
          ) : (
            flags.map((f) => (
              <div key={f.key} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <label htmlFor={`flag-${f.key}`} className="font-medium font-mono text-sm" dir="ltr">
                    {f.key}
                  </label>
                  {f.description ? <p className="text-muted-foreground text-sm">{f.description}</p> : null}
                </div>
                <Switch id={`flag-${f.key}`} checked={f.enabled} onCheckedChange={(c) => toggle(f, c)} />
              </div>
            ))
          )}
        </CardContent>
      </Card>
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor="flag-new-key" className="text-muted-foreground text-xs">
            {t("flags.key")}
          </label>
          <Input
            id="flag-new-key"
            dir="ltr"
            required
            pattern="[a-z0-9_]{1,60}"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="h-8 w-56"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="flag-new-desc" className="text-muted-foreground text-xs">
            {t("flags.description")}
          </label>
          <Input id="flag-new-desc" value={desc} onChange={(e) => setDesc(e.target.value)} className="h-8 w-72" />
        </div>
        <Button type="submit" size="sm">
          <Plus data-icon="inline-start" />
          {t("flags.add")}
        </Button>
      </form>
    </div>
  );
}
