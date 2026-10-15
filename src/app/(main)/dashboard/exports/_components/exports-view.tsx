"use client";

import { useState } from "react";

import { Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { downloadExport } from "@/lib/download";
import { useT } from "@/lib/i18n/provider";
import { SECTIONS, STATUSES } from "@/lib/types";

import { SimpleSelect } from "../../_components/common/simple-select";

export function ExportsView() {
  const t = useT();
  const [f, setF] = useState({ section: "", from: "", to: "", status: "", format: "csv", mark: false });
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await downloadExport({
        section: f.section || undefined,
        format: f.format as "csv" | "xls",
        from: f.from,
        to: f.to,
        status: f.status,
        mark_exported: f.mark,
      });
      toast.success(t("exports.done"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">{t("exports.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("exports.subtitle")}</p>
      </div>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="font-normal">{t("exports.card")}</CardTitle>
          <CardDescription>{t("exports.cardHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("exports.section")}</Label>
              <SimpleSelect
                size="default"
                className="w-full"
                label={t("exports.section")}
                allLabel={t("exports.bothSections")}
                value={f.section}
                onChange={(v) => setF({ ...f, section: v })}
                options={SECTIONS.map((s) => ({ value: s, label: t(`section.${s}`) }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("table.status")}</Label>
              <SimpleSelect
                size="default"
                className="w-full"
                label={t("table.status")}
                allLabel={t("filters.allStatuses")}
                value={f.status}
                onChange={(v) => setF({ ...f, status: v })}
                options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="x-from">{t("exports.from")}</Label>
              <Input id="x-from" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="x-to">{t("exports.to")}</Label>
              <Input id="x-to" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("exports.format")}</Label>
              <SimpleSelect
                size="default"
                className="w-full"
                label={t("exports.format")}
                value={f.format}
                onChange={(v) => setF({ ...f, format: v })}
                options={[
                  { value: "csv", label: "CSV (UTF-8)" },
                  { value: "xls", label: "Excel (.xls)" },
                ]}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="x-mark" checked={f.mark} onCheckedChange={(c) => setF({ ...f, mark: c === true })} />
            <Label htmlFor="x-mark" className="font-normal">
              {t("exports.markExported")}
            </Label>
          </div>
          <Button onClick={run} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : <Download data-icon="inline-start" />}
            {t("exports.download")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
