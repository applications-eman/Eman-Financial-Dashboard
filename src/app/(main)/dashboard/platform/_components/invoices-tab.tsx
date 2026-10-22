"use client";

import { useState } from "react";

import { RotateCcw } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { platform } from "@/lib/platform-api";

import { SimpleSelect } from "../../_components/common/simple-select";
import { change, usePlatformList } from "./use-platform";

interface Request {
  id: string;
  ref_code: string;
  salesman: string;
  customer: string;
  total: string;
  status: string;
  invoice_number: string | null;
  zatca_status: string | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
}
interface Approval {
  id: string;
  reason: string;
  decision: string | null;
  ref_code: string;
  total: string;
  salesman: string;
  customer: string;
}

const STATUSES = ["queued", "processing", "awaiting_approval", "cleared", "rejected", "failed", "cancelled"];
const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  cleared: "default",
  queued: "secondary",
  processing: "secondary",
  awaiting_approval: "outline",
  rejected: "destructive",
  failed: "destructive",
  cancelled: "outline",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "short", timeStyle: "short" });

export function InvoicesTab() {
  const [status, setStatus] = useState("");
  const requests = usePlatformList<Request>(`/requests?limit=200${status ? `&status=${status}` : ""}`);
  const approvals = usePlatformList<Approval>("/approvals");
  const pending = (approvals.rows ?? []).filter((a) => a.decision === null);

  async function decide(a: Approval, decision: "approved" | "rejected") {
    const r = await change(
      () => platform("POST", `/approvals/${a.id}/decide`, { decision }),
      decision === "approved" ? "Approved" : "Rejected",
    );
    if (r) {
      void approvals.load();
      void requests.load();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {[requests.error, approvals.error].filter(Boolean).map((m) => (
        <Alert key={m} variant="destructive">
          <AlertDescription>{m}</AlertDescription>
        </Alert>
      ))}

      {pending.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-lg border border-amber-500/50 p-3">
          <h2 className="font-medium">Waiting for your approval ({pending.length})</h2>
          {pending.map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 first:border-0 first:pt-0"
            >
              <div className="text-sm">
                <b>{a.salesman}</b> for {a.customer}, total {a.total}
                <div className="text-muted-foreground text-xs">{a.reason}</div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" onClick={() => decide(a, "approved")}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => decide(a, "rejected")}>
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <div className="flex items-center gap-2">
        <SimpleSelect
          value={status}
          onChange={setStatus}
          allLabel="All statuses"
          label="Status"
          options={STATUSES.map((s) => ({ value: s, label: s.replace("_", " ") }))}
        />
        <Button variant="outline" size="sm" onClick={() => void requests.load()}>
          Refresh
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Salesman</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="text-end">Total</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(requests.rows ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap tabular-nums">{when(r.created_at)}</TableCell>
                <TableCell className="font-mono text-xs">{r.ref_code}</TableCell>
                <TableCell>{r.salesman}</TableCell>
                <TableCell>{r.customer}</TableCell>
                <TableCell className="text-end tabular-nums">{r.total}</TableCell>
                <TableCell>
                  <Badge variant={VARIANT[r.status] ?? "outline"}>{r.status.replace("_", " ")}</Badge>
                  {r.error_detail ? (
                    <div className="max-w-64 truncate text-muted-foreground text-xs" title={r.error_detail}>
                      {r.error_code}: {r.error_detail}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="tabular-nums" dir="ltr">
                  {r.invoice_number ?? "—"}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    {r.status === "failed" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          if (
                            !confirm("Try this request again? Odoo is checked first, so no second invoice is created.")
                          )
                            return;
                          await change(() => platform("POST", `/requests/${r.id}/retry`), "Queued again");
                          void requests.load();
                        }}
                      >
                        <RotateCcw data-icon="inline-start" />
                        Retry
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {requests.rows?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-20 text-center text-muted-foreground">
                  No invoice requests yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
