"use client";

import { useState } from "react";

import { Check, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/lib/i18n/provider";

import type { Option } from "./simple-select";

/** Drop-down with a small search box, for long lists (salesmen, customers). Empty string = "all". */
export function SearchSelect({
  value,
  onChange,
  options,
  allLabel,
  label,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  allLabel: string;
  label: string;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // a selected value that is not in the current list (e.g. after changing the period) must still be shown, never "All"
  const current = options.find((o) => o.value === value)?.label ?? (value || undefined);
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-label={label}
          aria-expanded={open}
          className={`w-52 justify-between font-normal ${className ?? ""}`}
        >
          <span className="truncate">{current ?? allLabel}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={t("common.searchList")} />
          <CommandList>
            <CommandEmpty>{t("common.noResults")}</CommandEmpty>
            <CommandGroup>
              <CommandItem value={`__all__ ${allLabel}`} onSelect={() => pick("")}>
                <Check className={`size-4 ${value === "" ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />
                {allLabel}
              </CommandItem>
              {options.map((o) => (
                <CommandItem key={o.value} value={o.label} onSelect={() => pick(o.value)}>
                  <Check className={`size-4 ${value === o.value ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />
                  <span className="truncate">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
