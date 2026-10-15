"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { adminSend } from "@/lib/admin-api";
import { fmtDateTime } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n/messages";
import { useT } from "@/lib/i18n/provider";
import { getSupabase } from "@/lib/supabase/client";
import type { Setting } from "@/lib/types";

import { ValueEditor } from "./value-editor";

type Json = Parameters<typeof ValueEditor>[0]["value"];

const KNOWN = new Set([
  "company_name",
  "company_name_en",
  "vat_rate",
  "currency",
  "timezone",
  "alert_thresholds",
  "report_schedule",
  "wa_flow_id",
  "wa_trigger_words",
  "message_templates",
  "wa_notify_template",
]);

function SettingCard({ setting, onSaved }: { setting: Setting; onSaved: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState<Json>(setting.value as Json);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(setting.value);

  async function save() {
    setBusy(true);
    try {
      await adminSend("PUT", `/admin/settings/${setting.key}`, { value: draft });
      toast.success(t("common.saved"));
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-medium font-mono text-sm" dir="ltr">
          {setting.key}
        </CardTitle>
        {KNOWN.has(setting.key) ? (
          <CardDescription>{t(`settings.desc.${setting.key}` as MessageKey)}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        <ValueEditor id={`s-${setting.key}`} label={setting.key.replace(/_/g, " ")} value={draft} onChange={setDraft} />
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {setting.updated_by ? `${setting.updated_by} · ` : ""}
          {fmtDateTime(setting.updated_at)}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty || busy} onClick={() => setDraft(setting.value as Json)}>
            {t("settings.reset")}
          </Button>
          <Button size="sm" disabled={!dirty || busy} onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function AddSetting({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [key, setKey] = useState("");
  const [text, setText] = useState('""');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await adminSend("PUT", `/admin/settings/${key.trim()}`, { value: JSON.parse(text) });
      onOpenChange(false);
      setKey("");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("settings.invalidJson"));
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("settings.add")}</DialogTitle>
            <DialogDescription>{t("settings.addHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="ns-key">{t("flags.key")}</Label>
            <Input
              id="ns-key"
              dir="ltr"
              required
              pattern="[a-z0-9_]{1,60}"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ns-val">{t("settings.jsonValue")}</Label>
            <Textarea
              id="ns-val"
              dir="ltr"
              rows={4}
              className="font-mono text-xs"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit">{t("common.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SettingsView() {
  const t = useT();
  const [rows, setRows] = useState<Setting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await getSupabase()
      .from("app_settings")
      .select("*")
      .neq("key", "report_state")
      .order("key");
    if (err) setError(err.message);
    else {
      setError(null);
      setRows(data as Setting[]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl tracking-tight">{t("settings.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("settings.subtitle")}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus data-icon="inline-start" />
          {t("settings.add")}
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {rows === null ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((s) => (
            <SettingCard key={`${s.key}-${s.updated_at}`} setting={s} onSaved={() => void load()} />
          ))}
        </div>
      )}
      <AddSetting open={adding} onOpenChange={setAdding} onSaved={() => void load()} />
    </div>
  );
}
