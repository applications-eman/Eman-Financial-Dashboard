"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { adminSend } from "@/lib/admin-api";
import { useT } from "@/lib/i18n/provider";
import { getSupabase } from "@/lib/supabase/client";
import { type Category, SECTIONS, type Section } from "@/lib/types";

function SectionPanel({ section, rows, reload }: { section: Section; rows: Category[]; reload: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await adminSend("POST", "/admin/categories", { section, name, name_ar: nameAr || null, active: true });
      setName("");
      setNameAr("");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  }
  async function patch(c: Category, body: Partial<Category>) {
    try {
      await adminSend("PATCH", `/admin/categories/${c.id}`, body);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  }
  async function remove(c: Category) {
    try {
      await adminSend("DELETE", `/admin/categories/${c.id}`);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor={`c-name-${section}`} className="text-muted-foreground text-xs">
            {t("categories.name")}
          </label>
          <Input
            id={`c-name-${section}`}
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 w-56"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`c-ar-${section}`} className="text-muted-foreground text-xs">
            {t("categories.nameAr")}
          </label>
          <Input
            id={`c-ar-${section}`}
            dir="rtl"
            maxLength={60}
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
            className="h-8 w-56"
          />
        </div>
        <Button type="submit" size="sm">
          <Plus data-icon="inline-start" />
          {t("categories.add")}
        </Button>
      </form>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("categories.name")}</TableHead>
              <TableHead>{t("categories.nameAr")}</TableHead>
              <TableHead>{t("users.active")}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t("table.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  {t("common.noData")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Input
                      defaultValue={c.name}
                      className="h-8"
                      aria-label={t("categories.name")}
                      onBlur={(e) =>
                        e.target.value.trim() && e.target.value !== c.name && patch(c, { name: e.target.value.trim() })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      defaultValue={c.name_ar ?? ""}
                      dir="rtl"
                      className="h-8"
                      aria-label={t("categories.nameAr")}
                      onBlur={(e) =>
                        e.target.value !== (c.name_ar ?? "") && patch(c, { name_ar: e.target.value.trim() || null })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={c.active}
                      onCheckedChange={(v) => patch(c, { active: v })}
                      aria-label={`${t("users.active")}: ${c.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" aria-label={t("common.delete")} onClick={() => remove(c)}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function CategoriesView() {
  const t = useT();
  const [rows, setRows] = useState<Category[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await getSupabase().from("categories").select("*").order("name");
    if (err) setError(err.message);
    else {
      setError(null);
      setRows(data as Category[]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">{t("categories.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("categories.subtitle")}</p>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {rows === null ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <Tabs defaultValue="bakery" className="flex flex-col gap-4">
          <TabsList variant="line">
            {SECTIONS.map((s) => (
              <TabsTrigger key={s} value={s}>
                {t(`section.${s}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {SECTIONS.map((s) => (
            <TabsContent key={s} value={s}>
              <SectionPanel section={s} rows={rows.filter((c) => c.section === s)} reload={() => void load()} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
