"use client";

import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import { Plus, Users } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { platform } from "@/lib/platform-api";

import { change, usePlatformList } from "./use-platform";

interface Salesman {
  id: string;
  code: string;
  name: string;
  phone: string;
  status: "inactive" | "active" | "frozen";
  daily_limit: number | null;
  customers: number;
}
interface Customer {
  id: string;
  name: string;
  vat: string | null;
  status: string;
}

const STATUS_VARIANT = { active: "default", inactive: "outline", frozen: "destructive" } as const;

export function SalesmenTab() {
  const { rows, error, load } = usePlatformList<Salesman>("/salesmen");
  const [f, setF] = useState({ code: "", name: "", phone: "" });
  const [assign, setAssign] = useState<Salesman | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    const r = await change(
      () => platform("POST", "/salesmen", { code: f.code.trim().toUpperCase(), name: f.name, phone: f.phone }),
      "Salesman added (inactive until you activate him)",
    );
    if (r) {
      setF({ code: "", name: "", phone: "" });
      void load();
    }
  }

  async function act(s: Salesman, action: "activate" | "freeze") {
    if (action === "freeze" && !confirm(`Freeze ${s.name}? He stops receiving invoicing messages immediately.`)) return;
    const r = await change(() => platform<{ warnings: string[] }>("POST", `/salesmen/${s.id}/${action}`));
    if (r) {
      toast.success(action === "activate" ? `${s.name} is active` : `${s.name} is frozen`);
      for (const w of r.warnings) toast.warning(w);
      void load();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>WhatsApp number</TableHead>
              <TableHead>Customers</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows ?? []).map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">{s.code}</TableCell>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell dir="ltr" className="text-start tabular-nums">
                  {s.phone}
                </TableCell>
                <TableCell className="tabular-nums">{s.customers}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[s.status]}>{s.status}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-0.5">
                    <Button variant="ghost" size="sm" onClick={() => setAssign(s)}>
                      <Users data-icon="inline-start" />
                      Customers
                    </Button>
                    {s.status === "active" ? (
                      <Button variant="ghost" size="sm" onClick={() => act(s, "freeze")}>
                        Freeze
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => act(s, "activate")}>
                        {s.status === "frozen" ? "Unfreeze" : "Activate"}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {rows?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                  No salesmen yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <form onSubmit={add} className="grid items-end gap-2 sm:grid-cols-[1fr_1.5fr_1.5fr_auto]">
        <div className="space-y-1">
          <Label htmlFor="s-code">Code (e.g. FAIZAL-1)</Label>
          <Input id="s-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="s-name">Name</Label>
          <Input id="s-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="s-phone">WhatsApp number with country code</Label>
          <Input
            id="s-phone"
            dir="ltr"
            value={f.phone}
            onChange={(e) => setF({ ...f, phone: e.target.value })}
            required
          />
        </div>
        <Button type="submit">
          <Plus data-icon="inline-start" />
          Add salesman
        </Button>
      </form>
      <p className="text-muted-foreground text-xs">
        Needs the service with id &quot;invoicing&quot; (Services &amp; numbers). A new salesman is inactive until
        activated.
      </p>

      <AssignDialog salesman={assign} onClose={() => setAssign(null)} onSaved={() => void load()} />
    </div>
  );
}

function AssignDialog({
  salesman,
  onClose,
  onSaved,
}: {
  salesman: Salesman | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [all, setAll] = useState<Customer[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!salesman) return;
    setAll(null);
    setQ("");
    void (async () => {
      const [every, mine] = await Promise.all([
        change(() => platform<Customer[]>("GET", "/customers?status=active&limit=500")),
        change(() => platform<Customer[]>("GET", `/salesmen/${salesman.id}/customers`)),
      ]);
      setAll(every ?? []);
      setPicked(new Set((mine ?? []).map((c) => c.id)));
    })();
  }, [salesman]);

  const shown = (all ?? []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));

  function toggle(id: string, on: boolean) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  let listBody: ReactNode;
  if (all === null) listBody = <p className="p-3 text-muted-foreground text-sm">Loading…</p>;
  else if (shown.length === 0)
    listBody = (
      <p className="p-3 text-muted-foreground text-sm">No customers found. Add them in the Customers tab first.</p>
    );
  else
    listBody = shown.map((c) => (
      <Label key={c.id} className="flex items-center gap-2 border-b px-3 py-2 last:border-0">
        <Checkbox checked={picked.has(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} />
        {c.name}
      </Label>
    ));

  async function save() {
    if (!salesman) return;
    setBusy(true);
    const r = await change(
      () => platform("PUT", `/salesmen/${salesman.id}/customers`, { customer_ids: [...picked] }),
      "Saved",
    );
    setBusy(false);
    if (r) {
      onSaved();
      onClose();
    }
  }

  return (
    <Dialog open={salesman !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Customers of {salesman?.name}</DialogTitle>
          <DialogDescription>Only these customers appear in his WhatsApp invoice form.</DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Search customers"
          aria-label="Search customers"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="max-h-80 overflow-y-auto rounded-md border">{listBody}</div>
        <DialogFooter>
          <span className="me-auto self-center text-muted-foreground text-sm">{picked.size} selected</span>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || all === null}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
