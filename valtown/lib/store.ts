// Data access port. SupabaseStore talks PostgREST/Storage with the SERVICE ROLE key (server-side only);
// MemoryStore is used by tests and mirrors the DB constraints that matter (unique dedupe key).
import { env, requireEnv } from "./env.ts";

export type Op = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "ilike" | "in" | "is";
export type Filter = [column: string, op: Op, value: unknown];
export interface Query {
  filters?: Filter[];
  order?: [column: string, dir: "asc" | "desc"];
  limit?: number;
  offset?: number;
  columns?: string;
}
export type Row = Record<string, any>;
export type InsertResult = { ok: true; row: Row } | { ok: false; conflict: true } | { ok: false; conflict: false; error: string };

export interface Store {
  select(table: string, q?: Query): Promise<{ rows: Row[]; count: number }>;
  insert(table: string, row: Row, actor?: string): Promise<InsertResult>;
  upsert(table: string, row: Row, onConflict: string, actor?: string): Promise<Row>;
  /** Bulk upsert (one request). Returns the number of rows written. */
  upsertMany(table: string, rows: Row[], onConflict: string): Promise<number>;
  /** Calls a Postgres function (PostgREST /rpc). Only service-role functions are reachable here. */
  rpc(fn: string, args?: Row): Promise<Row[]>;
  update(table: string, filters: Filter[], patch: Row, actor?: string): Promise<Row[]>;
  remove(table: string, filters: Filter[], actor?: string): Promise<number>;
  uploadObject(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  signedUrl(path: string, expiresInSec: number): Promise<string | null>;
}

const enc = encodeURIComponent;
function filterParam([col, op, val]: Filter): string {
  if (op === "in") return `${enc(col)}=in.(${(val as unknown[]).map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")})`;
  if (op === "is") return `${enc(col)}=is.${val}`;
  if (op === "ilike") return `${enc(col)}=ilike.${enc(String(val))}`;
  return `${enc(col)}=${op}.${enc(String(val))}`;
}

export class SupabaseStore implements Store {
  private url: string;
  private key: string;
  private f: typeof fetch;
  constructor(url?: string, key?: string, f: typeof fetch = (...a) => fetch(...a)) {
    this.url = (url ?? requireEnv("SUPABASE_URL")).replace(/\/$/, "");
    this.key = key ?? requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    this.f = f;
  }

  private headers(actor?: string, extra: Record<string, string> = {}) {
    const h: Record<string, string> = { apikey: this.key, ...this.bearer(), "Content-Type": "application/json", ...extra };
    if (actor) h["x-actor"] = actor.slice(0, 200); // read by the audit trigger via request.headers
    return h;
  }
  /** Legacy service_role keys are JWTs (send as Bearer too). New "sb_secret_…" keys are not JWTs: apikey header only. */
  private bearer(): Record<string, string> {
    return this.key.startsWith("sb_") ? {} : { Authorization: `Bearer ${this.key}` };
  }
  private qs(q: Query = {}) {
    const p: string[] = [];
    if (q.columns) p.push(`select=${enc(q.columns)}`);
    for (const f of q.filters ?? []) p.push(filterParam(f));
    if (q.order) p.push(`order=${enc(q.order[0])}.${q.order[1]}`);
    if (q.limit != null) p.push(`limit=${q.limit}`);
    if (q.offset) p.push(`offset=${q.offset}`);
    return p.length ? `?${p.join("&")}` : "";
  }

  async select(table: string, q: Query = {}) {
    const r = await this.f(`${this.url}/rest/v1/${table}${this.qs(q)}`, { headers: this.headers(undefined, { Prefer: "count=exact" }) });
    if (!r.ok) throw new Error(`select ${table} failed: ${r.status}`);
    const rows = (await r.json()) as Row[];
    const total = Number(r.headers.get("content-range")?.split("/")[1]);
    return { rows, count: Number.isFinite(total) ? total : rows.length };
  }
  async insert(table: string, row: Row, actor?: string): Promise<InsertResult> {
    const r = await this.f(`${this.url}/rest/v1/${table}`, { method: "POST", headers: this.headers(actor, { Prefer: "return=representation" }), body: JSON.stringify(row) });
    if (r.status === 409) return { ok: false, conflict: true };
    if (!r.ok) return { ok: false, conflict: false, error: `${r.status} ${(await r.text()).slice(0, 300)}` };
    return { ok: true, row: ((await r.json()) as Row[])[0] };
  }
  async upsert(table: string, row: Row, onConflict: string, actor?: string) {
    const r = await this.f(`${this.url}/rest/v1/${table}?on_conflict=${enc(onConflict)}`, {
      method: "POST", headers: this.headers(actor, { Prefer: "return=representation,resolution=merge-duplicates" }), body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`upsert ${table} failed: ${r.status}`);
    return ((await r.json()) as Row[])[0];
  }
  async upsertMany(table: string, rows: Row[], onConflict: string) {
    if (!rows.length) return 0;
    const r = await this.f(`${this.url}/rest/v1/${table}?on_conflict=${enc(onConflict)}`, {
      method: "POST", headers: this.headers(undefined, { Prefer: "return=minimal,resolution=merge-duplicates" }), body: JSON.stringify(rows),
    });
    if (!r.ok) throw new Error(`upsertMany ${table} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return rows.length;
  }
  async rpc(fn: string, args: Row = {}) {
    const r = await this.f(`${this.url}/rest/v1/rpc/${fn}`, { method: "POST", headers: this.headers(), body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`rpc ${fn} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (Array.isArray(j) ? j : [j]) as Row[];
  }
  async update(table: string, filters: Filter[], patch: Row, actor?: string) {
    const r = await this.f(`${this.url}/rest/v1/${table}${this.qs({ filters })}`, { method: "PATCH", headers: this.headers(actor, { Prefer: "return=representation" }), body: JSON.stringify(patch) });
    if (!r.ok) throw new Error(`update ${table} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as Row[];
  }
  async remove(table: string, filters: Filter[], actor?: string) {
    const r = await this.f(`${this.url}/rest/v1/${table}${this.qs({ filters })}`, { method: "DELETE", headers: this.headers(actor, { Prefer: "return=representation" }) });
    if (!r.ok) throw new Error(`delete ${table} failed: ${r.status}`);
    return ((await r.json()) as Row[]).length;
  }
  async uploadObject(path: string, bytes: Uint8Array, contentType: string) {
    const r = await this.f(`${this.url}/storage/v1/object/invoice-images/${path}`, {
      method: "POST", headers: { apikey: this.key, ...this.bearer(), "Content-Type": contentType, "x-upsert": "true" }, body: new Blob([bytes as BlobPart]),
    });
    if (!r.ok) throw new Error(`storage upload failed: ${r.status}`);
  }
  async signedUrl(path: string, expiresInSec: number) {
    const r = await this.f(`${this.url}/storage/v1/object/sign/invoice-images/${path}`, {
      method: "POST", headers: this.headers(), body: JSON.stringify({ expiresIn: expiresInSec }),
    });
    if (!r.ok) return null;
    const { signedURL } = (await r.json()) as { signedURL?: string };
    return signedURL ? `${this.url}/storage/v1${signedURL}` : null;
  }
}

let shared: Store | undefined;
export function getStore(): Store {
  return (shared ??= new SupabaseStore());
}
export function setStore(s: Store | undefined) {
  shared = s;
}
export const hasSupabaseEnv = () => Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));

// ------------------------------------------------------------------ in-memory (tests)
const EXPENSE_KEYS = [["vat_number", "invoice_date", "total_amount"], ["raw_qr"]];
const DEDUPE: Record<string, string[][]> = {
  bakery_expenses: EXPENSE_KEYS,
  grocery_expenses: EXPENSE_KEYS,
  whatsapp_events: [["wa_message_id"]],
  app_users: [["phone_e164"], ["token_hash"]],
  alerts: [["fingerprint"]],
};

function matches(row: Row, [c, op, v]: Filter): boolean {
  const x = row[c];
  switch (op) {
    case "eq": return x === v || String(x) === String(v);
    case "neq": return x !== v;
    case "gt": return x > (v as never);
    case "gte": return x >= (v as never);
    case "lt": return x < (v as never);
    case "lte": return x <= (v as never);
    case "ilike": return new RegExp(`^${String(v).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i").test(String(x ?? ""));
    case "in": return (v as unknown[]).includes(x);
    case "is": return v === "null" ? x == null : x === v;
  }
}

export class MemoryStore implements Store {
  tables: Record<string, Row[]> = {};
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  audit: { actor?: string; op: string; table: string }[] = [];
  private t(name: string) { return (this.tables[name] ??= []); }

  async select(table: string, q: Query = {}) {
    let rows = this.t(table).filter((r) => (q.filters ?? []).every((f) => matches(r, f)));
    if (q.order) {
      const [c, d] = q.order;
      rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (d === "desc" ? -1 : 1));
    }
    const count = rows.length;
    rows = rows.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? rows.length));
    return { rows: rows.map((r) => ({ ...r })), count };
  }
  async insert(table: string, row: Row, actor?: string): Promise<InsertResult> {
    for (const keys of DEDUPE[table] ?? []) {
      if (keys.every((k) => row[k] != null) && this.t(table).some((r) => keys.every((k) => r[k] === row[k]))) return { ok: false, conflict: true };
    }
    if (table.endsWith("_expenses")) {
      if (row.total_amount < 0 || row.vat_amount < 0 || row.vat_amount > row.total_amount)
        return { ok: false, conflict: false, error: "check constraint" };
      row = { status: "new", warnings: [], duplicate_count: 0, ...row };
    }
    const full = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row };
    this.t(table).push(full);
    this.audit.push({ actor, op: "INSERT", table });
    return { ok: true, row: { ...full } };
  }
  async upsert(table: string, row: Row, onConflict: string, actor?: string) {
    const ex = this.t(table).find((r) => r[onConflict] === row[onConflict]);
    if (ex) { Object.assign(ex, row); this.audit.push({ actor, op: "UPDATE", table }); return { ...ex }; }
    const r = await this.insert(table, row, actor);
    return (r as { row: Row }).row;
  }
  async upsertMany(table: string, rows: Row[], onConflict: string) {
    for (const row of rows) await this.upsert(table, row, onConflict);
    return rows.length;
  }
  rpcHandlers: Record<string, (args: Row) => Row[]> = {};
  async rpc(fn: string, args: Row = {}) {
    const h = this.rpcHandlers[fn];
    if (!h) throw new Error(`rpc ${fn} not available in MemoryStore`);
    return h(args);
  }
  async update(table: string, filters: Filter[], patch: Row, actor?: string) {
    const hit = this.t(table).filter((r) => filters.every((f) => matches(r, f)));
    for (const r of hit) { Object.assign(r, patch, table.endsWith("_expenses") ? { updated_at: new Date().toISOString() } : {}); this.audit.push({ actor, op: "UPDATE", table }); }
    return hit.map((r) => ({ ...r }));
  }
  async remove(table: string, filters: Filter[], actor?: string) {
    const all = this.t(table);
    const keep = all.filter((r) => !filters.every((f) => matches(r, f)));
    const n = all.length - keep.length;
    this.tables[table] = keep;
    for (let i = 0; i < n; i++) this.audit.push({ actor, op: "DELETE", table });
    return n;
  }
  async uploadObject(path: string, bytes: Uint8Array, contentType: string) { this.objects.set(path, { bytes, contentType }); }
  async signedUrl(path: string) { return this.objects.has(path) ? `https://storage.test/sign/${path}?token=t` : null; }
}
