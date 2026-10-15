"use client";

import { useCallback, useEffect, useState } from "react";

import { KeyRound, Pencil, Plus, Trash2, UserX } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminJson, adminSend } from "@/lib/admin-api";
import { fmtDate } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import type { AppUser } from "@/lib/types";

import { TokenDialog } from "./token-dialog";
import { UserDialog } from "./user-dialog";

type Confirm = { kind: "delete" | "rotate" | "generate" | "revoke"; user: AppUser } | null;

export function UsersView() {
  const t = useT();
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AppUser | null | undefined>(undefined);
  const [token, setToken] = useState<{ value: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await adminJson<{ rows: AppUser[] }>("/admin/users")).rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.error"));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive(u: AppUser, active: boolean) {
    setUsers((cur) => cur?.map((x) => (x.id === u.id ? { ...x, active } : x)) ?? null);
    try {
      await adminSend("PATCH", `/admin/users/${u.id}`, { active });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
      void load();
    }
  }

  async function run() {
    if (!confirm) return;
    const { kind, user } = confirm;
    setConfirm(null);
    try {
      if (kind === "delete") {
        await adminSend("DELETE", `/admin/users/${user.id}`);
        toast.success(t("common.deleted"));
      } else if (kind === "revoke") {
        await adminSend("DELETE", `/admin/users/${user.id}/token`);
        toast.success(t("users.tokenRevoked"));
      } else {
        const r = await adminSend<{ token: string }>("POST", `/admin/users/${user.id}/token`);
        setToken({ value: r.token, name: user.name });
      }
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    }
  }

  const generate = (u: AppUser) => setConfirm({ kind: u.has_token ? "rotate" : "generate", user: u });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl tracking-tight">{t("users.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("users.subtitle")}</p>
        </div>
        <Button size="sm" onClick={() => setEditing(null)}>
          <Plus data-icon="inline-start" />
          {t("users.add")}
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("users.name")}</TableHead>
              <TableHead>{t("users.phone")}</TableHead>
              <TableHead>{t("users.role")}</TableHead>
              <TableHead>{t("users.sections")}</TableHead>
              <TableHead>{t("users.token")}</TableHead>
              <TableHead>{t("users.active")}</TableHead>
              <TableHead>{t("users.created")}</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">{t("table.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users === null ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  {t("common.noData")}
                </TableCell>
              </TableRow>
            ) : (
              users.map((u) => (
                <TableRow key={u.id} className={u.active ? undefined : "opacity-60"}>
                  <TableCell className="font-medium">{u.name}</TableCell>
                  <TableCell dir="ltr" className="text-start tabular-nums">
                    {u.phone_e164 ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.role === "admin" ? "default" : "secondary"}>{t(`role.${u.role}`)}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {u.sections.length
                        ? u.sections.map((s) => (
                            <Badge key={s} variant="outline">
                              {t(`section.${s}`)}
                            </Badge>
                          ))
                        : "—"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.has_token ? "secondary" : "outline"}>
                      {u.has_token ? t("users.tokenSet") : t("users.noToken")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={u.active}
                      onCheckedChange={(c) => toggleActive(u, c)}
                      aria-label={`${t("users.active")}: ${u.name}`}
                    />
                  </TableCell>
                  <TableCell className="tabular-nums">{fmtDate(u.created_at)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5">
                      <Button variant="ghost" size="sm" onClick={() => generate(u)}>
                        <KeyRound data-icon="inline-start" />
                        {u.has_token ? t("users.rotate") : t("users.generate")}
                      </Button>
                      {u.has_token ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("users.revoke")}
                          onClick={() => setConfirm({ kind: "revoke", user: u })}
                        >
                          <UserX />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("common.edit")}
                        onClick={() => setEditing(u)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("common.delete")}
                        onClick={() => setConfirm({ kind: "delete", user: u })}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <UserDialog
        user={editing ?? null}
        open={editing !== undefined}
        onOpenChange={(o) => !o && setEditing(undefined)}
        onSaved={() => void load()}
      />
      <TokenDialog token={token?.value ?? null} userName={token?.name ?? ""} onClose={() => setToken(null)} />
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm ? t(`users.confirm.${confirm.kind}.title`) : ""}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm ? t(`users.confirm.${confirm.kind}.body`, { name: confirm.user.name }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={run}>{t("common.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
