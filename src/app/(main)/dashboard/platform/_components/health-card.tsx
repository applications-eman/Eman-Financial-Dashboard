"use client";

import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { platform } from "@/lib/platform-api";

interface Health {
  ok: boolean;
  problems: string[];
  info: string[];
  counts: {
    queued: number;
    oldest_wait_minutes: number;
    failed_24h: number;
    rejected_24h: number;
    needs_attention: number;
  } | null;
}

export function HealthCard() {
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    platform<Health>("GET", "/health")
      .then(setH)
      .catch((e: Error) => setError(e.message));
  }
  useEffect(load, []);

  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  if (!h) return <p className="text-muted-foreground text-sm">Checking the system…</p>;

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-sm">{h.ok ? "Everything is working" : "Needs attention"}</p>
        <Button size="sm" variant="outline" onClick={load}>
          Check again
        </Button>
      </div>
      {h.problems.map((p) => (
        <Alert key={p} variant="destructive">
          <AlertTitle>Problem</AlertTitle>
          <AlertDescription>{p}</AlertDescription>
        </Alert>
      ))}
      {h.info.map((i) => (
        <p key={i} className="text-muted-foreground text-xs">
          {i}
        </p>
      ))}
      {h.counts ? (
        <p className="text-muted-foreground text-xs">
          Waiting: {h.counts.queued} · Oldest wait: {h.counts.oldest_wait_minutes} min · Not issued in the last 24
          hours: {h.counts.failed_24h} · Rejected by ZATCA in the last 24 hours: {h.counts.rejected_24h}
        </p>
      ) : null}
    </div>
  );
}
