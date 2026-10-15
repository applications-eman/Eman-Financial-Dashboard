"use client";

import { useState } from "react";

import { Check, Copy, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/provider";

/** The plaintext token exists only in this dialog; the server stores just its SHA-256 hash. */
export function TokenDialog({
  token,
  userName,
  onClose,
}: {
  token: string | null;
  userName: string;
  onClose: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={token !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("users.tokenTitle", { name: userName })}</DialogTitle>
          <DialogDescription>{t("users.tokenBody")}</DialogDescription>
        </DialogHeader>
        <Alert>
          <TriangleAlert />
          <AlertTitle>{t("users.tokenOnce")}</AlertTitle>
          <AlertDescription>{t("users.tokenOnceBody")}</AlertDescription>
        </Alert>
        <div className="flex items-center gap-2">
          <code
            dir="ltr"
            className="min-w-0 flex-1 select-all break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm"
          >
            {token}
          </code>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("common.copy")}
            onClick={async () => {
              if (token) await navigator.clipboard.writeText(token);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t("users.tokenDone")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
