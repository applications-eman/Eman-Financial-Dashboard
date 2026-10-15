import assert from "node:assert/strict";
import { test } from "node:test";
import { OdooClient, OdooWriteBlockedError } from "../lib/odoo.ts";
import { isoFromOdoo, odooTs, runSyncCycle } from "../lib/odoo-sync.ts";
import { MemoryStore } from "../lib/store.ts";

type Move = Record<string, any>;
const mv = (id: number, over: Move = {}): Move => ({
  id, name: `INV/2026/${id}`, move_type: "out_invoice", state: "posted", invoice_date: "2026-10-15", create_date: "2026-10-15 08:00:00",
  write_date: `2026-10-15 08:${String(id % 60).padStart(2, "0")}:00`, write_uid: [2, "EMAN BAKERY"], invoice_user_id: [7, "Salesman A"], create_uid: [7, "Salesman A"],
  partner_id: [100 + id, "Cust"], amount_untaxed: 100, amount_tax: 15, amount_total: 115, payment_state: "paid", invoice_origin: false, ref: false,
  reversed_entry_id: false, edi_state: "sent", l10n_sa_uuid: "u" + id, l10n_sa_chain_index: id, l10n_sa_confirmation_datetime: "2026-10-15 08:01:00", edi_error_message: false, ...over,
});

/** Fake Odoo: understands only the sync's keyset domain. Records every call. */
function fakeOdoo(moves: Move[], partners: Record<number, { name: string; vat: string | false }> = {}) {
  const calls: string[] = [];
  const o: any = {
    calls,
    async execute(_m: string, method: string) { calls.push(method); return Object.fromEntries(Object.keys(moves[0] ?? mv(1)).map((k) => [k, {}])); },
    async searchRead(model: string, domain: any[], _f: string[], opts: { limit?: number }) {
      calls.push("search_read");
      const [, , , , gtDate, , eqDate, gtId] = [domain[0], domain[1], domain[2], domain[3], domain[4], domain[5], domain[6], domain[7]]; // eslint-disable-line
      const wd = (domain[2] as any)[2] as string, id = (domain[4] as any)[2] as number;
      void gtDate; void eqDate; void gtId;
      return moves
        .filter((m) => m.write_date > wd || (m.write_date === wd && m.id > id))
        .sort((a, b) => (a.write_date === b.write_date ? a.id - b.id : a.write_date < b.write_date ? -1 : 1))
        .slice(0, opts.limit ?? 200).map((m) => ({ ...m }));
    },
    async searchCount() { return moves.length; },
    async read(model: string, ids: number[]) {
      calls.push(`read:${model}`);
      return model === "res.partner" ? ids.map((i) => ({ id: i, name: partners[i]?.name ?? "Cust", vat: partners[i]?.vat ?? false })) : moves.filter((m) => ids.includes(m.id)).map((m) => ({ ...m }));
    },
    async readGroup() { return []; },
  };
  return o;
}
const mem = () => {
  const s = new MemoryStore();
  for (const f of ["invoice_number_gaps", "salesman_daily_totals", "salesman_stats"]) s.rpcHandlers[f] = () => [];
  return s;
};
const NOW = new Date("2026-10-15T09:00:00Z");
const base = { now: () => NOW, sleep: async () => {} };

test("odoo timestamp helpers", () => {
  assert.equal(odooTs("2026-10-15T08:00:00.123Z"), "2026-10-15 08:00:00");
  assert.equal(isoFromOdoo("2026-10-15 08:00:00"), "2026-10-15T08:00:00Z");
  assert.equal(isoFromOdoo(false), null);
});

test("sync imports invoices, derives B2B/B2C from the partner VAT and advances the cursor", async () => {
  const s = mem();
  const odoo = fakeOdoo([mv(1), mv(2), mv(3, { move_type: "out_refund", ref: "customer returned goods" })], { 101: { name: "Big Co", vat: "300000000000003" } });
  const r = await runSyncCycle(s, odoo, base);
  assert.equal(r.error, undefined);
  assert.equal(r.fetched, 3);
  const rows = s.tables.sales_invoices;
  assert.equal(rows.length, 3);
  assert.equal(rows.find((x) => x.odoo_id === 1)!.customer_vat, "300000000000003");
  assert.equal(rows.find((x) => x.odoo_id === 2)!.customer_vat, null);
  assert.equal(rows.find((x) => x.odoo_id === 3)!.kind, "credit_note");
  const cur = s.tables.sync_state.find((x) => x.key === "invoice_cursor")!.value;
  assert.equal(cur.id, 3);
  assert.ok(s.tables.alerts.some((a) => a.rule_key === "credit_any"), "credit note raises an alert");
  const run = s.tables.sync_runs[0];
  assert.ok(run.finished_at && run.fetched === 3);
});

test("second run fetches nothing new and creates no duplicate alerts", async () => {
  const s = mem();
  const odoo = fakeOdoo([mv(1), mv(3, { move_type: "out_refund" })]);
  await runSyncCycle(s, odoo, base);
  const alerts = s.tables.alerts.length;
  const r = await runSyncCycle(s, odoo, base);
  assert.equal(r.fetched, 0);
  assert.equal(s.tables.alerts.length, alerts);
  assert.equal(s.tables.sales_invoices.length, 2);
});

test("history import (old documents) never raises event alerts", async () => {
  const s = mem();
  const old = mv(9, { move_type: "out_refund", create_date: "2026-03-01 08:00:00", write_date: "2026-03-01 08:00:00", invoice_date: "2026-03-01" });
  await runSyncCycle(s, fakeOdoo([old]), base);
  assert.equal(s.tables.sales_invoices.length, 1);
  assert.equal((s.tables.alerts ?? []).length, 0);
});

test("catch-up mode: small batches over several loops reach the end; a tight time budget stops early and resumes", async () => {
  const s = mem();
  const moves = Array.from({ length: 25 }, (_, i) => mv(i + 1));
  await s.upsert("app_settings", { key: "sync_settings", value: { batch_size: 10, pause_ms: 0, max_run_seconds: 25 } }, "key");
  const odoo = fakeOdoo(moves);
  const r1 = await runSyncCycle(s, odoo, base);
  assert.equal(r1.fetched, 25);
  assert.ok(r1.caughtUp);

  const s2 = mem();
  await s2.upsert("app_settings", { key: "sync_settings", value: { batch_size: 10, pause_ms: 0, max_run_seconds: 0 } }, "key");
  const first = await runSyncCycle(s2, fakeOdoo(moves), base);
  assert.equal(first.fetched, 10);
  assert.equal(first.caughtUp, false);
  const second = await runSyncCycle(s2, fakeOdoo(moves), base);
  assert.equal(second.fetched, 10, "resumes from the cursor");
});

test("a posted invoice that later gets cancelled raises invoice_cancelled", async () => {
  const s = mem();
  const m = mv(5);
  await runSyncCycle(s, fakeOdoo([m]), base);
  const cancelled = { ...m, state: "cancel", write_date: "2026-10-15 08:59:00" };
  await runSyncCycle(s, fakeOdoo([cancelled]), base);
  assert.ok(s.tables.alerts.some((a) => a.rule_key === "invoice_cancelled" && a.odoo_id === 5));
});

test("unsent ZATCA documents are re-read even if Odoo did not bump write_date", async () => {
  const s = mem();
  const m = mv(6, { edi_state: "to_send" });
  const moves = [m];
  await runSyncCycle(s, fakeOdoo(moves), base);
  assert.equal(s.tables.sales_invoices[0].zatca_state, "to_send");
  moves[0] = { ...m, edi_state: "sent" }; // same write_date
  await runSyncCycle(s, fakeOdoo(moves), base);
  assert.equal(s.tables.sales_invoices[0].zatca_state, "sent");
});

test("an Odoo failure is recorded, not thrown, and the lock is released", async () => {
  const s = mem();
  const odoo = fakeOdoo([mv(1)]);
  odoo.searchRead = async () => { throw new Error("Odoo down"); };
  const r = await runSyncCycle(s, odoo, base);
  assert.match(r.error ?? "", /Odoo down/);
  assert.match(s.tables.sync_runs[0].error, /Odoo down/);
  const ok = await runSyncCycle(s, fakeOdoo([mv(1)]), base);
  assert.equal(ok.error, undefined);
});

test("read-only guard: write-type methods never leave the process", async () => {
  let requests = 0;
  const f = (async () => { requests++; return new Response(JSON.stringify({ result: 1 })); }) as typeof fetch;
  const c = new OdooClient({ url: "https://x.test", db: "d", login: "l", secret: "s" }, { f, sleep: async () => {}, minGapMs: 0 });
  for (const m of ["write", "create", "unlink", "action_post", "button_cancel", "copy", "message_post", "action_reverse"]) {
    await assert.rejects(() => c.execute("account.move", m, [[1]]), OdooWriteBlockedError);
  }
  assert.equal(requests, 0, "not even the login call was made");
  assert.deepEqual(await c.execute("account.move", "search_count", [[]]), 1);
});

test("client retries on 429 with back-off, then succeeds", async () => {
  let n = 0;
  const sleeps: number[] = [];
  const f = (async () => (++n < 3 ? new Response("", { status: 429 }) : new Response(JSON.stringify({ result: 7 })))) as typeof fetch;
  const c = new OdooClient({ url: "https://x.test", db: "d", login: "l", secret: "s" }, { f, sleep: async (ms) => { sleeps.push(ms); }, minGapMs: 0 });
  assert.equal(await c.authenticate(), 7);
  assert.ok(sleeps.some((x) => x >= 1000));
});
