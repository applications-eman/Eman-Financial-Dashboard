"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminSend } from "@/lib/admin-api";
import { fmtDate, fmtMoney } from "@/lib/format";
import { useT } from "@/lib/i18n/provider";
import { currentQuarter, num, quarterRange } from "@/lib/revenue";
import { getSupabase } from "@/lib/supabase/client";

import { SimpleSelect } from "../../_components/common/simple-select";
import { VerifyDialog } from "../../revenue/_components/verify-dialog";

interface Sales {
  net: number;
  vat: number;
  credit_net: number;
  credit_vat: number;
  invoices: number;
  credit_notes?: number;
  days_entered?: number;
}
interface Purch {
  counted_net: number;
  counted_vat: number;
  counted_invoices: number;
  excluded_total: number;
  excluded_vat: number;
  excluded_invoices: number;
}
interface VatReturn {
  year: number;
  quarter: number;
  from: string;
  to: string;
  bakery_sales: Sales;
  grocery_sales: Sales;
  purchases: { bakery: Purch; grocery: Purch };
  paid: number;
}
interface Payment {
  id: string;
  period_year: number;
  period_quarter: number;
  amount_paid: number;
  paid_on: string | null;
  reference: string | null;
  notes: string | null;
}

const FIRST = { year: 2025, quarter: 4 };
type Scope = "bakery" | "grocery" | "all";

function figures(r: VatReturn, scope: Scope) {
  const parts = scope === "all" ? (["bakery", "grocery"] as const) : ([scope] as const);
  let out = 0;
  let input = 0;
  let net = 0;
  let exNet = 0;
  let exVat = 0;
  let exN = 0;
  let cn = 0;
  let cnVat = 0;
  for (const p of parts) {
    const s = r[`${p}_sales`];
    out += num(s.vat) - num(s.credit_vat);
    net += num(s.net) - num(s.credit_net);
    cn += num(s.credit_net);
    cnVat += num(s.credit_vat);
    const pu = r.purchases[p];
    input += num(pu.counted_vat);
    exNet += num(pu.excluded_total);
    exVat += num(pu.excluded_vat);
    exN += num(pu.excluded_invoices);
  }
  return { out, input, payable: out - input, net, exNet, exVat, exN, cn, cnVat };
}

function allQuarters(): { year: number; quarter: number }[] {
  const now = currentQuarter();
  const list: { year: number; quarter: number }[] = [];
  for (let y = FIRST.year; y <= now.year; y++)
    for (let q = 1; q <= 4; q++) {
      if (y === FIRST.year && q < FIRST.quarter) continue;
      if (y === now.year && q > now.quarter) continue;
      list.push({ year: y, quarter: q });
    }
  return list.reverse();
}

export function VatView() {
  const t = useT();
  const now = currentQuarter();
  const quarters = useMemo(allQuarters, []);
  const [sel, setSel] = useState(`${now.year}-${now.quarter}`);
  const [scope, setScope] = useState<Scope>("all");
  const [data, setData] = useState<VatReturn | null>(null);
  const [past, setPast] = useState<VatReturn[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ amount: "", paid_on: "", reference: "", notes: "" });

  const [year, quarter] = sel.split("-").map(Number);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const sb = getSupabase();
    const mine = ++seq.current;
    setError(null);
    let one = await sb.rpc("vat_return", { p_year: year, p_quarter: quarter });
    if (one.error && /timeout/i.test(one.error.message)) {
      await new Promise((r) => setTimeout(r, 1200));
      one = await sb.rpc("vat_return", { p_year: year, p_quarter: quarter });
    }
    if (mine !== seq.current) return;
    if (one.error) setError(one.error.message);
    else setData(one.data as VatReturn);
    const all = await Promise.all(quarters.map((q) => sb.rpc("vat_return", { p_year: q.year, p_quarter: q.quarter })));
    if (mine !== seq.current) return;
    setPast(all.filter((r) => !r.error).map((r) => r.data as VatReturn));
    const pay = await sb
      .from("vat_payments")
      .select("*")
      .order("period_year", { ascending: false })
      .order("period_quarter", { ascending: false });
    setPayments((pay.data as Payment[]) ?? []);
  }, [year, quarter, quarters]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  async function addPayment() {
    try {
      await adminSend("POST", "/admin/vat/payments", {
        period_year: year,
        period_quarter: quarter,
        amount_paid: Number(form.amount),
        paid_on: form.paid_on || null,
        reference: form.reference || null,
        notes: form.notes || null,
      });
      setForm({ amount: "", paid_on: "", reference: "", notes: "" });
      toast.success(t("common.saved"));
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    }
  }
  async function removePayment(id: string) {
    try {
      await adminSend("DELETE", `/admin/vat/payments/${id}`);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.error"));
    }
  }

  const f = data ? figures(data, scope) : null;
  const range = quarterRange(year, quarter);
  const line = (label: string, value: number, strong = false) => (
    <div className={`flex items-center justify-between gap-4 py-2 ${strong ? "font-semibold" : ""}`}>
      <span>{label}</span>
      <span className="tabular-nums">
        {fmtMoney(value)} {t("common.sar")}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl tracking-tight">{t("vat.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("vat.subtitle")}</p>
        </div>
        <VerifyDialog initialFrom={range.from} initialTo={range.to} />
      </div>
      <Alert>
        <AlertDescription>{t("vat.disclaimer")}</AlertDescription>
      </Alert>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label>{t("vat.quarter")}</Label>
          <SimpleSelect
            size="default"
            label={t("vat.quarter")}
            value={sel}
            onChange={setSel}
            options={quarters.map((q) => ({ value: `${q.year}-${q.quarter}`, label: `${q.year} Q${q.quarter}` }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("users.sections")}</Label>
          <SimpleSelect
            size="default"
            label={t("users.sections")}
            value={scope}
            onChange={(v) => setScope(v as Scope)}
            options={[
              { value: "all", label: t("vat.combined") },
              { value: "bakery", label: t("section.bakery") },
              { value: "grocery", label: t("section.grocery") },
            ]}
          />
        </div>
        <p className="pb-2 text-muted-foreground text-sm">
          {fmtDate(range.from)} – {fmtDate(range.to)}
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="font-normal">
            {year} Q{quarter}
          </CardTitle>
          <CardDescription>{t("vat.formulaHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {f === null ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              {line(t("vat.salesNet"), f.net)}
              {line(t("vat.creditNotesVat", { n: fmtMoney(f.cnVat) }), f.out)}
              {line(t("vat.inputVat"), f.input)}
              {line(t("vat.netPayable"), f.payable, true)}
              {line(t("vat.paid"), num(data?.paid))}
              {line(t("vat.balance"), f.payable - num(data?.paid), true)}
              {f.exN > 0 ? (
                <p className="py-2 text-amber-600 text-sm dark:text-amber-400">
                  {t("vat.notCounted", { n: f.exN, total: fmtMoney(f.exNet), vat: fmtMoney(f.exVat) })}
                </p>
              ) : null}
              {scope !== "bakery" && num(data?.grocery_sales.days_entered) === 0 ? (
                <p className="py-2 text-muted-foreground text-sm">{t("vat.noGrocerySales")}</p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="font-normal">{t("vat.pastQuarters")}</CardTitle>
          <CardDescription>{t("vat.pastHelp")}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("vat.quarter")}</TableHead>
                <TableHead className="text-end">{t("vat.outputVat")}</TableHead>
                <TableHead className="text-end">{t("vat.inputVat")}</TableHead>
                <TableHead className="text-end">{t("vat.netPayable")}</TableHead>
                <TableHead className="text-end">{t("vat.paid")}</TableHead>
                <TableHead className="text-end">{t("vat.balance")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {past.map((r) => {
                const x = figures(r, scope);
                return (
                  <TableRow
                    key={`${r.year}-${r.quarter}`}
                    className="cursor-pointer"
                    onClick={() => setSel(`${r.year}-${r.quarter}`)}
                  >
                    <TableCell className="font-medium">
                      {r.year} Q{r.quarter}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(x.out)}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(x.input)}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(x.payable)}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(num(r.paid))}</TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(x.payable - num(r.paid))}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="font-normal">{t("vat.payments")}</CardTitle>
          <CardDescription>{t("vat.paymentsHelp", { q: `${year} Q${quarter}` })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void addPayment();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="p-amt">{t("vat.amount")}</Label>
              <Input
                id="p-amt"
                type="number"
                step="0.01"
                min="0"
                required
                dir="ltr"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-date">{t("vat.paidOn")}</Label>
              <Input
                id="p-date"
                type="date"
                value={form.paid_on}
                onChange={(e) => setForm({ ...form, paid_on: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-ref">{t("vat.reference")}</Label>
              <Input
                id="p-ref"
                maxLength={200}
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
              />
            </div>
            <Button type="submit">{t("common.save")}</Button>
          </form>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("vat.quarter")}</TableHead>
                <TableHead className="text-end">{t("vat.amount")}</TableHead>
                <TableHead>{t("vat.paidOn")}</TableHead>
                <TableHead>{t("vat.reference")}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {t("common.noData")}
                  </TableCell>
                </TableRow>
              ) : (
                payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      {p.period_year} Q{p.period_quarter}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{fmtMoney(num(p.amount_paid))}</TableCell>
                    <TableCell>{p.paid_on ? fmtDate(p.paid_on) : "—"}</TableCell>
                    <TableCell>{p.reference ?? ""}</TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("common.delete")}
                        onClick={() => removePayment(p.id)}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
