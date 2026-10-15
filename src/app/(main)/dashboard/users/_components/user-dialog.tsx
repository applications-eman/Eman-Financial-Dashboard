"use client";

import { type FormEvent, useEffect, useState } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { adminSend } from "@/lib/admin-api";
import { useT } from "@/lib/i18n/provider";
import { type AppUser, SECTIONS, type Section } from "@/lib/types";

import { SimpleSelect } from "../../_components/common/simple-select";

export function UserDialog({
  user,
  open,
  onOpenChange,
  onSaved,
}: {
  user: AppUser | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: "", phone: "", role: "staff", sections: [] as Section[], active: true, auth: "" });

  useEffect(() => {
    if (open)
      setF(
        user
          ? {
              name: user.name,
              phone: user.phone_e164 ?? "",
              role: user.role,
              sections: user.sections,
              active: user.active,
              auth: user.auth_user_id ?? "",
            }
          : { name: "", phone: "", role: "staff", sections: ["bakery"], active: true, auth: "" },
      );
  }, [open, user]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const body = {
      name: f.name,
      phone_e164: f.phone.trim() === "" ? null : f.phone.trim(),
      role: f.role,
      sections: f.sections,
      active: f.active,
      ...(f.role === "admin" && f.auth ? { auth_user_id: f.auth.trim() } : {}),
    };
    try {
      if (user) await adminSend("PATCH", `/admin/users/${user.id}`, body);
      else await adminSend("POST", "/admin/users", body);
      toast.success(t("common.saved"));
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{user ? t("users.edit") : t("users.add")}</DialogTitle>
            <DialogDescription>{t("users.dialogHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="u-name">{t("users.name")}</Label>
            <Input
              id="u-name"
              required
              maxLength={100}
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-phone">{t("users.phone")}</Label>
            <Input
              id="u-phone"
              dir="ltr"
              inputMode="tel"
              placeholder="+9665XXXXXXXX"
              value={f.phone}
              onChange={(e) => setF({ ...f, phone: e.target.value })}
            />
            <p className="text-muted-foreground text-xs">{t("users.phoneHelp")}</p>
          </div>
          <div className="space-y-1.5">
            <Label>{t("users.role")}</Label>
            <SimpleSelect
              size="default"
              className="w-full"
              label={t("users.role")}
              value={f.role}
              onChange={(v) => setF({ ...f, role: v })}
              options={[
                { value: "staff", label: t("role.staff") },
                { value: "admin", label: t("role.admin") },
              ]}
            />
          </div>
          {f.role === "admin" ? (
            <div className="space-y-1.5">
              <Label htmlFor="u-auth">{t("users.authId")}</Label>
              <Input
                id="u-auth"
                dir="ltr"
                placeholder="00000000-0000-0000-0000-000000000000"
                value={f.auth}
                onChange={(e) => setF({ ...f, auth: e.target.value })}
              />
              <p className="text-muted-foreground text-xs">{t("users.authHelp")}</p>
            </div>
          ) : null}
          <fieldset className="space-y-2">
            <legend className="font-medium text-sm">{t("users.sections")}</legend>
            <div className="flex gap-4">
              {SECTIONS.map((s) => (
                <div key={s} className="flex items-center gap-2">
                  <Checkbox
                    id={`u-s-${s}`}
                    checked={f.sections.includes(s)}
                    onCheckedChange={(c) =>
                      setF({ ...f, sections: c === true ? [...f.sections, s] : f.sections.filter((x) => x !== s) })
                    }
                  />
                  <Label htmlFor={`u-s-${s}`} className="font-normal">
                    {t(`section.${s}`)}
                  </Label>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="flex items-center gap-2">
            <Switch id="u-active" checked={f.active} onCheckedChange={(c) => setF({ ...f, active: c })} />
            <Label htmlFor="u-active" className="font-normal">
              {t("users.active")}
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
