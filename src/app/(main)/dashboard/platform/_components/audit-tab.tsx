"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { usePlatformList } from "./use-platform";

interface Entry {
  id: number;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string | null;
  after: unknown;
}

export function AuditTab() {
  const { rows, error } = usePlatformList<Entry>("/audit?limit=200");
  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {new Date(r.at).toLocaleString("en-GB", { timeZone: "Asia/Riyadh" })}
                </TableCell>
                <TableCell>{r.actor}</TableCell>
                <TableCell>
                  {r.action} {r.entity}
                </TableCell>
                <TableCell className="max-w-96 truncate font-mono text-xs" dir="ltr">
                  {r.after ? JSON.stringify(r.after) : (r.entity_id ?? "")}
                </TableCell>
              </TableRow>
            ))}
            {rows?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                  Nothing yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
