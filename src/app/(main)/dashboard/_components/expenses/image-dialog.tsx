"use client";

import { useEffect, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { adminJson } from "@/lib/admin-api";
import { useT } from "@/lib/i18n/provider";
import type { Expense, Section } from "@/lib/types";

/** Images live in a PRIVATE bucket; the admin API hands out a 5-minute signed URL. */
export function ImageDialog({
  section,
  expense,
  onClose,
}: {
  section: Section;
  expense: Expense | null;
  onClose: () => void;
}) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!expense) return;
    let cancelled = false;
    adminJson<{ url: string }>(`/admin/expenses/${section}/${expense.id}/image`)
      .then((r) => !cancelled && setUrl(r.url))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [section, expense]);

  return (
    <Dialog open={expense !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("expense.image")}</DialogTitle>
          <DialogDescription>{expense?.seller_name ?? expense?.vat_number}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : url ? (
          // biome-ignore lint/performance/noImgElement: short-lived signed URL from a private bucket, not optimizable by next/image
          <img src={url} alt={t("expense.image")} className="max-h-[70vh] w-full rounded-md object-contain" />
        ) : (
          <Skeleton className="h-72 w-full" />
        )}
      </DialogContent>
    </Dialog>
  );
}
