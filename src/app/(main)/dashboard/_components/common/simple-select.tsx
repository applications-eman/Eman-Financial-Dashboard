"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface Option {
  value: string;
  label: string;
}

const ALL = "__all__";

/** Radix Select that supports an "all / none" entry (Radix forbids empty-string item values). RTL-safe. */
export function SimpleSelect({
  value,
  onChange,
  options,
  allLabel,
  label,
  className,
  size = "sm",
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  /** when set, adds a leading entry that maps to the empty string */
  allLabel?: string;
  label: string;
  className?: string;
  size?: "sm" | "default";
  disabled?: boolean;
}) {
  return (
    <Select value={value === "" ? ALL : value} onValueChange={(v) => onChange(v === ALL ? "" : v)} disabled={disabled}>
      <SelectTrigger size={size} className={className} aria-label={label}>
        <SelectValue placeholder={allLabel ?? label} />
      </SelectTrigger>
      <SelectContent>
        {allLabel !== undefined ? <SelectItem value={ALL}>{allLabel}</SelectItem> : null}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
