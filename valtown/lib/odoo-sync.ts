// Odoo -> Supabase sync (read-only on the Odoo side). Keyset pagination on (write_date, id): resumable, no duplicates, gentle.
// One "cycle" = fetch changed invoices/credit notes, upsert, evaluate event alerts, re-check ZATCA state of unsent docs,
// run scheduled checks, log the run. All Odoo access goes through OdooReader (the read-only guard lives in odoo.ts).
import { type EventCtx, evaluateInvoiceEvent } from "./alerts-engine.ts";
import { type CheckCtx, loadAndRunScheduled } from "./alerts-scheduled.ts";
import type { Domain, OdooReader } from "./odoo.ts";
import { errMsg, logger } from "./log.ts";
import { riyadhParts } from "./reports.ts";
import { type AlertDraft, DEFAULT_HOURS, DEFAULT_ZATCA, mergeRules, type SalesRow } from "./sales-types.ts";
import { getSetting } from "./settings.ts";
import type { Row, Store } from "./store.ts";

export interface SyncSettings { interval_minutes: number; history_months: number; history_from?: string; batch_size: number; backfill_batch?: number; pause_ms: number; max_run_seconds: number }
export const DEFAULT_SYNC: SyncSettings = { interval_minutes: 5, history_months: 12, batch_size: 400, pause_ms: 400, max_run_seconds: 25 };

const MOVE_FIELDS = ["name", "move_type", "state", "invoice_date", "create_date", "write_date", "write_uid", "invoice_user_id", "create_uid", "partner_id", "amount_untaxed", "amount_tax", "amount_total", "payment_state", "invoice_origin", "ref", "reversed_entry_id", "edi_state", "l10n_sa_uuid", "l10n_sa_chain_index", "l10n_sa_confirmation_datetime", "edi_error_message"];
const MOVE_TYPES = ["out_invoice", "out_refund"];
const HISTORIC_MS = 48 * 3_600_000;
const DEFAULT_HISTORY_FROM = "2025-10-01"; // VAT history starts with 2025 Q4
const BACKFILL_BATCH = 1000; // history import: bigger batches, fewer round trips

export const odooTs = (iso: string) => iso.replace("T", " ").replace(/\..*$/, "").replace("Z", ""); // "2026-10-15 08:00:00"
export const isoFromOdoo = (s: unknown): string | null => (typeof s === "string" && s ? `${s.replace(" ", "T")}Z` : null);
const m2o = (v: unknown): [number | null, string | null] => (Array.isArray(v) ? [Number(v[0]), String(v[1])] : [null, null]);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

export async function availableFields(odoo: OdooReader): Promise<string[]> {
  // fields_get is a read-only call; lets us skip fields that a given Odoo install does not have (e.g. no Saudi EDI module)
  const r = (await (odoo as any).execute?.("account.move", "fields_get", [], { attributes: ["type"] })) as Record<string, unknown> | undefined;
  return r ? MOVE_FIELDS.filter((f) => f in r) : MOVE_FIELDS;
}

export function mapMove(r: Record<string, any>, partners: Map<number, { vat: string | null; name: string | null }>): SalesRow {
  const [pid, pname] = m2o(r.partner_id);
  const [sid, sname] = m2o(r.invoice_user_id);
  const [cid, cname] = m2o(r.create_uid);
  const [rid, rname] = m2o(r.reversed_entry_id);
  const p = pid != null ? partners.get(pid) : undefined;
  const kind = r.move_type === "out_refund" ? "credit_note" : "invoice";
  return {
    odoo_id: Number(r.id), section: "bakery", number: str(r.name), kind, state: String(r.state),
    invoice_date: str(r.invoice_date), odoo_created_at: isoFromOdoo(r.create_date), odoo_write_at: isoFromOdoo(r.write_date),
    salesman_id: sid ?? cid, salesman_name: sname ?? cname, created_by_id: cid, created_by_name: cname,
    write_by_name: m2o(r.write_uid)[1],
    customer_id: pid, customer_name: p?.name ?? pname, customer_vat: p?.vat?.trim() || null,
    amount_untaxed: num(r.amount_untaxed), amount_tax: num(r.amount_tax), amount_total: num(r.amount_total),
    payment_state: str(r.payment_state), origin: str(r.invoice_origin), ref: str(r.ref),
    reversed_odoo_id: rid, reversed_number: rname,
    zatca_state: str(r.edi_state), zatca_uuid: str(r.l10n_sa_uuid), zatca_chain_index: r.l10n_sa_chain_index ? Number(r.l10n_sa_chain_index) : null,
    zatca_confirmed_at: isoFromOdoo(r.l10n_sa_confirmation_datetime), zatca_error: str(r.edi_error_message),
  };
}
const dbRow = (r: SalesRow): Row => {
  const { write_by_name: _w, segment: _s, ...rest } = r;
  return rest;
};

async function loadPartners(odoo: OdooReader, ids: number[], cache: Map<number, { vat: string | null; name: string | null }>) {
  const need = [...new Set(ids)].filter((i) => !cache.has(i));
  for (let i = 0; i < need.length; i += 200) {
    for (const p of await odoo.read("res.partner", need.slice(i, i + 200), ["name", "vat"])) cache.set(Number(p.id), { vat: str(p.vat), name: str(p.name) });
  }
}

export interface CycleOpts {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  scheduled?: boolean; // run scheduled alert checks after the sync (default true)
  kind?: "incremental" | "manual";
}
export interface CycleResult { fetched: number; upserted: number; alerts: number; caughtUp: boolean; error?: string; skipped?: string }

async function setState(store: Store, key: string, value: unknown) {
  await store.upsert("sync_state", { key, value, updated_at: new Date().toISOString() }, "key");
}
async function getState<T>(store: Store, key: string): Promise<T | null> {
  const { rows } = await store.select("sync_state", { filters: [["key", "eq", key]], limit: 1 });
  return rows[0] ? (rows[0].value as T) : null;
}

export async function insertAlerts(store: Store, drafts: AlertDraft[]): Promise<number> {
  let created = 0;
  for (const d of drafts) {
    const res = await store.insert("alerts", { ...d, section: d.section ?? "bakery", amount: d.amount ?? null });
    if (res.ok) created++;
    else if (res.conflict) {
      // a repeat burst that grows (3rd, 4th invoice), or more invoices on the same day, update the same alert so the card stays current
      if (d.rule_key === "duplicate_burst" || d.rule_key === "unusual_amount") await store.update("alerts", [["fingerprint", "eq", d.fingerprint]], { title: d.title, detail: d.detail, odoo_id: d.odoo_id ?? null, amount: d.amount ?? null });
    } else logger.warn("alert insert failed", { rule: d.rule_key, error: res.error });
  }
  return created;
}

async function buildEventCtx(store: Store, rows: SalesRow[], now: Date): Promise<EventCtx> {
  const rules = mergeRules(await getSetting(store, "alert_rules", {}));
  const hours = await getSetting(store, "working_hours", DEFAULT_HOURS);
  return {
    now, rules, hours,
    amountHistory: async (row) => {
      if (row.customer_id == null || row.salesman_id == null) return { days: [], todayOthers: 0, todayCount: 0 };
      const lookback = Number(rules.unusual_amount?.lookback_days ?? 90);
      const day = row.invoice_date ?? (row.odoo_created_at ?? now.toISOString()).slice(0, 10);
      const since = new Date(Date.parse(`${day}T00:00:00Z`) - lookback * 86_400_000).toISOString().slice(0, 10);
      const { rows: h } = await store.select("sales_invoices", { columns: "invoice_date,amount_total", filters: [["customer_id", "eq", row.customer_id], ["salesman_id", "eq", row.salesman_id], ["kind", "eq", "invoice"], ["state", "eq", "posted"], ["odoo_id", "neq", row.odoo_id], ["invoice_date", "gte", since], ["invoice_date", "lte", day]], limit: 1000 });
      const perDay = new Map<string, number>();
      let todayOthers = 0;
      let todayCount = 0;
      for (const r of h) {
        if (r.invoice_date === day) { todayOthers += Number(r.amount_total); todayCount++; }
        else perDay.set(r.invoice_date, (perDay.get(r.invoice_date) ?? 0) + Number(r.amount_total));
      }
      return { days: [...perDay.values()], todayOthers, todayCount };
    },
    originalInvoiceDate: async (id) => (await store.select("sales_invoices", { columns: "invoice_date", filters: [["odoo_id", "eq", id]], limit: 1 })).rows[0]?.invoice_date ?? null,
    creditNotesOnDay: async (sid, day) => (await store.select("sales_invoices", { columns: "odoo_id", filters: [["salesman_id", "eq", sid], ["kind", "eq", "credit_note"], ["state", "eq", "posted"], ["invoice_date", "eq", day]], limit: 1 })).count,
    similarInvoices: async (row, minutes) => {
      const from = new Date(Date.parse(row.odoo_created_at ?? now.toISOString()) - minutes * 60_000).toISOString();
      const { rows: found } = await store.select("sales_invoices", { columns: "number,odoo_created_at", filters: [["odoo_id", "neq", row.odoo_id], ["salesman_id", "eq", row.salesman_id ?? -1], ["customer_id", "eq", row.customer_id ?? -1], ["amount_total", "eq", row.amount_total], ["kind", "eq", "invoice"], ["state", "eq", "posted"], ["odoo_created_at", "gte", from]], limit: 20 });
      return found.map((r) => ({ number: r.number as string | null, odoo_created_at: r.odoo_created_at as string | null }));
    },
  };
}

/** One full cycle. Never throws: errors are recorded in sync_runs and returned. */
export async function runSyncCycle(store: Store, odoo: OdooReader, opts: CycleOpts = {}): Promise<CycleResult> {
  const clock = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = clock();
  const cfg = { ...DEFAULT_SYNC, ...(await getSetting<Partial<SyncSettings>>(store, "sync_settings", {})) };

  // simple lock so a slow run and the next tick never overlap
  const lock = await getState<{ until: string }>(store, "lock");
  if (lock && Date.parse(lock.until) > started.getTime()) return { fetched: 0, upserted: 0, alerts: 0, caughtUp: true, skipped: "another sync is running" };
  await setState(store, "lock", { until: new Date(started.getTime() + (cfg.max_run_seconds + 60) * 1000).toISOString() });

  const run = await store.insert("sync_runs", { kind: opts.kind ?? "incremental", started_at: started.toISOString() });
  const runId = run.ok ? run.row.id : null;
  const res: CycleResult = { fetched: 0, upserted: 0, alerts: 0, caughtUp: false };
  try {
    const fields = await availableFields(odoo);
    // Phase A (first import): walk by record id, so a mass update that gave thousands of documents the same write_date can never stall it.
    // Phase B (afterwards): changes since the last seen write_date (inclusive, so nothing at the boundary is missed), paged by offset.
    const histFrom = cfg.history_from ?? DEFAULT_HISTORY_FROM;
    let bf = await getState<{ last_id: number; start_ts: string; done?: boolean }>(store, "backfill");
    if (!bf) bf = { last_id: 0, start_ts: odooTs(new Date(started.getTime() - 10 * 60_000).toISOString()) };
    let inc = await getState<{ from: string; offset: number }>(store, "inc_cursor");
    let maxWrite: string | null = null;
    const partners = new Map<number, { vat: string | null; name: string | null }>();
    const pending: { row: SalesRow; prev: SalesRow | null }[] = [];
    const deadline = started.getTime() + cfg.max_run_seconds * 1000;
    const oldCut = started.getTime() - HISTORIC_MS;

    while (true) {
      let limit: number;
      let batch: Record<string, any>[];
      if (!bf.done) {
        limit = cfg.backfill_batch ?? BACKFILL_BATCH;
        const domain: Domain = [["move_type", "in", MOVE_TYPES], "|", ["invoice_date", ">=", histFrom], ["invoice_date", "=", false], ["id", ">", bf.last_id]];
        batch = await odoo.searchRead("account.move", domain, fields, { limit, order: "id asc" });
      } else {
        inc = inc ?? { from: bf.start_ts, offset: 0 };
        limit = cfg.batch_size;
        const domain: Domain = [["move_type", "in", MOVE_TYPES], ["write_date", ">=", inc.from]];
        batch = await odoo.searchRead("account.move", domain, fields, { limit, offset: inc.offset, order: "write_date asc, id asc" });
      }
      res.fetched += batch.length;
      if (batch.length) {
        await loadPartners(odoo, batch.map((b) => m2o(b.partner_id)[0]).filter((x): x is number => x != null), partners);
        const mapped = batch.map((b) => mapMove(b, partners));
        const prevRows = new Map<number, SalesRow>();
        const ids = mapped.map((m) => m.odoo_id);
        // old documents (not changed for 48 h) never raise event alerts, so skip the "previous version" lookup for them
        const allOld = batch.every((b) => Date.parse(isoFromOdoo(b.write_date) ?? "") < oldCut);
        if (!allOld) for (let i = 0; i < ids.length; i += 100) for (const p of (await store.select("sales_invoices", { filters: [["odoo_id", "in", ids.slice(i, i + 100)]], limit: 100 })).rows) prevRows.set(Number(p.odoo_id), p as SalesRow);
        res.upserted += await store.upsertMany("sales_invoices", mapped.map(dbRow), "odoo_id");
        for (const row of mapped) {
          const prev = prevRows.get(row.odoo_id) ?? null;
          if (prev && Date.parse(prev.odoo_write_at ?? "") === Date.parse(row.odoo_write_at ?? "")) continue; // unchanged (boundary re-read)
          const fresh = Date.parse(row.odoo_created_at ?? "") > oldCut;
          const changed = prev != null && (prev.state !== row.state || prev.kind !== row.kind);
          if (fresh || changed) pending.push({ row, prev }); // history import never raises event alerts
        }
        for (const b of batch) if (!maxWrite || String(b.write_date) > maxWrite) maxWrite = String(b.write_date);
      }
      if (!bf.done) {
        if (batch.length) bf.last_id = Number(batch[batch.length - 1].id);
        if (batch.length < limit) bf.done = true;
        await setState(store, "backfill", bf);
      } else if (inc) {
        if (batch.length < limit) {
          inc = { from: maxWrite && maxWrite > inc.from ? maxWrite : inc.from, offset: 0 };
          await setState(store, "inc_cursor", inc);
          res.caughtUp = true;
          break;
        }
        inc = { from: inc.from, offset: inc.offset + batch.length };
        await setState(store, "inc_cursor", inc);
      }
      if (clock().getTime() >= deadline) break;
      await sleep(cfg.pause_ms);
    }

    // Odoo does not always bump write_date when only the ZATCA state changes: re-read recent unsent documents
    const recent = new Date(started.getTime() - 3 * 86_400_000).toISOString();
    const open = await store.select("sales_invoices", { columns: "odoo_id", filters: [["state", "eq", "posted"], ["zatca_state", "neq", "sent"], ["odoo_created_at", "gte", recent]], limit: 300 });
    const nulls = await store.select("sales_invoices", { columns: "odoo_id", filters: [["state", "eq", "posted"], ["zatca_state", "is", "null"], ["odoo_created_at", "gte", recent]], limit: 300 });
    const reIds = [...new Set([...open.rows, ...nulls.rows].map((r) => Number(r.odoo_id)))];
    for (let i = 0; i < reIds.length; i += 100) {
      const got = await odoo.read("account.move", reIds.slice(i, i + 100), fields);
      await loadPartners(odoo, got.map((b) => m2o(b.partner_id)[0]).filter((x): x is number => x != null), partners);
      res.upserted += await store.upsertMany("sales_invoices", got.map((g) => dbRow(mapMove(g, partners))), "odoo_id");
    }

    const now = clock();
    if (pending.length) {
      const ctx = await buildEventCtx(store, pending.map((p) => p.row), now);
      const drafts: AlertDraft[] = [];
      for (const ev of pending) drafts.push(...(await evaluateInvoiceEvent(ev, ctx)));
      res.alerts += await insertAlerts(store, drafts);
    }
    if (opts.scheduled !== false && res.caughtUp) {
      const rules = mergeRules(await getSetting(store, "alert_rules", {}));
      const zatca = { ...DEFAULT_ZATCA, ...(await getSetting(store, "zatca_thresholds", {})) };
      const hours = await getSetting(store, "working_hours", DEFAULT_HOURS);
      const lastHourly = await getState<{ at: string }>(store, "last_hourly");
      const hourly = !lastHourly || now.getTime() - Date.parse(lastHourly.at) > 55 * 60_000;
      const cctx: CheckCtx = { now, rules, zatca, hours };
      res.alerts += await insertAlerts(store, await loadAndRunScheduled(store, cctx, { zatca: true, hourly }));
      if (hourly) await setState(store, "last_hourly", { at: now.toISOString() });
    }
    await setState(store, "last_success", { at: clock().toISOString(), caught_up: res.caughtUp, today: riyadhParts(clock()).date });
  } catch (e) {
    res.error = errMsg(e);
    logger.error("sync failed", { error: res.error });
  } finally {
    await setState(store, "lock", { until: new Date(0).toISOString() });
    if (runId != null) await store.update("sync_runs", [["id", "eq", runId]], { finished_at: clock().toISOString(), fetched: res.fetched, upserted: res.upserted, alerts_created: res.alerts, error: res.error ?? null, details: { caught_up: res.caughtUp } });
  }
  return res;
}
