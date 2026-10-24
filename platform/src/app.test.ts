import { createApp } from "./app.ts";
import { signHs256 } from "./auth.ts";
import type { Row } from "./db.ts";
import { testDb } from "./test-db.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const SECRET = "test-secret";
const BASE = "https://auth.example.com";
const token = (email: string, sub = email) =>
  signHs256(
    { sub, email, aud: "authenticated", iss: `${BASE}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 600 },
    SECRET,
  );

async function setup() {
  const db = await testDb();
  await db.query(
    `insert into platform_admins (email, role) values ('boss@example.com','admin'), ('sup@example.com','supervisor')`,
  );
  const app = createApp({
    db,
    auth: { issuerBase: BASE, jwtSecret: SECRET, fetch },
    allowedOrigins: ["https://dash.example.com"],
    fetch: async () => new Response("ok", { status: 200 }),
  });
  const call = async (method: string, path: string, body?: unknown, who = "boss@example.com") => {
    const r = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token(who)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as Row };
  };
  return { db, app, call };
}

test("sign-in and roles", async () => {
  const { app, call } = await setup();
  assert.equal((await app.request("/admin/me")).status, 401);
  assert.equal((await app.request("/admin/me", { headers: { authorization: "Bearer junk" } })).status, 401);
  assert.equal((await call("GET", "/admin/me", undefined, "stranger@example.com")).status, 403);
  assert.equal((await call("GET", "/admin/me")).json.role, "admin");
  assert.equal((await call("GET", "/admin/salesmen", undefined, "sup@example.com")).status, 200);
  assert.equal((await call("POST", "/admin/categories", { name: "X" }, "sup@example.com")).status, 403);
  assert.equal((await app.request("/health")).status, 200);
});

test("services and numbers: safe address, one service per number", async () => {
  const { call } = await setup();
  assert.equal(
    (await call("POST", "/admin/targets", { id: "bad", name: "Bad", url: "http://x.example.com/w" })).status,
    400,
  );
  assert.equal(
    (await call("POST", "/admin/targets", { id: "bad", name: "Bad", url: "https://127.0.0.1/w" })).status,
    400,
  );
  const t = await call("POST", "/admin/targets", { id: "expense", name: "Expense", url: "https://e.example.com/w" });
  assert.equal(t.status, 201);
  assert.ok(t.json.secret.length >= 32);
  assert.equal(
    (await call("POST", "/admin/targets", { id: "expense", name: "Again", url: "https://e.example.com/w" })).status,
    409,
  );
  await call("POST", "/admin/targets", { id: "invoicing", name: "Invoicing", url: "https://i.example.com/w" });
  assert.equal((await call("POST", "/admin/numbers", { phone: "+966 50 000 0001", target_id: "expense" })).status, 201);
  const dup = await call("POST", "/admin/numbers", { phone: "966500000001", target_id: "invoicing" });
  assert.equal(dup.status, 409);
  assert.equal((await call("POST", "/admin/numbers", { phone: "12", target_id: "expense" })).status, 400);
  assert.equal((await call("DELETE", "/admin/targets/expense")).status, 409);
  assert.equal((await call("POST", "/admin/targets/expense/test")).json.reachable, true);
  const rot = await call("POST", "/admin/targets/expense/rotate-secret");
  assert.notEqual(rot.json.secret, t.json.secret);
  assert.equal((await call("DELETE", "/admin/numbers/966500000001")).status, 200);
  assert.equal((await call("DELETE", "/admin/targets/expense")).status, 200);
});

test("salesman lifecycle: create, activate, freeze, number follows", async () => {
  const { db, call } = await setup();
  const mk = { code: "FAIZAL-1", name: "Faizal", phone: "966500000001" };
  assert.equal((await call("POST", "/admin/salesmen", mk)).json.error, "no_invoicing_service");
  await call("POST", "/admin/targets", { id: "invoicing", name: "Invoicing", url: "https://i.example.com/w" });
  await call("POST", "/admin/targets", { id: "expense", name: "Expense", url: "https://e.example.com/w" });
  await call("POST", "/admin/numbers", { phone: "966500000009", target_id: "expense" });
  assert.equal((await call("POST", "/admin/salesmen", { ...mk, phone: "966500000009" })).json.error, "number_taken");
  const s = await call("POST", "/admin/salesmen", mk);
  assert.equal(s.status, 201);
  assert.equal(s.json.status, "inactive");
  assert.equal((await call("POST", "/admin/salesmen", { ...mk, code: "OTHER-1" })).status, 409);
  const id = s.json.id;
  const act = await call("POST", `/admin/salesmen/${id}/activate`);
  assert.equal(act.status, 200);
  assert.equal(act.json.warnings.length, 1);
  assert.equal((await db.query(`select enabled from wa_numbers where phone='966500000001'`))[0].enabled, true);
  assert.equal((await call("DELETE", `/admin/salesmen/${id}`)).json.error, "wrong_state");
  assert.equal((await call("POST", `/admin/salesmen/${id}/freeze`)).status, 200);
  assert.equal((await db.query(`select enabled from wa_numbers where phone='966500000001'`))[0].enabled, false);
  assert.equal((await call("POST", `/admin/salesmen/${id}/freeze`)).status, 409);
  assert.equal(
    (await call("PATCH", `/admin/salesmen/${id}`, { name: "Faizal K", daily_limit: 80 })).json.daily_limit,
    80,
  );
  assert.equal((await call("PATCH", "/admin/salesmen/not-a-uuid", { name: "x" })).status, 400);
  assert.equal((await call("DELETE", `/admin/salesmen/${id}`)).status, 200);
  assert.equal((await db.query(`select count(*)::int n from wa_numbers where phone='966500000001'`))[0].n, 0);
});

test("customers and assignments", async () => {
  const { call } = await setup();
  await call("POST", "/admin/targets", { id: "invoicing", name: "Invoicing", url: "https://i.example.com/w" });
  const s = (await call("POST", "/admin/salesmen", { code: "A-1", name: "A", phone: "966500000001" })).json;
  assert.equal((await call("POST", "/admin/customers", { name: "Bad VAT", vat: "123" })).status, 400);
  const c1 = (await call("POST", "/admin/customers", { name: "Al Noor", vat: "300000000000003" })).json;
  const c2 = (await call("POST", "/admin/customers", { name: "Baraka" })).json;
  assert.equal(
    (await call("PUT", `/admin/salesmen/${s.id}/customers`, { customer_ids: [c1.id, c2.id] })).json.count,
    2,
  );
  assert.equal(
    (
      await call("PUT", `/admin/salesmen/${s.id}/customers`, {
        customer_ids: [c1.id, "00000000-0000-4000-8000-000000000000"],
      })
    ).status,
    400,
  );
  assert.equal((await call("PUT", `/admin/salesmen/${s.id}/customers`, { customer_ids: [c1.id] })).json.count, 1);
  assert.equal((await call("GET", `/admin/salesmen/${s.id}/customers`)).json.length, 1);
  assert.equal((await call("GET", "/admin/customers?q=noor")).json.length, 1);
  assert.equal((await call("PATCH", `/admin/customers/${c1.id}`, { status: "frozen" })).json.status, "frozen");
});

test("products: price limit history, bulk upload, settings, audit", async () => {
  const { call } = await setup();
  const cat = (await call("POST", "/admin/categories", { name: "Bread" })).json;
  assert.equal((await call("POST", "/admin/categories", { name: "Bread" })).status, 409);
  const p = (await call("POST", "/admin/products", { name: "Samoon", category_id: cat.id, max_price: 1.5 })).json;
  assert.equal((await call("POST", "/admin/products", { name: "Neg", max_price: -1 })).status, 400);
  assert.equal((await call("POST", "/admin/products", { name: "Odd", max_price: 1.234 })).status, 400);
  await call("PATCH", `/admin/products/${p.id}`, { max_price: 1.75 });
  await call("PATCH", `/admin/products/${p.id}`, { max_price: 1.75 });
  assert.equal((await call("GET", `/admin/products/${p.id}/history`)).json.length, 2);
  const bulk = await call("POST", "/admin/products/bulk", {
    rows: [
      { name: "samoon", category: "Bread", max_price: 2 },
      { name: "Croissant", category: "Pastry", max_price: 3 },
    ],
  });
  assert.deepEqual(bulk.json, { created: 1, updated: 1, priceChanges: 1 });
  assert.equal((await call("GET", "/admin/products")).json.length, 2);
  assert.equal((await call("PUT", "/admin/settings/duplicate_window_minutes", { value: 45 })).status, 200);
  assert.equal((await call("PUT", "/admin/settings/duplicate_window_minutes", { value: "x" })).status, 400);
  assert.equal((await call("PUT", "/admin/settings/nope", { value: 1 })).status, 404);
  assert.equal((await call("GET", "/admin/settings")).json.duplicate_window_minutes, 45);
  const audit = (await call("GET", "/admin/audit")).json;
  assert.ok(audit.length >= 6);
  assert.ok(audit.every((a: Row) => a.actor === "boss@example.com"));
  assert.equal((await call("GET", "/admin/summary")).json.products_active, 2);
});

test("settings: test mode is on until switched off", async () => {
  const { call } = await setup();
  assert.equal((await call("GET", "/admin/settings")).json.test_mode, true);
  assert.equal((await call("PUT", "/admin/settings/test_mode", { value: false })).status, 200);
  assert.equal((await call("GET", "/admin/settings")).json.test_mode, false);
  assert.equal((await call("PUT", "/admin/settings/test_mode", { value: "no" })).status, 400);
});

test("default service: only one at a time", async () => {
  const { call } = await setup();
  await call("POST", "/admin/targets", { id: "expense", name: "Expense", url: "https://e.example.com/w" });
  await call("POST", "/admin/targets", { id: "invoicing", name: "Invoicing", url: "https://i.example.com/w" });
  assert.equal((await call("PATCH", "/admin/targets/expense", { is_default: true })).json.is_default, true);
  assert.equal((await call("PATCH", "/admin/targets/invoicing", { is_default: true })).json.is_default, true);
  const list = (await call("GET", "/admin/targets")).json as { id: string; is_default: boolean }[];
  assert.deepEqual(
    list.filter((x) => x.is_default).map((x) => x.id),
    ["invoicing"],
  );
  assert.equal((await call("PATCH", "/admin/targets/invoicing", { is_default: false })).json.is_default, false);
});

test("validation: no duplicate customers, products, categories or services; VAT rules; tidy names", async () => {
  const { call } = await setup();
  const a = await call("POST", "/admin/customers", { name: "  Al   Noor  ", vat: "300123456700003" });
  assert.equal(a.status, 201);
  assert.equal(a.json.name, "Al Noor", "extra spaces are removed");
  const dupName = await call("POST", "/admin/customers", { name: "al noor" });
  assert.equal(dupName.status, 409);
  assert.match(dupName.json.message, /already exists/);
  assert.equal((await call("POST", "/admin/customers", { name: "Other", vat: "300123456700003" })).status, 409); // same VAT
  assert.equal((await call("POST", "/admin/customers", { name: "Bad VAT", vat: "123456789012345" })).status, 400); // must start and end with 3
  assert.equal((await call("POST", "/admin/customers", { name: "Short VAT", vat: "3001234567" })).status, 400);
  const b = (await call("POST", "/admin/customers", { name: "Baraka" })).json;
  assert.equal((await call("PATCH", `/admin/customers/${b.id}`, { name: "AL NOOR" })).status, 409);
  assert.equal((await call("PATCH", `/admin/customers/${b.id}`, { name: "Baraka Mart" })).status, 200);
  assert.equal((await call("PATCH", `/admin/customers/${b.id}`, { vat: "300123456700003" })).status, 409);

  assert.equal((await call("POST", "/admin/categories", { name: "Bread" })).status, 201);
  assert.equal((await call("POST", "/admin/categories", { name: " bread " })).status, 409);
  const p = (await call("POST", "/admin/products", { name: "Samoon", max_price: 2 })).json;
  assert.equal((await call("POST", "/admin/products", { name: "SAMOON" })).status, 409);
  assert.equal((await call("PATCH", `/admin/products/${p.id}`, { name: "samoon" })).status, 200); // its own name is fine
  // bulk upload keeps one category whatever the capitals
  await call("POST", "/admin/products/bulk", { rows: [{ name: "Chapathi", category: "BREAD", max_price: 3 }] });
  assert.equal(((await call("GET", "/admin/categories")).json as unknown[]).length, 1);

  await call("POST", "/admin/targets", { id: "expense", name: "Expense", url: "https://e.example.com/w" });
  assert.equal(
    (await call("POST", "/admin/targets", { id: "expense2", name: "expense", url: "https://e.example.com/w" })).status,
    409,
  );

  // a customer added by mistake can be deleted
  assert.equal((await call("DELETE", `/admin/customers/${b.id}`)).status, 200);
  assert.equal((await call("DELETE", `/admin/customers/${b.id}`)).status, 404);
  assert.equal((await call("DELETE", `/admin/products/${p.id}`)).status, 200);
});

test("product pictures: only small JPEG/PNG, shown in the list, removable, audited", async () => {
  const { call, db } = await setup();
  const made = await call("POST", "/admin/products/bulk", {
    rows: [{ name: "Shami", category: "Bread", max_price: 4.5 }],
  });
  assert.equal(made.status, 200);
  const [p] = await db.query(`select id from products where name='Shami'`);
  // a real (tiny) JPEG header and a real PNG header are accepted
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");
  assert.equal((await call("PUT", `/admin/products/${p.id}/image`, { image: jpeg })).status, 200);
  assert.equal((await call("PUT", `/admin/products/${p.id}/image`, { image: png })).status, 200);
  const list = await call("GET", "/admin/products");
  assert.equal((list.json as unknown as { image: string }[])[0].image, png);
  // not a picture, too big, unknown product, read-only role
  const text = Buffer.from("hello world").toString("base64");
  assert.equal((await call("PUT", `/admin/products/${p.id}/image`, { image: text })).status, 400);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(25_000)]).toString("base64");
  assert.equal((await call("PUT", `/admin/products/${p.id}/image`, { image: big })).status, 400);
  assert.equal(
    (await call("PUT", "/admin/products/00000000-0000-4000-8000-000000000000/image", { image: jpeg })).status,
    404,
  );
  assert.equal((await call("PUT", `/admin/products/${p.id}/image`, { image: jpeg }, "sup@example.com")).status, 403);
  assert.equal((await call("DELETE", `/admin/products/${p.id}/image`)).status, 200);
  assert.equal(((await call("GET", "/admin/products")).json as unknown as { image: string | null }[])[0].image, null);
  const log = await db.query(
    `select action from audit_log where entity='product' and action like '%image%' order by id`,
  );
  assert.deepEqual(
    log.map((r) => r.action),
    ["set_image", "set_image", "remove_image"],
  );
});

test("sample data: only in test mode, adds TEST customers and products once, gives them to active salesmen", async () => {
  const { call, db } = await setup();
  await db
    .query(`insert into wa_numbers (phone) values ('966500000099') on conflict do nothing`)
    .catch(() => undefined);
  const first = await call("POST", "/admin/sample-data");
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { customers: 7, products: 20 });
  const again = await call("POST", "/admin/sample-data");
  assert.deepEqual(again.json, { customers: 0, products: 0 });
  const [{ n: cats }] = await db.query(`select count(*)::int n from product_categories where name like 'TEST %'`);
  assert.equal(cats, 4);
  // never when real invoicing is on
  await db.query(
    `insert into platform_settings (key, value) values ('test_mode','false') on conflict (key) do update set value = excluded.value`,
  );
  assert.equal((await call("POST", "/admin/sample-data")).status, 409);
  // a supervisor cannot add data
  await db.query(`update platform_settings set value='true' where key='test_mode'`);
  assert.equal((await call("POST", "/admin/sample-data", undefined, "sup@example.com")).status, 403);
});
