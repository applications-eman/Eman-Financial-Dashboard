"use client";

import { type FormEvent, useState } from "react";

import { useRouter } from "next/navigation";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/lib/i18n/provider";
import { getSupabase } from "@/lib/supabase/client";

export function LoginForm({ next, callbackError }: { next?: string; callbackError?: boolean }) {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "magic" | null>(null);
  const [error, setError] = useState<string | null>(callbackError ? t("auth.callbackError") : null);
  const safeNext = next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    setBusy("password");
    setError(null);
    const { error: err } = await getSupabase().auth.signInWithPassword({ email, password });
    setBusy(null);
    if (err) return setError(t("auth.invalid"));
    router.replace(safeNext);
    router.refresh();
  }

  async function onMagicLink() {
    if (!email) return setError(t("auth.emailRequired"));
    setBusy("magic");
    setError(null);
    const { error: err } = await getSupabase().auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false, // only pre-created admins can sign in
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext)}`,
      },
    });
    setBusy(null);
    if (err) return setError(t("auth.magicFailed"));
    toast.success(t("auth.magicSent"));
  }

  return (
    <form onSubmit={onPassword} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">{t("auth.email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          dir="ltr"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t("auth.password")}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          dir="ltr"
        />
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={busy !== null}>
        {busy === "password" ? <Spinner data-icon="inline-start" /> : null}
        {t("auth.signIn")}
      </Button>
      <Button type="button" variant="outline" className="w-full" disabled={busy !== null} onClick={onMagicLink}>
        {busy === "magic" ? <Spinner data-icon="inline-start" /> : null}
        {t("auth.magicLink")}
      </Button>
    </form>
  );
}
