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


/** Minimal Odoo domain evaluator (prefix | and implicit &, comparisons on plain fields). */
function evalDomain(domain: any[]): (m: Move) => boolean {
  let i = 0;
  const term = (): ((m: Move) => boolean) => {
    const t = domain[i++];
    if (t === "|") { const a = term(); const b = term(); return (m) => a(m) || b(m); }
    if (t === "&") { const a = term(); const b = term(); return (m) => a(m) && b(m); }
    const [f, op, v] = t as [string, string, any];
    return (m) => {
      const x = m[f];
      switch (op) {
        case "in": return v.includes(x);
        case "=": return x === v;
        case ">": return x !== false && x > v;
        case ">=": return x !== false && x >= v;
        default: throw new Error(`op ${op}`);
      }
    };
  };
  const parts: ((m: Move) => boolean)[] = [];
  while (i < domain.length) parts.push(term());
  return (m) => parts.every((p) => p(m));
}

/** Fake Odoo: understands only the sync's keyset domain. Records every call. */
function fakeOdoo(moves: Move[], partners: Record<number, { name: string; vat: string | false }> = {}) {
  const calls: string[] = [];
  const o: any = {
    calls,
    async execute(_m: string, method: string) { calls.push(method); return Object.fromEntries(Object.keys(moves[0] ?? mv(1)).map((k) => [k, {}])); },
    async searchRead(_model: string, domain: any[], _f: string[], opts: { limit?: number; offset?: number; order?: string }) {
      calls.push("search_read");
      const test = evalDomain(domain);
      const rows = moves.filter(test);
      const byId = opts.order === "id asc";
      rows.sort((a, b) => (byId ? a.id - b.id : a.write_date === b.write_date ? a.id - b.id : a.write_date < b.write_date ? -1 : 1));
      const off = opts.offset ?? 0;
      return rows.slice(off, off + (opts.limit ?? 200)).map((m) => ({ ...m }));
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
  const cur = s.tables.sync_state.find((x) => x.key === "backfill")!.value;
  assert.equal(cur.last_id, 3);
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
  await s.upsert("app_settings", { key: "sync_settings", value: { batch_size: 10, backfill_batch: 10, pause_ms: 0, max_run_seconds: 25 } }, "key");
  const odoo = fakeOdoo(moves);
  const r1 = await runSyncCycle(s, odoo, base);
  assert.equal(r1.fetched, 25);
  assert.ok(r1.caughtUp);

  const s2 = mem();
  await s2.upsert("app_settings", { key: "sync_settings", value: { batch_size: 10, backfill_batch: 10, pause_ms: 0, max_run_seconds: 0 } }, "key");
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

test("a mass update (thousands of documents with the same write_date) is imported completely", async () => {
  const s = mem();
  const moves = Array.from({ length: 35 }, (_, i) => mv(i + 1, { write_date: "2026-05-30 16:04:46", invoice_date: "2026-01-10", create_date: "2026-01-10 10:00:00" }));
  await s.upsert("app_settings", { key: "sync_settings", value: { batch_size: 10, backfill_batch: 10, pause_ms: 0, max_run_seconds: 25 } }, "key");
  const r = await runSyncCycle(s, fakeOdoo(moves), base);
  assert.equal(s.tables.sales_invoices.length, 35);
  assert.ok(r.caughtUp);
});

test("documents older than the history start are not imported; undated drafts are", async () => {
  const s = mem();
  const moves = [mv(1, { invoice_date: "2025-01-19" }), mv(2, { invoice_date: "2025-11-02" }), mv(3, { invoice_date: false, state: "draft", name: "/" })];
  await runSyncCycle(s, fakeOdoo(moves), base);
  assert.deepEqual(s.tables.sales_invoices.map((r) => r.odoo_id).sort(), [2, 3]);
});

test("after the import, later changes are picked up and nothing is lost at the boundary", async () => {
  const s = mem();
  const moves = [mv(1, { write_date: "2026-10-01 08:00:00" })];
  await runSyncCycle(s, fakeOdoo(moves), base);
  moves.push(mv(2, { write_date: "2026-10-15 08:55:00" }), mv(3, { write_date: "2026-10-15 08:55:00" }));
  await runSyncCycle(s, fakeOdoo(moves), base);
  assert.equal(s.tables.sales_invoices.length, 3);
  moves.push(mv(4, { write_date: "2026-10-15 08:58:00" }));
  await runSyncCycle(s, fakeOdoo(moves), base);
  assert.equal(s.tables.sales_invoices.length, 4);
});

test("duplicate burst: a single invoice is no alert, a second identical one is, and it lists every invoice", async () => {
  const s = mem();
  const same = (id: number, t: string) => mv(id, { partner_id: [500, "Same Cust"], amount_total: 24.5, amount_untaxed: 21.3, amount_tax: 3.2, create_date: `2026-10-15 08:${t}:00`, write_date: `2026-10-15 08:${t}:01` });
  await runSyncCycle(s, fakeOdoo([same(1, "50")]), base);
  assert.equal((s.tables.alerts ?? []).filter((a) => a.rule_key === "duplicate_burst").length, 0);
  await runSyncCycle(s, fakeOdoo([same(1, "50"), same(2, "52")]), base);
  const hits = (s.tables.alerts ?? []).filter((a) => a.rule_key === "duplicate_burst");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].detail.count, 2);
  assert.deepEqual(hits[0].detail.invoices.map((i: any) => i.number), ["INV/2026/1", "INV/2026/2"]);
  // a third identical invoice in the same hour grows the SAME alert and lists all three
  await runSyncCycle(s, fakeOdoo([same(1, "50"), same(2, "52"), same(3, "55")]), base);
  const grown = (s.tables.alerts ?? []).filter((a) => a.rule_key === "duplicate_burst");
  assert.equal(grown.length, 1);
  assert.equal(grown[0].detail.count, 3);
  assert.deepEqual(grown[0].detail.invoices.map((i: any) => i.number), ["INV/2026/1", "INV/2026/2", "INV/2026/3"]);
  // a different amount is not a repeat
  await runSyncCycle(s, fakeOdoo([same(1, "50"), same(2, "52"), mv(3, { partner_id: [500, "Same Cust"], amount_total: 99, create_date: "2026-10-15 08:53:00", write_date: "2026-10-15 08:53:01" })]), base);
  assert.equal((s.tables.alerts ?? []).filter((a) => a.rule_key === "duplicate_burst").length, 1);
});

test("every credit note alerts, with who issued it, the reason and the original invoice", async () => {
  const s = mem();
  const inv = mv(1);
  const cn = mv(2, { move_type: "out_refund", name: "RINV/2026/9", ref: "Customer returned goods", reversed_entry_id: [1, "INV/2026/1"], create_uid: [3, "EMAN BAKERY"], invoice_user_id: [7, "Salesman A"] });
  const cn2 = mv(3, { move_type: "out_refund", name: "RINV/2026/10", ref: false, reversed_entry_id: false });
  await runSyncCycle(s, fakeOdoo([inv, cn, cn2]), base);
  const a = s.tables.alerts.find((x) => x.rule_key === "credit_any" && x.odoo_id === 2)!;
  assert.equal(a.detail.issued_by, "EMAN BAKERY");
  assert.equal(a.detail.reason, "Customer returned goods");
  assert.equal(a.detail.original_invoice, "INV/2026/1");
  assert.equal(a.detail.no_reason, false);
  const b = s.tables.alerts.find((x) => x.rule_key === "credit_any" && x.odoo_id === 3)!;
  assert.equal(b.detail.original_invoice, null);
  assert.equal(b.detail.no_reason, true);
  assert.ok(s.tables.alerts.some((x) => x.rule_key === "refund_unlinked" && x.odoo_id === 3));
});

import { judgeUnusual } from "../lib/alerts-engine.ts";
test("unusual amount: the daily behaviour of ONE salesman towards ONE customer", () => {
  const cfg = {};
  const usual = [100, 110, 90, 125, 100, 105, 95];
  // an ordinary day, or a normal ups-and-downs day: fine
  assert.equal(judgeUnusual(130, usual, cfg), null);
  // a genuine big day (500) in the middle of ~100 days is flagged once...
  const v = judgeUnusual(500, usual, cfg)!;
  assert.equal(v.reason, "above_usual");
  assert.equal(v.highest, 125);
  assert.ok(v.z >= 3.5);
  // ...and after it, days between the usual and that big day (200, 300) are NOT flagged
  const afterSpike = [...usual, 500, 100, 110];
  assert.equal(judgeUnusual(250, afterSpike, cfg), null);
  assert.equal(judgeUnusual(300, afterSpike, cfg), null);
  // but a day as big as the spike or bigger is flagged again, even though one such day happened before
  assert.equal(judgeUnusual(525, afterSpike, cfg)!.reason, "above_usual");
  assert.equal(judgeUnusual(700, afterSpike, cfg)!.reason, "above_usual");
  // a size that happens again and again becomes the customer's normal: flagged the 2nd and 3rd time, accepted from the 4th
  assert.equal(judgeUnusual(500, [...afterSpike, 500], cfg)!.reason, "above_usual");
  assert.equal(judgeUnusual(500, [...afterSpike, 500, 520], cfg), null); // the 4th such day: now it is normal for this customer
  // no pattern to compare with: flagged as "no history"
  assert.equal(judgeUnusual(800, [], cfg)!.reason, "no_history");
  assert.equal(judgeUnusual(800, [100, 120], cfg)!.reason, "no_history");
});

test("unusual amount works per day and updates one alert when more invoices arrive the same day", async () => {
  const s = mem();
  const mk = (id: number, amt: number, date: string, t: string) => mv(id, { partner_id: [900, "Regular Co"], invoice_date: date, amount_total: amt, amount_untaxed: amt / 1.15, amount_tax: amt - amt / 1.15, create_date: `${date} ${t}`, write_date: `${date} ${t}` });
  // a week of ordinary days (~100) to this customer, imported as history
  const hist = [mk(1, 100, "2026-10-05", "08:00:00"), mk(2, 110, "2026-10-06", "08:00:00"), mk(3, 90, "2026-10-07", "08:00:00"), mk(4, 125, "2026-10-08", "08:00:00")];
  await runSyncCycle(s, fakeOdoo(hist), base);
  const unusual = () => (s.tables.alerts ?? []).filter((a) => a.rule_key === "unusual_amount");
  // a 105 invoice today: ordinary
  await runSyncCycle(s, fakeOdoo([...hist, mk(5, 105, "2026-10-15", "08:52:00")]), base);
  assert.equal(unusual().length, 0);
  // a 450 invoice later today: the day total is 555, far above a usual day (~105) and above the best day (125)
  await runSyncCycle(s, fakeOdoo([...hist, mk(5, 105, "2026-10-15", "08:52:00"), mk(6, 450, "2026-10-15", "08:54:00")]), base);
  assert.equal(unusual().length, 1);
  assert.equal(unusual()[0].detail.day_total, 555);
  assert.equal(unusual()[0].severity, "critical");
  // one more invoice the same day updates the SAME alert
  await runSyncCycle(s, fakeOdoo([...hist, mk(5, 105, "2026-10-15", "08:52:00"), mk(6, 450, "2026-10-15", "08:54:00"), mk(7, 100, "2026-10-15", "08:56:00")]), base);
  assert.equal(unusual().length, 1);
  assert.equal(unusual()[0].detail.day_total, 655);
  assert.equal(unusual()[0].detail.day_invoices, 3);
});

test("unusual amount is not blinded by an old outlier, and has salesman-level and ceiling layers", async () => {
  // the real case: a customer with ~100/day, one 1,299 day and one 13,400 day long ago; today 2,048.81 must still be flagged
  const hist = [100, 95, 110, 105, 98, 120, 1299.5, 100, 13400.38, 102, 99, 101];
  const v = judgeUnusual(2048.81, hist, {})!;
  assert.equal(v.reason, "above_usual");
  assert.ok(v.ratio > 15);
  // a normal-ish day is still fine
  assert.equal(judgeUnusual(180, hist, {}), null);
  const { judgeSalesmanLevel } = await import("../lib/alerts-engine.ts");
  assert.equal(judgeSalesmanLevel(1518, { median: 124.2, count: 400 }, {}), true);
  assert.equal(judgeSalesmanLevel(900, { median: 124.2, count: 400 }, {}), false); // below the SAR 1,000 floor
  assert.equal(judgeSalesmanLevel(1200, { median: 600, count: 400 }, {}), false); // not 3x this salesman's typical
  assert.equal(judgeSalesmanLevel(5000, { median: 100, count: 3 }, {}), false); // too little salesman history
});

test("a big invoice to a customer with a big history is still caught by the salesman layer and the ceiling", async () => {
  const s = mem();
  const mk = (id: number, partner: number, amt: number, date: string, t: string) => mv(id, { partner_id: [partner, `Cust ${partner}`], invoice_date: date, amount_total: amt, amount_untaxed: amt / 1.15, amount_tax: amt - amt / 1.15, create_date: `${date} ${t}`, write_date: `${date} ${t}` });
  // the salesman's usual invoices to many customers (~120), and this customer has a huge old day (13,400)
  const hist = Array.from({ length: 12 }, (_, i) => mk(i + 1, 100 + i, 120, "2026-10-08", `08:${10 + i}:00`));
  hist.push(mk(30, 700, 13400, "2026-09-17", "08:00:00"), mk(31, 700, 100, "2026-10-01", "08:00:00"), mk(32, 700, 100, "2026-10-02", "08:00:00"), mk(33, 700, 100, "2026-10-03", "08:00:00"));
  await runSyncCycle(s, fakeOdoo(hist), base);
  await runSyncCycle(s, fakeOdoo([...hist, mk(40, 700, 1518, "2026-10-15", "08:52:00")]), base);
  const a = (s.tables.alerts ?? []).filter((x) => x.rule_key === "unusual_amount" && x.odoo_id === 40);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, "critical");
  assert.ok(a[0].detail.reasons.includes("above_usual"));
});
