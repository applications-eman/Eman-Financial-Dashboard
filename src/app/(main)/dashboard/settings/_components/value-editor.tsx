"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n/provider";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const humanize = (k: string) => k.replace(/_/g, " ");
const isPlainArray = (v: Json[]) => v.every((x) => typeof x === "string" || typeof x === "number");

function JsonArea({ id, value, onChange }: { id: string; value: Json; onChange: (v: Json) => void }) {
  const t = useT();
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <div className="space-y-1">
      <Textarea
        id={id}
        dir="ltr"
        rows={5}
        className="font-mono text-xs"
        value={text}
        aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad ? (
        <p role="alert" className="text-destructive text-xs">
          {t("settings.invalidJson")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Renders ANY JSON setting as a form: strings, numbers, booleans, string lists and nested objects get proper
 * controls; anything else falls back to validated JSON. New settings therefore need no frontend change.
 */
export function ValueEditor({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: Json;
  onChange: (v: Json) => void;
}) {
  if (typeof value === "boolean") {
    return (
      <div className="flex items-center justify-between gap-4 py-1">
        <Label htmlFor={id} className="font-normal capitalize">
          {label}
        </Label>
        <Switch id={id} checked={value} onCheckedChange={onChange} />
      </div>
    );
  }
  if (typeof value === "number") {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id} className="font-normal capitalize">
          {label}
        </Label>
        <Input
          id={id}
          type="number"
          step="any"
          dir="ltr"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))}
        />
      </div>
    );
  }
  if (typeof value === "string") {
    const long = value.length > 60 || value.includes("\n");
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id} className="font-normal capitalize">
          {label}
        </Label>
        {long ? (
          <Textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
    );
  }
  if (Array.isArray(value) && isPlainArray(value)) {
    const numeric = value.length > 0 && value.every((x) => typeof x === "number");
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id} className="font-normal capitalize">
          {label}
        </Label>
        <Input
          id={id}
          defaultValue={value.join(", ")}
          onBlur={(e) => {
            const parts = e.target.value
              .split(/[,،]/)
              .map((s) => s.trim())
              .filter(Boolean);
            onChange(numeric ? parts.map(Number).filter(Number.isFinite) : parts);
          }}
        />
      </div>
    );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (
      <fieldset className="space-y-3 rounded-lg border p-3">
        <legend className="px-1 text-muted-foreground text-xs capitalize">{label}</legend>
        {Object.entries(value).map(([k, v]) => (
          <ValueEditor
            key={k}
            id={`${id}-${k}`}
            label={humanize(k)}
            value={v}
            onChange={(nv) => onChange({ ...value, [k]: nv })}
          />
        ))}
      </fieldset>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="font-normal capitalize">
        {label}
      </Label>
      <JsonArea id={id} value={value} onChange={onChange} />
    </div>
  );
}
