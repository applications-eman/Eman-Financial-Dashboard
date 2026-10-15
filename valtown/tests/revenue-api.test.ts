import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { app } from "../main.ts";
import { signHs256 } from "../lib/jwt.ts";
import { setOdoo } from "../lib/odoo-factory.ts";
import { MemoryStore } from "../lib/store.ts";
import { verifyPeriod, quarterOf } from "../lib/verify.ts";
import { ENV, seedUsers, setup } from "./helpers.ts";

let store: MemoryStore;
let u: Awaited<ReturnType<typeof seedUsers>>;
const jwt = (sub: string) => signHs256({ sub, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, iss: `${ENV.SUPABASE_URL}/auth/v1`, email: "x@x.com" }, ENV.SUPABASE_JWT_SECRET);
const call = (method: string, path: string, sub: string, body?: unknown) =>
  app.request(path, { method, headers: { authorization: `Bearer ${jwt(sub)}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ADMIN = "aaaaaaaa-0000-0000-0000-000000000001";
const STAFF = "bbbbbbbb-0000-0000-0000-000000000002";
const ACC = "cccccccc-0000-0000-0000-000000000003";

beforeEach(async () => {
  store = setup(); u = await seedUsers(store); setOdoo(null);
  await store.insert("app_users", { auth_user_id: ACC, name: "Accounts", role: "accounts", sections: [], active: true });
});

describe("role gating", () => {
  it("accounts users can use /review but not /admin; staff can use neither", async () => {
    const a = (await store.insert("alerts", { rule_key: "credit_any", title: "t", fingerprint: "f1", severity: "warning" })) as any;
    assert.equal((await call("GET", "/admin/sync/status", ACC)).status, 403);
    assert.equal((await call("GET", "/admin/vat/payments", ACC)).status, 403);
    assert.equal((await call("PATCH", `/review/alerts/${a.row.id}`, STAFF, { status: "acknowledged", note: "ok" })).status, 403);
    assert.equal((await call("PATCH", `/review/alerts/${a.row.id}`, ACC, { status: "acknowledged", note: "checked with salesman" })).status, 200);
    assert.equal(store.tables.alerts[0].status, "acknowledged");
    assert.equal(store.tables.alerts[0].note, "checked with salesman");
  });
  it("acknowledging requires a note; reopening does not", async () => {
    const a = (await store.insert("alerts", { rule_key: "credit_any", title: "t", fingerprint: "f2" })) as any;
    assert.equal((await call("PATCH", `/review/alerts/${a.row.id}`, ADMIN, { status: "resolved" })).status, 422);
    assert.equal((await call("PATCH", `/review/alerts/${a.row.id}`, ADMIN, { status: "resolved", note: "fine" })).status, 200);
    assert.equal((await call("PATCH", `/review/alerts/${a.row.id}`, ADMIN, { status: "open" })).status, 200);
  });
  it("the Users API accepts the accounts role", async () => {
    const r = await call("POST", "/admin/users", ADMIN, { name: "Sara", role: "accounts", sections: [] });
    assert.ok([200, 201].includes(r.status), String(r.status));
  });
});

describe("VAT payments and grocery sales", () => {
  it("CRUD for payments", async () => {
    const c = await call("POST", "/admin/vat/payments", ADMIN, { period_year: 2025, period_quarter: 4, amount_paid: 12345.5, paid_on: "2026-01-28", reference: "SADAD 1" });
    assert.equal(c.status, 201);
    const id = (await c.json()).id;
    assert.equal((await call("PATCH", `/admin/vat/payments/${id}`, ADMIN, { amount_paid: 100 })).status, 200);
    assert.equal((await call("POST", "/admin/vat/payments", ADMIN, { period_year: 2025, period_quarter: 5, amount_paid: 1 })).status, 422);
    assert.equal(((await (await call("GET", "/admin/vat/payments", ADMIN)).json()) as any[]).length, 1);
    assert.equal((await call("DELETE", `/admin/vat/payments/${id}`, ADMIN)).status, 200);
  });
  it("grocery daily totals upsert by date and reject nonsense VAT", async () => {
    const day = { sale_date: "2026-10-14", net_sales: 1000, vat_amount: 150, invoice_count: 40 };
    assert.equal((await call("PUT", "/admin/grocery-sales", ADMIN, [day])).status, 200);
    assert.equal((await call("PUT", "/admin/grocery-sales", ADMIN, [{ ...day, net_sales: 1200, vat_amount: 180 }])).status, 200);
    assert.equal(store.tables.grocery_sales_daily.length, 1);
    assert.equal(store.tables.grocery_sales_daily[0].net_sales, 1200);
    assert.equal((await call("PUT", "/admin/grocery-sales", ADMIN, [{ ...day, vat_amount: 900 }])).status, 422);
  });
});

describe("verify", () => {
  const summary = (over = {}) => [{ bucket: "B2C", invoice_count: 2, net_sales: 200, vat: 30, total: 230, credit_count: 1, credit_net: 10, credit_vat: 1.5, credit_total: 11.5, ...over }];
  const odooWith = (inv: any, cn: any, edi: any[] = [{ edi_state: "sent", __count: 2 }]) => ({
    readGroup: async (_m: string, _d: unknown, f: string[], g: string[]) => (g[0] === "move_type" ? [{ move_type: "out_invoice", __count: inv.n, amount_untaxed: inv.net, amount_tax: inv.vat, amount_total: inv.net + inv.vat }, { move_type: "out_refund", __count: cn.n, amount_untaxed: cn.net, amount_tax: cn.vat, amount_total: cn.net + cn.vat }] : edi),
  }) as any;
  it("passes when Odoo and the dashboard agree, and stores the run", async () => {
    store.rpcHandlers.revenue_summary = () => summary();
    for (const id of [1, 2]) await store.insert("sales_invoices", { odoo_id: id, state: "posted", section: "bakery", invoice_date: "2026-10-10", zatca_state: "sent" });
    const r = await verifyPeriod(store, odooWith({ n: 2, net: 200, vat: 30 }, { n: 1, net: 10, vat: 1.5 }), "2026-10-01", "2026-10-31", "admin");
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.equal(r.vat.odoo_output_vat, 28.5);
    assert.equal(store.tables.verification_runs.length, 1);
  });
  it("flags a mismatch in VAT and in ZATCA status", async () => {
    store.rpc = async () => summary({ vat: 25 });
    for (const id of [1, 2]) await store.insert("sales_invoices", { odoo_id: id, state: "posted", section: "bakery", invoice_date: "2026-10-10", zatca_state: id === 1 ? "sent" : "to_send" });
    const r = await verifyPeriod(store, odooWith({ n: 2, net: 200, vat: 30 }, { n: 1, net: 10, vat: 1.5 }), "2026-10-01", "2026-10-31", "admin");
    assert.equal(r.ok, false);
    assert.ok(r.checks.some((c) => c.metric === "VAT on sales" && !c.ok));
    assert.ok(r.zatca.some((c) => !c.ok));
  });
  it("detects whole quarters", () => {
    assert.deepEqual(quarterOf("2026-10-01", "2026-12-31"), { year: 2026, quarter: 4 });
    assert.equal(quarterOf("2026-10-02", "2026-12-31"), null);
  });
  it("the verify endpoint needs Odoo configured and a valid period", async () => {
    assert.equal((await call("POST", "/admin/verify", ADMIN, { from: "2026-10-01", to: "2026-10-31" })).status, 422);
    setOdoo(odooWith({ n: 0, net: 0, vat: 0 }, { n: 0, net: 0, vat: 0 }, []));
    store.rpcHandlers.revenue_summary = () => [];
    assert.equal((await call("POST", "/admin/verify", ADMIN, { from: "bad", to: "2026-10-31" })).status, 422);
    const ok = await call("POST", "/admin/verify", ADMIN, { from: "2026-10-01", to: "2026-10-31" });
    assert.equal(ok.status, 200);
    setOdoo(null);
  });
});
