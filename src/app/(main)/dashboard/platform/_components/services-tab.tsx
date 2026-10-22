"use client";

import { type FormEvent, useState } from "react";

import { Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { platform } from "@/lib/platform-api";

import { change, usePlatformList } from "./use-platform";

interface Target {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  is_default: boolean;
  has_secret: boolean;
  numbers: number;
}
interface NumberRow {
  phone: string;
  target_id: string;
  target_name: string;
  label: string | null;
  enabled: boolean;
  salesman_name: string | null;
}

export function ServicesTab() {
  const targets = usePlatformList<Target>("/targets");
  const numbers = usePlatformList<NumberRow>("/numbers");
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  const [t, setT] = useState({ id: "", name: "", url: "" });
  const [n, setN] = useState({ phone: "", target_id: "", label: "" });

  const reload = () => {
    void targets.load();
    void numbers.load();
  };

  async function addTarget(e: FormEvent) {
    e.preventDefault();
    const r = await change(() => platform<{ id: string; secret: string }>("POST", "/targets", t), "Service added");
    if (r) {
      setSecret({ id: r.id, value: r.secret });
      setT({ id: "", name: "", url: "" });
      reload();
    }
  }

  async function addNumber(e: FormEvent) {
    e.preventDefault();
    const r = await change(
      () => platform("POST", "/numbers", { phone: n.phone, target_id: n.target_id, label: n.label || undefined }),
      "Number added",
    );
    if (r) {
      setN({ phone: "", target_id: n.target_id, label: "" });
      reload();
    }
  }

  async function test(id: string) {
    const r = await change(() =>
      platform<{ reachable: boolean; status: number; ms: number }>("POST", `/targets/${id}/test`),
    );
    if (r) (r.reachable ? toast.success : toast.error)(r.reachable ? `Reachable (${r.ms} ms)` : "Not reachable");
  }

  return (
    <div className="flex flex-col gap-6">
      {secret ? (
        <Alert>
          <AlertDescription className="flex flex-col gap-1">
            <span>
              Secret for <b>{secret.id}</b> (shown once; the service must check it in the X-Router-Secret header):
            </span>
            <code className="select-all break-all rounded bg-muted px-2 py-1 text-xs">{secret.value}</code>
            <Button size="sm" variant="outline" className="w-fit" onClick={() => setSecret(null)}>
              I saved it
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {[targets.error, numbers.error].filter(Boolean).map((m) => (
        <Alert key={m} variant="destructive">
          <AlertDescription>{m}</AlertDescription>
        </Alert>
      ))}

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg">Services</h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Id</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Numbers</TableHead>
                <TableHead>On</TableHead>
                <TableHead>Default</TableHead>
                <TableHead className="text-end">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(targets.rows ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.id}</Badge>
                  </TableCell>
                  <TableCell className="max-w-72 truncate" dir="ltr">
                    {r.url}
                  </TableCell>
                  <TableCell className="tabular-nums">{r.numbers}</TableCell>
                  <TableCell>
                    <Switch
                      checked={r.enabled}
                      aria-label={`Service ${r.name} on`}
                      onCheckedChange={async (c) => {
                        await change(() => platform("PATCH", `/targets/${r.id}`, { enabled: c }));
                        reload();
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={r.is_default}
                      aria-label={`Service ${r.name} receives all other numbers`}
                      onCheckedChange={async (c) => {
                        await change(() => platform("PATCH", `/targets/${r.id}`, { is_default: c }));
                        reload();
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5">
                      <Button variant="ghost" size="sm" onClick={() => test(r.id)}>
                        <Zap data-icon="inline-start" />
                        Test
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          if (!confirm(`Create a new secret for "${r.name}"? The old one stops working.`)) return;
                          const x = await change(() =>
                            platform<{ secret: string }>("POST", `/targets/${r.id}/rotate-secret`),
                          );
                          if (x) setSecret({ id: r.id, value: x.secret });
                        }}
                      >
                        New secret
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${r.name}`}
                        onClick={async () => {
                          if (!confirm(`Delete service "${r.name}"?`)) return;
                          await change(() => platform("DELETE", `/targets/${r.id}`), "Deleted");
                          reload();
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {targets.rows?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-20 text-center text-muted-foreground">
                    No services yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <p className="text-muted-foreground text-xs">
          Default: receives every WhatsApp number that no other service has claimed. Set your existing expense capture
          as the default, so nobody is cut off when the router goes in front. Only one service can be the default.
        </p>
        <form onSubmit={addTarget} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
          <div className="space-y-1">
            <Label htmlFor="t-id">Id (e.g. invoicing)</Label>
            <Input id="t-id" value={t.id} onChange={(e) => setT({ ...t, id: e.target.value })} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="t-name">Name</Label>
            <Input id="t-name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="t-url">Address (https://…)</Label>
            <Input id="t-url" dir="ltr" value={t.url} onChange={(e) => setT({ ...t, url: e.target.value })} required />
          </div>
          <Button type="submit">
            <Plus data-icon="inline-start" />
            Add service
          </Button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg">Numbers</h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Label / salesman</TableHead>
                <TableHead>On</TableHead>
                <TableHead className="text-end">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(numbers.rows ?? []).map((r) => (
                <TableRow key={r.phone}>
                  <TableCell dir="ltr" className="text-start tabular-nums">
                    {r.phone}
                  </TableCell>
                  <TableCell>{r.target_name}</TableCell>
                  <TableCell>{r.salesman_name ?? r.label ?? "—"}</TableCell>
                  <TableCell>
                    <Switch
                      checked={r.enabled}
                      disabled={r.salesman_name !== null}
                      aria-label={`Number ${r.phone} on`}
                      onCheckedChange={async (c) => {
                        await change(() => platform("PATCH", `/numbers/${r.phone}`, { enabled: c }));
                        reload();
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${r.phone}`}
                        disabled={r.salesman_name !== null}
                        onClick={async () => {
                          if (!confirm(`Remove ${r.phone}?`)) return;
                          await change(() => platform("DELETE", `/numbers/${r.phone}`), "Removed");
                          reload();
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {numbers.rows?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                    No numbers yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <form onSubmit={addNumber} className="grid items-end gap-2 sm:grid-cols-[1.5fr_1fr_1fr_auto]">
          <div className="space-y-1">
            <Label htmlFor="n-phone">Number with country code</Label>
            <Input
              id="n-phone"
              dir="ltr"
              value={n.phone}
              onChange={(e) => setN({ ...n, phone: e.target.value })}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="n-target">Service id</Label>
            <Input
              id="n-target"
              value={n.target_id}
              onChange={(e) => setN({ ...n, target_id: e.target.value })}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="n-label">Label (optional)</Label>
            <Input id="n-label" value={n.label} onChange={(e) => setN({ ...n, label: e.target.value })} />
          </div>
          <Button type="submit">
            <Plus data-icon="inline-start" />
            Add number
          </Button>
        </form>
        <p className="text-muted-foreground text-xs">
          A number belongs to one service only. Salesman numbers are managed from the Salesmen tab.
        </p>
      </section>
    </div>
  );
}
