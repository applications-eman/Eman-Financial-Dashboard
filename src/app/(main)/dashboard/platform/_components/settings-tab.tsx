"use client";

import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { platform } from "@/lib/platform-api";

import { OdooCard } from "./odoo-card";
import { change } from "./use-platform";

const NUMBER_FIELDS: { key: string; label: string; hint: string }[] = [
  {
    key: "duplicate_window_minutes",
    label: "Duplicate window (minutes)",
    hint: "Same salesman, customer and items inside this time is blocked.",
  },
  { key: "max_lines_per_invoice", label: "Maximum lines per invoice", hint: "" },
  { key: "queue_alert_length", label: "Queue length alert", hint: "Alert when more invoices than this are waiting." },
  {
    key: "queue_alert_wait_minutes",
    label: "Queue wait alert (minutes)",
    hint: "Alert when the oldest waiting invoice is older than this.",
  },
];

export function SettingsTab() {
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    platform<Record<string, unknown>>("GET", "/settings")
      .then(setValues)
      .catch((e: Error) => setError(e.message));
  }, []);

  async function save(key: string, value: unknown) {
    const r = await change(() => platform("PUT", `/settings/${key}`, { value }), "Saved");
    if (r) setValues((cur) => ({ ...cur, [key]: value }));
  }

  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  if (!values) return <p className="text-muted-foreground text-sm">Loading…</p>;

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <OdooCard />
      <div className="flex items-start justify-between gap-4 rounded-lg border border-destructive/40 p-3">
        <div className="space-y-1">
          <Label htmlFor="kill">Stop all new invoices (emergency switch)</Label>
          <p className="text-muted-foreground text-xs">When on, no new invoice is accepted from any salesman.</p>
        </div>
        <Switch id="kill" checked={values.kill_switch === true} onCheckedChange={(c) => save("kill_switch", c)} />
      </div>
      {NUMBER_FIELDS.map((f) => (
        <NumberSetting key={f.key} field={f} value={values[f.key]} onSave={(v) => save(f.key, v)} />
      ))}
    </div>
  );
}

function NumberSetting({
  field,
  value,
  onSave,
}: {
  field: (typeof NUMBER_FIELDS)[number];
  value: unknown;
  onSave: (v: number) => void;
}) {
  const [v, setV] = useState(value === undefined ? "" : String(value));
  const num = Number(v);
  const valid = v.trim() !== "" && Number.isInteger(num);
  return (
    <div className="space-y-1">
      <Label htmlFor={field.key}>{field.label}</Label>
      <div className="flex gap-2">
        <Input
          id={field.key}
          dir="ltr"
          inputMode="numeric"
          className="max-w-32"
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
        <Button variant="outline" disabled={!valid || String(value) === v} onClick={() => onSave(num)}>
          Save
        </Button>
      </div>
      {field.hint ? <p className="text-muted-foreground text-xs">{field.hint}</p> : null}
    </div>
  );
}
