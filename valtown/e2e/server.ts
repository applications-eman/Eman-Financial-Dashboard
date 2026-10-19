// LOCAL end-to-end harness (NOT production code): a minimal Supabase look-alike (Auth + PostgREST + Realtime over
// websockets) that shares one in-memory dataset with the REAL Hono backend. Lets Playwright drive the real dashboard.
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { generateToken } from "../lib/crypto.ts";
import { signHs256, verifySupabaseJwt } from "../lib/jwt.ts";
import { type Filter, MemoryStore, type Row, setStore } from "../lib/store.ts";

const SUPA_PORT = Number(process.env.E2E_SUPA_PORT ?? 54321);
const API_PORT = Number(process.env.E2E_API_PORT ?? 8787);
const DASH = process.env.E2E_DASH_ORIGIN ?? "http://localhost:3100";
const SECRET = "e2e-jwt-secret-0123456789abcdef0123456789";
process.env.SUPABASE_URL = `http://localhost:${SUPA_PORT}`;
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.WA_APP_SECRET = "e2e-app-secret";
process.env.ALLOWED_ORIGIN = DASH;

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const STAFF_AUTH_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const PASSWORD = "correct-horse-battery";

// ------------------------------------------------------------ realtime hub
interface Sub { ws: WebSocket; topic: string; joinRef: string | null; filters: { id: number; table: string }[] }
const subs = new Set<Sub>();
function broadcast(table: string, type: "INSERT" | "UPDATE" | "DELETE", record: Row, old: Row = {}) {
  for (const s of subs) {
    const ids = s.filters.filter((f) => f.table === table).map((f) => f.id);
    if (!ids.length) continue;
    s.ws.send(JSON.stringify([null, null, s.topic, "postgres_changes", {
      ids,
      data: { schema: "public", table, commit_timestamp: new Date().toISOString(), type, record: type === "DELETE" ? {} : record, old_record: type === "DELETE" ? old : {}, columns: [], errors: null },
    }]));
  }
}

class EmittingStore extends MemoryStore {
  override async insert(table: string, row: Row, actor?: string) {
    const r = await super.insert(table, row, actor);
    if (r.ok && table.endsWith("_expenses")) {
      // emulate DB triggers: warnings (VAT ~15%) and audit
      const net = r.row.total_amount - r.row.vat_amount;
      const target = this.tables[table].find((x) => x.id === r.row.id);
      if (target) target.warnings = Math.abs(r.row.vat_amount - Math.round(net * 0.15 * 100) / 100) > 0.05 + 0.005 * net ? ["vat_rate_mismatch"] : [];
      broadcast(table, "INSERT", { ...(target ?? r.row) });
    }
    if (r.ok) this.logAudit(actor, "INSERT", table, r.row);
    return r;
  }
  override async update(table: string, filters: Filter[], patch: Row, actor?: string) {
    const before = (await super.select(table, { filters })).rows;
    const rows = await super.update(table, filters, patch, actor);
    rows.forEach((r, i) => {
      if (table.endsWith("_expenses")) broadcast(table, "UPDATE", r);
      this.logAudit(actor, "UPDATE", table, r, before[i]);
    });
    return rows;
  }
  override async remove(table: string, filters: Filter[], actor?: string) {
    const before = (await super.select(table, { filters })).rows;
    const n = await super.remove(table, filters, actor);
    for (const b of before) {
      if (table.endsWith("_expenses")) broadcast(table, "DELETE", {}, b);
      this.logAudit(actor, "DELETE", table, undefined, b);
    }
    return n;
  }
  private logAudit(actor: string | undefined, action: string, table: string, after?: Row, before?: Row) {
    if (table === "audit_log") return;
    const strip = (r?: Row) => (r ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== "token_hash")) : null);
    const list = (this.tables.audit_log ??= []);
    list.push({ id: list.length + 1, actor: actor ?? "system", action, table_name: table, record_id: String((after ?? before)?.id ?? (after ?? before)?.key ?? ""), before: strip(before), after: strip(after), created_at: new Date().toISOString() });
  }
}

const store = new EmittingStore();
setStore(store);

async function seed() {
  const now = Date.now();
  const staff = generateToken();
  await store.insert("app_users", { auth_user_id: ADMIN_ID, name: "Eman Admin", role: "admin", sections: ["bakery", "grocery"], active: true, phone_e164: "+966500000001" });
  await store.insert("app_users", { auth_user_id: STAFF_AUTH_ID, name: "Ali Staff", role: "staff", sections: ["bakery"], active: true, phone_e164: "+966500000002", token_hash: staff.hash });
  for (const [section, names] of [["bakery", ["Flour & Grains", "Packaging", "Other"]], ["grocery", ["Fresh Produce", "Other"]]] as const) {
    for (const name of names) await store.insert("categories", { section, name, name_ar: null, active: true });
  }
  await store.insert("app_settings", { key: "vat_rate", value: 0.15, updated_at: new Date().toISOString() });
  await store.insert("app_settings", { key: "report_schedule", value: { daily_enabled: true, daily_hour: 21, weekly_day: "sat" }, updated_at: new Date().toISOString() });
  await store.insert("app_settings", { key: "message_templates", value: { saved: { en: "Saved {{seller}}", ar: "تم الحفظ {{seller}}" } }, updated_at: new Date().toISOString() });
  await store.insert("feature_flags", { key: "ios_shortcut", enabled: true, description: "Allow iOS Shortcut capture" });
  await store.insert("feature_flags", { key: "alert_admins", enabled: true, description: "Alert admins" });
  const old = [["Flour Mill Co", 230, 30, "Flour & Grains"], ["Pack It", 115, 15, "Packaging"], ["Flour Mill Co", 345, 45, null]] as const;
  let i = 0;
  for (const [seller, total, vat, category] of old) {
    await store.insert("bakery_expenses", { seller_name: seller, vat_number: `30000000000000${i}`.slice(-15), invoice_date: new Date(now - (i + 1) * 86400_000).toISOString(), total_amount: total, vat_amount: vat, category, source: "ios_shortcut", submitted_by: "Ali Staff", status: "new", created_at: new Date(now - i * 3600_000).toISOString() });
    i++;
  }
  // alerts: today's are only 2 types / 1 salesman; older ones cover many types, salesmen and customers
  const types = ["unusual_amount", "duplicate_burst", "credit_any", "zatca_error", "number_gap", "invoice_backdated"];
  const people = ["ANAS-OP-3-RAWABI", "Khalid Salesman", "Omar Van", "Sami Route"];
  for (let n = 0; n < 40; n++) {
    const at = new Date(now - (n < 3 ? 0 : (2 + n) * 86400_000)).toISOString();
    const rule = n < 3 ? types[n % 2] : types[n % types.length];
    await store.insert("alerts", { rule_key: rule, severity: n % 3 === 0 ? "critical" : "warning", title: `Alert ${n}`, section: "bakery", salesman_name: n < 3 ? people[0] : people[n % 4], odoo_id: 1000 + n, amount: 100 + n, status: "open", fingerprint: `e2e:${n}`, detail: { number: `INV/2026/${n}`, kind: "invoice", customer: n < 3 ? "MATHAAM ABDUL AZEEZ" : `Customer ${String.fromCharCode(65 + (n % 12))}`, issued_at: at, segment: "B2B" }, created_at: at });
  }
  writeFileSync(new URL("./staff-token.txt", import.meta.url), staff.token);
}

// ------------------------------------------------------------ PostgREST subset
function toFilters(params: URLSearchParams): { filters: Filter[]; special: ((r: Row) => boolean)[] } {
  const filters: Filter[] = [];
  const special: ((r: Row) => boolean)[] = [];
  for (const [col, raw] of params) {
    if (["select", "order", "limit", "offset"].includes(col)) continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const val = raw.slice(dot + 1);
    if (col === "warnings" && op === "neq" && val === "{}") special.push((r) => (r.warnings ?? []).length > 0);
    else if (op === "gt") special.push((r) => Number(r[col]) > Number(val));
    else if (op === "lt") special.push((r) => String(r[col]) < val);
    else if (op === "in") filters.push([col, "in", val.slice(1, -1).split(",").map((x) => x.replace(/^"|"$/g, ""))]);
    else if (["eq", "neq", "gte", "lte", "ilike", "is"].includes(op)) filters.push([col, op as Filter[1], val === "true" ? true : val === "false" ? false : val]);
  }
  return { filters, special };
}

const cors = (origin: string | undefined) => ({
  "access-control-allow-origin": origin ?? "*",
  "access-control-allow-credentials": "true",
  "access-control-allow-headers": "*, authorization, apikey, content-type, x-client-info, accept-profile, content-profile, prefer, range",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-expose-headers": "content-range",
});

function session(sub: string, email: string) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub, email, aud: "authenticated", role: "authenticated", iss: `${process.env.SUPABASE_URL}/auth/v1`, iat: now, exp: now + 3600 };
  return {
    access_token: signHs256(claims, SECRET), refresh_token: `r_${sub}`, token_type: "bearer", expires_in: 3600, expires_at: now + 3600,
    user: { id: sub, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}
const ACCOUNTS: Record<string, string> = { "admin@eman.test": ADMIN_ID, "staff@eman.test": STAFF_AUTH_ID };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${SUPA_PORT}`);
  const h = cors(req.headers.origin);
  const send = (status: number, body?: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...h, ...extra });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return send(204);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {};
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /i, "");

  if (url.pathname === "/auth/v1/token") {
    if (url.searchParams.get("grant_type") === "password") {
      const id = ACCOUNTS[String(body.email).toLowerCase()];
      if (!id || body.password !== PASSWORD) return send(400, { error: "invalid_grant", error_description: "Invalid login credentials" });
      return send(200, session(id, body.email));
    }
    const id = String(body.refresh_token ?? "").replace("r_", "");
    const email = Object.entries(ACCOUNTS).find(([, v]) => v === id)?.[0];
    return email ? send(200, session(id, email)) : send(400, { error: "invalid_grant" });
  }
  if (url.pathname === "/auth/v1/user") {
    const c = await verifySupabaseJwt(bearer, { secret: SECRET });
    return c ? send(200, session(c.sub, String(c.email)).user) : send(401, { msg: "invalid JWT" });
  }
  if (url.pathname === "/auth/v1/logout") return send(204);
  if (url.pathname === "/auth/v1/.well-known/jwks.json") return send(200, { keys: [] });

  if (url.pathname.startsWith("/rest/v1/")) {
    const table = url.pathname.slice("/rest/v1/".length);
    const claims = await verifySupabaseJwt(bearer, { secret: SECRET });
    if (!claims) return send(401, { message: "JWT required" });
    const admin = (await store.select("app_users", { filters: [["auth_user_id", "eq", claims.sub], ["role", "eq", "admin"], ["active", "eq", true]] })).rows.length > 0;
    // emulate RLS: self_select on app_users; admin_select elsewhere
    if (table === "app_users") {
      const rows = (await store.select("app_users", { filters: [["auth_user_id", "eq", claims.sub]] })).rows.map(({ token_hash, ...r }) => r);
      return send(200, req.headers.accept?.includes("pgrst.object") ? (rows[0] ?? null) : rows, rows[0] || !req.headers.accept?.includes("pgrst.object") ? {} : {});
    }
    if (!admin) return send(200, []);
    const { filters, special } = toFilters(url.searchParams);
    const order = url.searchParams.get("order")?.split(".");
    let { rows } = await store.select(table, { filters, order: order ? [order[0], order[1] as "asc" | "desc"] : undefined });
    rows = rows.filter((r) => special.every((f) => f(r)));
    // select aliases such as "customer:detail->>customer"
    const sel = url.searchParams.get("select") ?? "*";
    if (sel.includes("->>")) {
      const cols = sel.split(",").map((c) => { const [alias, expr] = c.includes(":") ? c.split(":") : [c, c]; const [col, key] = expr.split("->>"); return { alias, col, key }; });
      rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c.alias, c.key ? (r[c.col] ?? {})[c.key] ?? null : r[c.col]])));
    }
    const total = rows.length;
    const off = Number(url.searchParams.get("offset") ?? 0);
    const lim = Number(url.searchParams.get("limit") ?? total);
    rows = rows.slice(off, off + lim);
    return send(200, rows, { "content-range": `${total ? off : "*"}-${off + rows.length - (total ? 1 : 0)}/${total}` });
  }
  send(404, { message: "not found" });
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/realtime/v1/websocket")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const mine = new Set<Sub>();
    ws.on("message", (raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(raw.toString());
      if (event === "phx_join") {
        const pg = (payload?.config?.postgres_changes ?? []) as { event: string; schema: string; table: string }[];
        const sub: Sub = { ws, topic, joinRef, filters: pg.map((f, i) => ({ id: i + 1 + subs.size * 10, table: f.table })) };
        subs.add(sub); mine.add(sub);
        ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: { postgres_changes: pg.map((f, i) => ({ ...f, id: sub.filters[i].id })) } }]));
      } else if (event === "heartbeat") ws.send(JSON.stringify([null, ref, "phoenix", "phx_reply", { status: "ok", response: {} }]));
      else if (event === "phx_leave") ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
      else ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
    });
    ws.on("close", () => { for (const s of mine) subs.delete(s); });
  });
});

await seed();
const { app } = await import("../main.ts");
serve({ fetch: app.fetch, port: API_PORT });
server.listen(SUPA_PORT, () => console.log(`e2e ready supabase=${SUPA_PORT} api=${API_PORT}`));
export { PASSWORD };
