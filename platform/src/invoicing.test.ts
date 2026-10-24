import { createApp } from "./app.ts";
import { signHs256 } from "./auth.ts";
import type { Row } from "./db.ts";
import { handleFlow } from "./invoicing/flow.ts";
import { buildFlowJson } from "./invoicing/flow-json.ts";
import { submitRequest } from "./invoicing/intake.ts";
import { OdooError } from "./invoicing/odoo.ts";
import { queueHealth, sweepStuck } from "./invoicing/ops.ts";
import type { InvoicingDeps } from "./invoicing/routes.ts";
import { TEST_TAG, TestModeWa } from "./invoicing/wa.ts";
import { handleInvoicingWebhook } from "./invoicing/webhook.ts";
import { drain, TEST_NOTE, type WorkerDeps } from "./invoicing/worker.ts";
import { testDb } from "./test-db.ts";
import { FakeOdoo } from "./test-odoo.ts";
import { FakeWa, lastSent } from "./test-wa.ts";
import assert from "node:assert/strict";
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHmac,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PHONE = "966500000001";

async function world() {
  const db = await testDb();
  const odoo = new FakeOdoo();
  const wa = new FakeWa();
  await db.query(
    `insert into wa_targets (id, name, url, secret) values ('invoicing','Invoicing','https://i.example.com/w','router-secret')`,
  );
  await db.query(`insert into wa_numbers (phone, target_id) values ($1,'invoicing')`, [PHONE]);
  const [s] = await db.query(
    `insert into salesmen (code, name, phone, status) values ('FAIZAL-1','Faizal',$1,'active') returning id`,
    [PHONE],
  );
  const [c] = await db.query(
    `insert into customers (name, odoo_partner_id) values ('Al Noor Supermarket', 7) returning id`,
  );
  await db.query(`insert into salesman_customers (salesman_id, customer_id) values ($1,$2)`, [s.id, c.id]);
  const [k] = await db.query(`insert into product_categories (name) values ('Shami') returning id`);
  const [p] = await db.query(
    `insert into products (name, category_id, max_price, odoo_product_id) values ('SHAMI - 5', $1, 4.50, 70) returning id`,
    [k.id],
  );
  const worker: WorkerDeps = {
    db,
    odoo,
    wa,
    salesJournalId: 23,
    workerId: "w1",
    today: () => "2026-10-22",
    pendingRetrySeconds: 30,
  };
  return {
    db,
    odoo,
    wa,
    worker,
    salesman: s.id as string,
    customer: c.id as string,
    category: k.id as string,
    product: p.id as string,
  };
}
type World = Awaited<ReturnType<typeof world>>;

async function session(w: World, token = "tok1") {
  await w.db.query(
    `insert into flow_sessions (token, salesman_id, expires_at) values ($1,$2, now() + interval '30 minutes')`,
    [token, w.salesman],
  );
  return token;
}

/** adds one product to the cart, then opens the cart like a tap on "Open cart" */
async function addToCart(db: World["db"], token: string, data: Record<string, unknown>) {
  const added = await handleFlow(db, {
    action: "data_exchange",
    flow_token: token,
    data: { action: "add_item", ...data },
  });
  if (added.data.error_message) return added;
  return handleFlow(db, { action: "data_exchange", flow_token: token, data: { action: "open_cart" } });
}

/** walks the Flow like the phone does and confirms */
async function placeOrder(w: World, token: string, qty = "20", price = "4.35") {
  const init = await handleFlow(w.db, { action: "INIT", flow_token: token });
  assert.equal(init.screen, "CUSTOMER");
  await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: token,
    data: { action: "select_customer", customer: w.customer },
  });
  const items = await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: token,
    data: { action: "select_category", category: w.category },
  });
  assert.equal((items.data.products as unknown[]).length, 1);
  const review = await addToCart(w.db, token, { category: w.category, product: w.product, qty, price });
  assert.equal(review.screen, "REVIEW", JSON.stringify(review.data));
  return handleFlow(w.db, { action: "data_exchange", flow_token: token, data: { action: "confirm" } });
}

test("webhook: unknown, inactive, media, kill switch, and the Flow button", async () => {
  const w = await world();
  const d = { db: w.db, wa: w.wa, odoo: w.odoo };
  const text = (from: string) => ({
    entry: [{ changes: [{ value: { messages: [{ from, id: "m", type: "text", text: { body: "hi" } }] } }] }],
  });
  await handleInvoicingWebhook(d, text("966511111111"));
  assert.match(lastSent(w.wa).text, /not registered/);
  await w.db.query(`update salesmen set status='frozen'`);
  await handleInvoicingWebhook(d, text(PHONE));
  assert.match(lastSent(w.wa).text, /not active/);
  await w.db.query(`update salesmen set status='active'`);
  await handleInvoicingWebhook(d, {
    entry: [{ changes: [{ value: { messages: [{ from: PHONE, id: "m2", type: "image" }] } }] }],
  });
  assert.match(lastSent(w.wa).text, /use the invoice button/);
  await w.db.query(`update platform_settings set value='true' where key='kill_switch'`);
  await handleInvoicingWebhook(d, text(PHONE));
  assert.match(lastSent(w.wa).text, /paused/);
  await w.db.query(`update platform_settings set value='false' where key='kill_switch'`);
  await handleInvoicingWebhook(d, text(PHONE));
  const flow = lastSent(w.wa);
  assert.equal(flow.kind, "flow");
  assert.match(flow.text, /Hello Faizal/);
  const [{ n }] = await w.db.query(`select count(*)::int n from flow_sessions where token=$1`, [flow.extra]);
  assert.equal(n, 1);
});

test("flow: customer list, price rules, cart, review, confirm once", async () => {
  const w = await world();
  const t = await session(w);
  const init = await handleFlow(w.db, { action: "INIT", flow_token: t });
  assert.deepEqual(
    (init.data.customers as { title: string }[]).map((x) => x.title),
    ["Al Noor Supermarket"],
  );
  assert.match(String((await handleFlow(w.db, { action: "INIT", flow_token: "nope" })).data.error_message), /expired/);
  assert.equal((await handleFlow(w.db, { action: "ping" })).data.status, "active");

  // a customer that is not his is refused
  const [other] = await w.db.query(`insert into customers (name, odoo_partner_id) values ('Stranger', 8) returning id`);
  const bad = await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t,
    data: { action: "select_customer", customer: other.id },
  });
  assert.equal(bad.screen, "CUSTOMER");
  assert.match(String(bad.data.error_message), /not allowed/);
  await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t,
    data: { action: "select_customer", customer: w.customer },
  });

  const add = (o: Record<string, string>) =>
    handleFlow(w.db, {
      action: "data_exchange",
      flow_token: t,
      data: {
        action: "add_item",
        category: w.category,
        product: w.product,
        qty: "10",
        price: "4.00",
        ...o,
      },
    });
  assert.match(String((await add({ qty: "0" })).data.error_message), /greater than zero/);
  assert.match(String((await add({ price: "abc" })).data.error_message), /valid price/);
  assert.match(String((await add({ price: "4.51" })).data.error_message), /maximum allowed is 4.50/);
  assert.equal((await add({ price: "4.50" })).screen, "ITEMS"); // exactly the limit is fine
  // remove the product that was just added (it is the only one), then build the real cart
  const removed = await handleFlow(w.db, { action: "data_exchange", flow_token: t, data: { action: "remove_last" } });
  assert.match(String(removed.data.review_text), /empty/);
  await add({});
  // the same product cannot be added twice, not even with another price, and it leaves the product list
  const dup = await add({ qty: "5", price: "4.20" });
  assert.match(String(dup.data.error_message), /already in the cart/);
  assert.equal((dup.data.products as { id: string }[])[0].id, "none");
  const [second] = await w.db.query(
    `insert into products (name, category_id, max_price, odoo_product_id) values ('SHAMI - 10', $1, 8.50, 71) returning id`,
    [w.category],
  );
  await add({ product: second.id, qty: "5", price: "4.20" });
  const rev = await handleFlow(w.db, { action: "data_exchange", flow_token: t, data: { action: "open_cart" } });
  assert.equal(rev.screen, "REVIEW");
  assert.match(String(rev.data.review_text), /Before VAT: {2}61\.00\nVAT 15%: {2}9\.15\nTOTAL: {2}70\.15 SAR/);

  const done = await handleFlow(w.db, { action: "data_exchange", flow_token: t, data: { action: "confirm" } });
  assert.equal(done.screen, "SUCCESS");
  const again = await handleFlow(w.db, { action: "data_exchange", flow_token: t, data: { action: "confirm" } });
  assert.equal(again.screen, "SUCCESS");
  const [{ n }] = await w.db.query(`select count(*)::int n from invoice_requests`);
  assert.equal(n, 1);
});

test("intake: server re-checks prices, links, duplicates and limits", async () => {
  const w = await world();
  const t = await session(w);
  await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t,
    data: { action: "select_customer", customer: w.customer },
  });
  await addToCart(w.db, t, {
    category: w.category,
    product: w.product,
    qty: "2",
    price: "4.00",
  });
  // the limit was lowered after the salesman typed his price
  await w.db.query(`update products set max_price = 3.50`);
  const low = await submitRequest(w.db, t);
  assert.equal(low.ok, false);
  assert.equal(!low.ok && low.code, "M07");
  await w.db.query(`update products set max_price = 4.50`);
  await w.db.query(`update customers set odoo_partner_id = null`);
  assert.equal((await submitRequest(w.db, t)).ok, false);
  await w.db.query(`update customers set odoo_partner_id = 7`);
  await w.db.query(`update platform_settings set value='true' where key='kill_switch'`);
  const killed = await submitRequest(w.db, t);
  assert.equal(!killed.ok && killed.code, "M31");
  await w.db.query(`update platform_settings set value='false' where key='kill_switch'`);
  const ok = await submitRequest(w.db, t);
  assert.ok(ok.ok && ok.kind === "queued" && ok.position === 1);

  // the same invoice again with a new session: needs approval
  const t2 = await session(w, "tok2");
  await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t2,
    data: { action: "select_customer", customer: w.customer },
  });
  await addToCart(w.db, t2, {
    category: w.category,
    product: w.product,
    qty: "2",
    price: "4.00",
  });
  const dup = await submitRequest(w.db, t2);
  assert.ok(dup.ok && dup.kind === "approval");
  assert.equal((await w.db.query(`select count(*)::int n from approvals`))[0].n, 1);

  // daily limit
  await w.db.query(`update salesmen set daily_limit = 1`);
  const t3 = await session(w, "tok3");
  await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t3,
    data: { action: "select_customer", customer: w.customer },
  });
  await addToCart(w.db, t3, {
    category: w.category,
    product: w.product,
    qty: "1",
    price: "1.00",
  });
  const lim = await submitRequest(w.db, t3);
  assert.equal(!lim.ok && lim.code, "M23");
});

async function queued(w: World, qty = "20", price = "4.35", token = "tok1") {
  const t = await session(w, token);
  await placeOrder(w, t, qty, price);
  const [r] = await w.db.query(`select id, ref_code from invoice_requests where request_key = $1`, [`flow:${t}`]);
  return r as { id: string; ref_code: string };
}

test("worker: invoice is created, posted, cleared, PDF delivered, once, and left unpaid (credit)", async () => {
  const w = await world();
  const r = await queued(w);
  assert.equal(await drain(w.worker), 1);
  const [row] = await w.db.query(
    `select status, invoice_number, zatca_status, zatca_uuid, odoo_move_id from invoice_requests where id=$1`,
    [r.id],
  );
  assert.equal(row.status, "cleared");
  assert.match(row.invoice_number, /^INV\/2026\//);
  assert.equal(row.zatca_status, "accepted");
  assert.deepEqual(w.odoo.calls, ["create", "post", "send", "pdf"]);
  assert.equal(w.odoo.moves[0].ref, `WA-${r.ref_code}`);
  assert.equal(w.odoo.moves[0].paid, false, "no payment is recorded on credit invoices");
  const doc = w.wa.sent.find((m) => m.kind === "document");
  assert.ok(doc);
  assert.match(doc.text, /ZATCA cleared/);
  assert.equal(doc.to, PHONE);
  // running again changes nothing
  assert.equal(await drain(w.worker), 0);
  assert.equal(w.odoo.moves.length, 1);
});

test("worker: payment is recorded only when a cash journal is configured", async () => {
  const w = await world();
  w.worker.cashJournalId = 9;
  await queued(w);
  await drain(w.worker);
  assert.deepEqual(w.odoo.calls, ["create", "post", "send", "pay", "pdf"]);
  assert.equal(w.odoo.moves[0].paid, true);
});

test("worker: a crash or timeout in the middle never makes a second invoice", async () => {
  const w = await world();
  const r = await queued(w);
  w.odoo.failNext.post = new OdooError("timeout", 0, true);
  await drain(w.worker);
  assert.equal((await w.db.query(`select status from invoice_requests where id=$1`, [r.id]))[0].status, "processing");
  assert.match(lastSent(w.wa).text, /system is busy/);
  await w.db.query(`update invoice_requests set lease_until = now() - interval '1 second' where id=$1`, [r.id]);
  await drain(w.worker);
  assert.equal((await w.db.query(`select status from invoice_requests where id=$1`, [r.id]))[0].status, "cleared");
  assert.equal(w.odoo.moves.length, 1);

  // the process died after Odoo created the invoice but before we noted it: found again by its reference
  const r2 = await queued(w, "3", "4.00", "tok2");
  await w.odoo.createDraftInvoice({
    partnerId: 7,
    ref: `WA-${r2.ref_code}`,
    origin: "x",
    date: "2026-10-22",
    lines: [{ productId: 70, name: "SHAMI - 5", quantity: 3, priceUnit: 4 }],
  });
  const before = w.odoo.moves.length;
  await drain(w.worker);
  assert.equal(w.odoo.moves.length, before);
  assert.equal((await w.db.query(`select status from invoice_requests where id=$1`, [r2.id]))[0].status, "cleared");
});

test("worker: ZATCA rejects, pending, wrong amount, bad key", async () => {
  const w = await world();
  // rejected
  w.odoo.zatca = "rejected";
  w.odoo.zatcaText = "Invalid buyer address";
  const r1 = await queued(w);
  await drain(w.worker);
  const [a] = await w.db.query(`select status, error_detail from invoice_requests where id=$1`, [r1.id]);
  assert.equal(a.status, "rejected");
  assert.match(lastSent(w.wa).text, /ZATCA did not accept this invoice\. Reason: Invalid buyer address/);

  // pending: told once, tried again, finally cleared
  w.odoo.zatca = "pending";
  const r2 = await queued(w, "2", "4.00", "tok2");
  await drain(w.worker);
  assert.equal((await w.db.query(`select status from invoice_requests where id=$1`, [r2.id]))[0].status, "processing");
  assert.ok(w.wa.sent.some((m) => /Waiting for ZATCA clearance/.test(m.text)));
  w.odoo.zatca = "accepted";
  await w.db.query(`update invoice_requests set lease_until = now() - interval '1 second' where id=$1`, [r2.id]);
  await drain(w.worker);
  assert.equal((await w.db.query(`select status from invoice_requests where id=$1`, [r2.id]))[0].status, "cleared");
  assert.equal(w.odoo.moves.filter((m) => m.ref === `WA-${r2.ref_code}`).length, 1);

  // Odoo computes a different amount: nothing is posted
  w.odoo.skew = 5;
  const r3 = await queued(w, "1", "4.00", "tok3");
  const postsBefore = w.odoo.calls.filter((c) => c === "post").length;
  await drain(w.worker);
  const [c3] = await w.db.query(`select status, error_code from invoice_requests where id=$1`, [r3.id]);
  assert.deepEqual([c3.status, c3.error_code], ["failed", "total_mismatch"]);
  assert.equal(w.odoo.calls.filter((c) => c === "post").length, postsBefore);
  assert.match(lastSent(w.wa).text, /was not issued/);
  w.odoo.skew = 0;

  // Odoo left the VAT off the lines: the total differs from what the salesman saw, so nothing is posted
  w.odoo.vat = 0;
  const r3b = await queued(w, "1", "4.00", "tok3b");
  const postsBefore2 = w.odoo.calls.filter((c) => c === "post").length;
  await drain(w.worker);
  const [c3b] = await w.db.query(`select status, error_code from invoice_requests where id=$1`, [r3b.id]);
  assert.deepEqual([c3b.status, c3b.error_code], ["failed", "vat_mismatch"]);
  assert.match(lastSent(w.wa).text, /Reason: the VAT calculated in Odoo does not match/);
  assert.equal(w.odoo.calls.filter((c) => c === "post").length, postsBefore2);
  w.odoo.vat = 0.15;

  // wrong key: fails at once, honest message
  w.odoo.failNext.create = new OdooError("Invalid apikey", 401, false);
  const r4 = await queued(w, "1", "3.00", "tok4");
  await drain(w.worker);
  const [d4] = await w.db.query(`select status, error_code from invoice_requests where id=$1`, [r4.id]);
  assert.deepEqual([d4.status, d4.error_code], ["failed", "odoo_auth"]);
  // an admin retries it: works now
  assert.equal(
    (await w.db.query(`update invoice_requests set status='queued' where id=$1 returning id`, [r4.id])).length,
    1,
  );
  await drain(w.worker);
  assert.equal((await w.db.query(`select status from invoice_requests where id=$1`, [r4.id]))[0].status, "cleared");
});

test("worker: one at a time, oldest first, pauses on the kill switch", async () => {
  const w = await world();
  const a = await queued(w, "1", "1.00", "tokA");
  const b = await queued(w, "2", "1.00", "tokB");
  await w.db.query(`update invoice_requests set created_at = now() - interval '5 minutes' where id=$1`, [b.id]);
  await w.db.query(`update platform_settings set value='true' where key='kill_switch'`);
  assert.equal(await drain(w.worker), 0);
  await w.db.query(`update platform_settings set value='false' where key='kill_switch'`);
  // another holder has the lock: this worker does nothing
  await w.db.query(
    `insert into worker_locks (name, holder, lease_until) values ('odoo-invoicing','other', now() + interval '1 minute')`,
  );
  assert.equal(await drain(w.worker), 0);
  await w.db.query(`delete from worker_locks`);
  assert.equal(await drain(w.worker), 2);
  assert.equal(w.odoo.moves[0].ref, `WA-${b.ref_code}`);
  assert.equal(w.odoo.moves[1].ref, `WA-${a.ref_code}`);
});

// ---------------------------------------------------------------- HTTP: router webhook, encrypted Flow endpoint, tick, admin

const SECRET = "test-secret";
const BASE = "https://auth.example.com";
const token = (email: string) =>
  signHs256(
    { sub: email, email, aud: "authenticated", iss: `${BASE}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 600 },
    SECRET,
  );

async function httpWorld() {
  const w = await world();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let kicked = 0;
  const inv: InvoicingDeps = {
    odoo: w.odoo,
    wa: w.wa,
    flowKey: privateKey,
    appSecret: "app-secret",
    tickSecret: "tick",
    kick: () => void kicked++,
    drainNow: () => drain(w.worker),
  };
  const app = createApp({
    db: w.db,
    auth: { issuerBase: BASE, jwtSecret: SECRET, fetch },
    allowedOrigins: [],
    invoicing: inv,
  });
  await w.db.query(
    `insert into platform_admins (email, role) values ('boss@example.com','admin'), ('sup@example.com','supervisor')`,
  );
  return { ...w, app, publicKey, kicks: () => kicked };
}

function encryptRequest(publicKey: import("node:crypto").KeyObject, payload: unknown) {
  const aes = randomBytes(16);
  const iv = randomBytes(16);
  const c = createCipheriv("aes-128-gcm", aes, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final(), c.getAuthTag()]);
  return {
    aes,
    iv,
    body: JSON.stringify({
      encrypted_flow_data: enc.toString("base64"),
      encrypted_aes_key: publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        aes,
      ).toString("base64"),
      initial_vector: iv.toString("base64"),
    }),
  };
}
function decryptResponse(text: string, aes: Buffer, iv: Buffer) {
  const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
  const data = Buffer.from(text, "base64");
  const d = createDecipheriv("aes-128-gcm", aes, flipped);
  d.setAuthTag(data.subarray(data.length - 16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString());
}

test("http: router secret, encrypted Flow endpoint, tick", async () => {
  const w = await httpWorld();
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    w.app.request(path, { method: "POST", body, headers });

  const hook = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ from: PHONE, id: "m1", type: "text" }] } }] }],
  });
  assert.equal((await post("/invoicing/webhook", hook)).status, 401);
  assert.equal((await post("/invoicing/webhook", hook, { "x-router-secret": "wrong" })).status, 401);
  assert.equal(
    (await post("/invoicing/webhook", hook, { "x-router-secret": "router-secret", "content-type": "application/json" }))
      .status,
    200,
  );
  const flow = w.wa.sent.find((m) => m.kind === "flow");
  assert.ok(flow);

  const sign = (raw: string) => `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}`;
  const req = encryptRequest(w.publicKey, { version: "3.0", action: "INIT", flow_token: flow.extra });
  assert.equal((await post("/invoicing/flow", req.body, { "x-hub-signature-256": "sha256=bad" })).status, 432);
  assert.equal(
    (
      await post(
        "/invoicing/flow",
        JSON.stringify({ encrypted_flow_data: "AA==", encrypted_aes_key: "AA==", initial_vector: "AA==" }),
        {
          "x-hub-signature-256": sign(
            JSON.stringify({ encrypted_flow_data: "AA==", encrypted_aes_key: "AA==", initial_vector: "AA==" }),
          ),
        },
      )
    ).status,
    421,
  );
  const res = await post("/invoicing/flow", req.body, { "x-hub-signature-256": sign(req.body) });
  assert.equal(res.status, 200);
  const out = decryptResponse(await res.text(), req.aes, req.iv);
  assert.equal(out.screen, "CUSTOMER");
  assert.equal(out.data.customers[0].title, "Al Noor Supermarket");

  const ping = encryptRequest(w.publicKey, { version: "3.0", action: "ping" });
  const pr = await post("/invoicing/flow", ping.body, { "x-hub-signature-256": sign(ping.body) });
  assert.equal(decryptResponse(await pr.text(), ping.aes, ping.iv).data.status, "active");

  assert.equal((await post("/internal/tick", "")).status, 401);
  await queued(w, "1", "1.00", "tokT");
  const tick = await post("/internal/tick", "", { "x-tick-secret": "tick" });
  assert.equal((await tick.json()).handled, 1);
  assert.ok(w.kicks() >= 1);
});

test("admin: link to Odoo, requests list, approvals by a supervisor, retry", async () => {
  const w = await httpWorld();
  const call = async (method: string, path: string, body?: unknown, who = "boss@example.com") => {
    const r = await w.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token(who)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as Row };
  };
  assert.equal((await call("GET", "/admin/odoo/status")).json.company, "Eman Bakery (test)");

  await w.db.query(`insert into customers (name, vat) values ('Needs link', '300000000000003'), ('Unknown One', null)`);
  w.odoo.partners.set("300000000000003", 55);
  await w.db.query(`insert into products (name) values ('Samoon'), ('No match')`);
  w.odoo.products.set("samoon", 99);
  const link = await call("POST", "/admin/odoo/link");
  assert.deepEqual([link.json.customers.linked, link.json.customers.unmatched], [1, ["Unknown One"]]);
  assert.deepEqual([link.json.products.linked, link.json.products.unmatched], [1, ["No match"]]);

  // a repeat of the same invoice waits for a supervisor
  const first = await queued(w, "2", "4.00", "t1");
  const t2 = await session(w, "t2");
  await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t2,
    data: { action: "select_customer", customer: w.customer },
  });
  await addToCart(w.db, t2, {
    category: w.category,
    product: w.product,
    qty: "2",
    price: "4.00",
  });
  await handleFlow(w.db, { action: "data_exchange", flow_token: t2, data: { action: "confirm" } });
  const approvals = (await call("GET", "/admin/approvals", undefined, "sup@example.com")).json;
  assert.equal(approvals.length, 1);
  assert.equal(
    (await call("POST", `/admin/approvals/${approvals[0].id}/decide`, { decision: "approved" }, "sup@example.com"))
      .status,
    200,
  );
  assert.equal(
    (await call("POST", `/admin/approvals/${approvals[0].id}/decide`, { decision: "approved" })).status,
    409,
  );
  assert.match(lastSent(w.wa).text, /supervisor approved/);
  assert.equal(await drain(w.worker), 2);
  assert.equal((await call("GET", "/admin/requests?status=cleared")).json.length, 2);
  assert.equal((await call("POST", `/admin/requests/${first.id}/retry`)).status, 409);
  assert.equal((await call("POST", `/admin/requests/${first.id}/retry`, undefined, "sup@example.com")).status, 403);
  assert.equal((await call("GET", `/admin/requests/${first.id}/events`)).json.length > 3, true);
});

test("the Flow definition follows Meta's rules", () => {
  const f = buildFlowJson();
  const ids = f.screens.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes("SUCCESS"), "SUCCESS is reserved by Meta");
  assert.deepEqual(Object.keys(f.routing_model).sort(), [...ids].sort());
  const order = new Map(ids.map((id, i) => [id, i]));
  for (const [from, tos] of Object.entries(f.routing_model))
    for (const to of tos)
      assert.ok(Number(order.get(to)) > Number(order.get(from)), `route ${from}->${to} must go forward`);
  for (const s of f.screens) {
    const names = new Set<string>(); // field names only have to be unique within one screen
    const kids = s.layout.children as { type: string; name?: string }[];
    assert.equal(kids.filter((k) => k.type === "Footer").length, 1, `${s.id} needs one Footer`);
    for (const k of kids)
      if (k.name) {
        assert.ok(!names.has(k.name), `duplicate field name ${k.name}`);
        names.add(k.name);
      }
  }
  assert.equal(f.screens.filter((s) => (s as { terminal?: boolean }).terminal).length, 1);
  // the file given to Meta is the one the code generates
  const onDisk = JSON.parse(
    readFileSync(new URL("../../docs/whatsapp-invoicing/flow-live.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(f)), "run: node src/invoicing/write-flow.ts");
});

test("test mode: marked invoice on the test journal only; real mode is unmarked", async () => {
  const w = await world();
  const r = await queued(w);
  await drain(w.worker); // test mode is on by default
  assert.equal(w.odoo.moves[0].note, TEST_NOTE);
  assert.equal(w.odoo.moves[0].journalId, 23);

  // test mode on but no test journal configured: nothing is written to Odoo, the request waits
  const w2 = await world();
  w2.worker.salesJournalId = null;
  const r2 = await queued(w2);
  assert.equal(await drain(w2.worker), 0);
  assert.equal(w2.odoo.moves.length, 0);
  assert.equal((await w2.db.query(`select status from invoice_requests where id=$1`, [r2.id]))[0].status, "queued");

  // switched to real invoicing: no marking
  const w3 = await world();
  await w3.db.query(
    `insert into platform_settings (key, value) values ('test_mode','false') on conflict (key) do update set value='false'`,
  );
  await queued(w3);
  await drain(w3.worker);
  assert.equal(w3.odoo.moves[0].note, null);
  assert.ok(r.id);
});

test("test mode: every WhatsApp message is tagged, and untagged in real mode", async () => {
  const w = await world();
  const wa = new FakeWa();
  const tagged = new TestModeWa(
    wa,
    async () => (await w.db.query(`select value from platform_settings where key='test_mode'`))[0]?.value !== false,
  );
  await tagged.sendText(PHONE, "hello");
  await tagged.sendFlow(PHONE, { body: "Tap", token: "t" });
  await tagged.sendDocument(PHONE, { filename: "a.pdf", base64: "QQ==", caption: "Invoice" });
  assert.deepEqual(
    wa.sent.map((m) => m.text),
    [`${TEST_TAG} hello`, `${TEST_TAG} Tap`, `${TEST_TAG} Invoice`],
  );
  await w.db.query(
    `insert into platform_settings (key, value) values ('test_mode','false') on conflict (key) do update set value='false'`,
  );
  await tagged.sendText(PHONE, "hello");
  assert.equal(wa.sent.at(-1)?.text, "hello");
});

test("flow: no list sent to the phone is ever empty (Meta silently refuses such a screen)", async () => {
  const w = await world();
  const t = await session(w);
  const lists = (r: { data: Record<string, unknown> }) => Object.values(r.data).filter(Array.isArray) as unknown[][];
  const noEmpty = (name: string, r: { data: Record<string, unknown> }) => {
    for (const l of lists(r)) {
      assert.ok(l.length > 0, `${name}: an empty list`);
      // WhatsApp warns on the phone when an option title is longer than 30 characters
      for (const o of l as { title?: string }[])
        assert.ok((o.title ?? "").length <= 30, `${name}: title too long: ${o.title}`);
    }
  };
  noEmpty("INIT", await handleFlow(w.db, { action: "INIT", flow_token: t }));
  const items = await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t,
    data: { action: "select_customer", customer: w.customer },
  });
  assert.equal(items.screen, "ITEMS");
  noEmpty("ITEMS before a category", items); // products list is the placeholder
  assert.equal((items.data.products as { id: string }[])[0].id, "none");
  const withCat = await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t,
    data: { action: "select_category", category: w.category },
  });
  noEmpty("ITEMS with a category", withCat);
  await addToCart(w.db, t, { category: w.category, product: w.product, qty: "1", price: "1" });
  noEmpty(
    "ITEMS with every product in the cart",
    await handleFlow(w.db, {
      action: "data_exchange",
      flow_token: t,
      data: { step: "select_category", category: w.category },
    }),
  );
  await w.db.query(`update flow_sessions set lines = '[]'::jsonb where token = $1`, [t]);
  assert.equal((withCat.data.products as { id: string }[])[0].id, w.product);
  // choosing the placeholder is refused politely
  const bad = await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t,
    data: { action: "add_item", category: w.category, product: "none", qty: "1", price: "1" },
  });
  assert.equal(bad.screen, "ITEMS");
  assert.match(String(bad.data.error_message), /choose a product/i);
  // no customers assigned / expired form
  await w.db.query(`delete from salesman_customers`);
  const none = await handleFlow(w.db, { action: "INIT", flow_token: t });
  noEmpty("INIT without customers", none);
  assert.match(String(none.data.error_message), /No customers are assigned/);
  noEmpty("expired", await handleFlow(w.db, { action: "INIT", flow_token: "nope" }));
});

test("flow: every answer matches the data the Flow declares for that screen (keys and types)", async () => {
  const w = await world();
  const t = await session(w);
  const flow = buildFlowJson();
  const check = (name: string, r: { screen?: string; data: Record<string, unknown> }) => {
    if (r.screen === "SUCCESS" || r.screen === undefined) return;
    const screen = flow.screens.find((s) => s.id === r.screen);
    assert.ok(screen, `${name}: unknown screen ${r.screen}`);
    const declared = screen.data as unknown as Record<string, { type: string }>;
    const sent = Object.keys(r.data).filter((k) => k !== "error_message");
    for (const k of Object.keys(declared)) assert.ok(sent.includes(k), `${name}: ${r.screen} is missing "${k}"`);
    for (const k of sent) {
      assert.ok(k in declared, `${name}: ${r.screen} got undeclared "${k}"`);
      const v = r.data[k];
      assert.equal(Array.isArray(v) ? "array" : typeof v, declared[k].type, `${name}: "${k}" has the wrong type`);
    }
  };
  const step = async (name: string, data: Record<string, unknown>, action = "data_exchange") => {
    const r = await handleFlow(w.db, { action, flow_token: t, data });
    check(name, r);
    return r;
  };
  check("INIT", await handleFlow(w.db, { action: "INIT", flow_token: t }));
  await step("customer", { action: "select_customer", customer: w.customer });
  await step("category", { action: "select_category", category: w.category });
  await step("bad price", {
    action: "add_item",
    category: w.category,
    product: w.product,
    qty: "1",
    price: "99",
  });
  await step("add more", {
    action: "add_item",
    category: w.category,
    product: w.product,
    qty: "2",
    price: "4",
  });
  await step("open cart", { action: "open_cart" });
  await step("remove last", { action: "remove_last" });
  await step("add again", { action: "add_item", category: w.category, product: w.product, qty: "2", price: "4" }); // after remove_last the product is free again
  await step("review", { action: "open_cart" });
  const ok = await step("confirm", { action: "confirm" });
  assert.equal(ok.screen, "SUCCESS");
});

test("flow: the step is understood even when its name did not arrive, and a dead end always shows a message", async () => {
  const w = await world();
  const t = await session(w);
  const go = (screen: string, data: Record<string, unknown>) =>
    handleFlow(w.db, { action: "data_exchange", screen, flow_token: t, data });
  // exactly what the real phone sent: no step name at all, only the field
  const noName = await go("CUSTOMER", { customer: w.customer });
  assert.equal(noName.screen, "ITEMS");
  assert.equal((await go("ITEMS", { category: w.category })).screen, "ITEMS");
  const added = await go("ITEMS", {
    category: w.category,
    product: w.product,
    qty: "2",
    price: "4",
  });
  assert.equal(added.screen, "ITEMS");
  const named = await handleFlow(w.db, {
    action: "data_exchange",
    screen: "REVIEW",
    flow_token: t,
    data: { step: "confirm" },
  });
  assert.equal(named.screen, "SUCCESS");

  // a request nobody can understand shows a visible message instead of standing still
  const w2 = await world();
  const t2 = await session(w2, "tok-x");
  const lost = await handleFlow(w2.db, { action: "data_exchange", screen: "CUSTOMER", flow_token: t2, data: {} });
  assert.equal(lost.screen, "CUSTOMER");
  assert.match(String(lost.data.error_message), /could not be read/);
});

test("flow: going back to the customer screen starts the invoice from zero; back from the cart keeps it", async () => {
  const w = await world();
  const t = await session(w);
  const send = (action: string, screen?: string, data?: Record<string, unknown>) =>
    handleFlow(w.db, { action, screen, flow_token: t, data });
  await send("data_exchange", "CUSTOMER", { step: "select_customer", customer: w.customer });
  await addToCart(w.db, t, { category: w.category, product: w.product, qty: "2", price: "4" });
  const fromCart = await send("BACK", "ITEMS");
  assert.equal(fromCart.screen, "ITEMS");
  assert.match(String(fromCart.data.cart_text), /1\./);
  const reset = await send("BACK", "CUSTOMER");
  assert.equal(reset.screen, "CUSTOMER");
  const [row] = await w.db.query(`select customer_id, lines from flow_sessions where token=$1`, [t]);
  assert.equal(row.customer_id, null);
  assert.deepEqual(row.lines, []);
});

test("flow: choosing a product leaves only that product in the list; after adding, the full list is back", async () => {
  const w = await world();
  const t = await session(w);
  const [second] = await w.db.query(
    `insert into products (name, category_id, max_price, odoo_product_id) values ('SHAMI - 10', $1, 8.50, 71) returning id`,
    [w.category],
  );
  const send = (data: Record<string, unknown>) =>
    handleFlow(w.db, { action: "data_exchange", screen: "ITEMS", flow_token: t, data });
  await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t,
    data: { step: "select_customer", customer: w.customer },
  });
  const all = await send({ step: "select_category", category: w.category });
  assert.equal((all.data.products as unknown[]).length, 2);
  assert.equal(all.data.selected, "");
  const picked = await send({ step: "select_product", category: w.category, product: second.id });
  assert.deepEqual(
    (picked.data.products as { id: string }[]).map((p) => p.id),
    [second.id],
  );
  assert.equal(picked.data.selected, second.id);
  // a wrong price keeps the chosen product, so only the price needs fixing
  const bad = await send({ step: "add_item", category: w.category, product: second.id, qty: "1", price: "99" });
  assert.equal(bad.data.selected, second.id);
  const added = await send({ step: "add_item", category: w.category, product: second.id, qty: "1", price: "5" });
  assert.equal(added.data.selected, "");
  assert.deepEqual(
    (added.data.products as { id: string }[]).map((p) => p.id),
    [w.product],
  );
});

test("worker: when WhatsApp refuses the PDF the salesman is told why and gets a button to ask again", async () => {
  const w = await world();
  const r = await queued(w);
  w.wa.ok = false;
  await drain(w.worker);
  w.wa.ok = true;
  const [row] = await w.db.query(`select status from invoice_requests where id=$1`, [r.id]);
  assert.equal(row.status, "cleared"); // ZATCA cleared it, only the delivery failed
  const note = w.wa.sent.filter((m) => m.kind === "buttons").at(-1);
  assert.ok(note);
  assert.match(note.text, /could not be sent to you \(WhatsApp did not accept the file\)/);
  assert.deepEqual((note.extra as { id: string }[])[0].id, `pdf:${r.ref_code}`);
});

test("flow: more than 20 customers or products switch from round ticks to a drop-down, and the answer still works", async () => {
  const w = await world();
  const t = await session(w);
  for (let i = 0; i < 24; i++) {
    const [c] = await w.db.query(`insert into customers (name, odoo_partner_id) values ($1, $2) returning id`, [
      `Customer ${String(i).padStart(2, "0")}`,
      100 + i,
    ]);
    await w.db.query(`insert into salesman_customers (salesman_id, customer_id) values ($1,$2)`, [w.salesman, c.id]);
    await w.db.query(`insert into products (name, category_id, max_price, odoo_product_id) values ($1, $2, 9, $3)`, [
      `Bulk ${String(i).padStart(2, "0")}`,
      w.category,
      200 + i,
    ]);
  }
  const init = await handleFlow(w.db, { action: "INIT", flow_token: t });
  assert.equal(init.data.use_ticks, false);
  assert.equal(init.data.use_list, true);
  assert.equal((init.data.customers as unknown[]).length, 25);
  // the drop-down answers under its own name
  const [first] = init.data.customers as { id: string }[];
  const shop = await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t,
    data: { step: "select_customer", customer: "", customer_pick: first.id },
  });
  assert.equal(shop.screen, "ITEMS");
  const cat = await handleFlow(w.db, {
    action: "data_exchange",
    screen: "ITEMS",
    flow_token: t,
    data: { step: "select_category", category: w.category },
  });
  assert.equal(cat.data.use_list, true);
  assert.equal((cat.data.products as unknown[]).length, 25);
  const [p] = cat.data.products as { id: string }[];
  const added = await handleFlow(w.db, {
    action: "data_exchange",
    screen: "ITEMS",
    flow_token: t,
    data: { step: "add_item", category: w.category, product: "", product_pick: p.id, qty: "1", price: "1" },
  });
  assert.equal(added.screen, "ITEMS");
  assert.equal(added.data.error_message, undefined);
  assert.match(String(added.data.cart_text), /1\./);
});

test("ops: the health report is quiet when fine and names every real problem", async () => {
  const w = await world();
  const calm = await queueHealth(w.db, w.odoo, { journalId: 23 });
  assert.equal(calm.ok, true, calm.problems.join(" | "));

  // an invoice that has waited too long
  const r = await queued(w);
  await w.db.query(`update invoice_requests set queued_at = now() - interval '40 minutes' where id=$1`, [r.id]);
  const stuck = await queueHealth(w.db, w.odoo, { journalId: 23 });
  assert.equal(stuck.ok, false);
  assert.match(stuck.problems.join(" "), /waited 40 minutes/);
  await drain(w.worker);

  // key expiry
  const today = new Date("2026-10-24T00:00:00Z");
  await w.db.query(
    `insert into platform_settings (key, value) values ('odoo_key_expires_on', '"2026-11-02"') on conflict (key) do update set value = excluded.value`,
  );
  assert.match((await queueHealth(w.db, w.odoo, { now: today })).problems.join(" "), /expires in 9 day/);
  await w.db.query(`update platform_settings set value = '"2026-10-20"' where key='odoo_key_expires_on'`);
  assert.match((await queueHealth(w.db, w.odoo, { now: today })).problems.join(" "), /expired on 2026-10-20/);
  await w.db.query(`update platform_settings set value = '"2027-03-01"' where key='odoo_key_expires_on'`);
  assert.equal((await queueHealth(w.db, w.odoo, { now: today })).ok, true);

  // an invoice that sits in Odoo without ZATCA clearance, and a paused service
  w.odoo.uncleared = [{ name: "WTS/2026/00009", ref: "WA-X" }];
  assert.match((await queueHealth(w.db, w.odoo, { journalId: 23, now: today })).problems.join(" "), /WTS\/2026\/00009/);
  w.odoo.uncleared = [];
  await w.db.query(
    `insert into platform_settings (key, value) values ('kill_switch', 'true') on conflict (key) do update set value = excluded.value`,
  );
  assert.match((await queueHealth(w.db, w.odoo, { now: today })).problems.join(" "), /paused/);
});

test("ops: the sweep retries what failed for a passing reason, at most 3 times, never a ZATCA rejection", async () => {
  const w = await world();
  const r = await queued(w);
  w.odoo.zatca = "pending";
  await drain(w.worker); // answer not confirmed yet: stays in processing
  const fail = async (code: string) =>
    w.db.query(
      `update invoice_requests set status='failed', error_code=$2, finished_at = now() - interval '2 hours', odoo_move_id = coalesce(odoo_move_id, 1) where id=$1`,
      [r.id, code],
    );
  await fail("zatca_rejected");
  assert.equal(await sweepStuck(w.db), 0, "a rejection is for a person to decide");
  await fail("clearance_unconfirmed");
  assert.equal(await sweepStuck(w.db), 1);
  assert.equal((await w.db.query(`select status from invoice_requests where id=$1`, [r.id]))[0].status, "queued");
  await fail("clearance_unconfirmed");
  assert.equal(await sweepStuck(w.db), 0, "not again within 30 minutes");
  for (let i = 0; i < 2; i++) {
    await w.db.query(`update invoice_request_events set at = now() - interval '2 hours' where kind='swept'`);
    await fail("clearance_unconfirmed");
    await sweepStuck(w.db);
  }
  await w.db.query(`update invoice_request_events set at = now() - interval '2 hours' where kind='swept'`);
  await fail("clearance_unconfirmed");
  assert.equal(await sweepStuck(w.db), 0, "three tries are the limit");
});

test("load: 60 invoices from 12 salesmen are each issued exactly once, in order, within a minute", async () => {
  const w = await world();
  const people: { id: string; customer: string }[] = [{ id: w.salesman, customer: w.customer }];
  for (let i = 1; i < 12; i++) {
    const phone = `96650000${String(100 + i)}`;
    await w.db.query(`insert into wa_numbers (phone, target_id) values ($1,'invoicing') on conflict do nothing`, [
      phone,
    ]);
    const [s] = await w.db.query(
      `insert into salesmen (code, name, phone, status) values ($1,$2,$3,'active') returning id`,
      [`S-${i}`, `Salesman ${i}`, phone],
    );
    const [c] = await w.db.query(`insert into customers (name, odoo_partner_id) values ($1,$2) returning id`, [
      `Load Customer ${i}`,
      300 + i,
    ]);
    await w.db.query(`insert into salesman_customers (salesman_id, customer_id) values ($1,$2)`, [s.id, c.id]);
    people.push({ id: s.id, customer: c.id });
  }
  const started = Date.now();
  for (let n = 0; n < 60; n++) {
    const p = people[n % people.length];
    const token = `load-${n}`;
    await w.db.query(
      `insert into flow_sessions (token, salesman_id, expires_at) values ($1,$2, now() + interval '30 minutes')`,
      [token, p.id],
    );
    await handleFlow(w.db, {
      action: "data_exchange",
      flow_token: token,
      data: { step: "select_customer", customer: p.customer },
    });
    // each invoice differs, so the duplicate rule does not apply
    await addToCart(w.db, token, { category: w.category, product: w.product, qty: String(n + 1), price: "4" });
    await handleFlow(w.db, { action: "data_exchange", flow_token: token, data: { step: "confirm" } });
  }
  const queuedCount = (await w.db.query(`select count(*)::int n from invoice_requests where status='queued'`))[0].n;
  assert.equal(queuedCount, 60);
  let handled = 0;
  for (let i = 0; i < 70 && handled < 60; i++) handled += await drain(w.worker);
  assert.equal(handled, 60);
  const [done] = await w.db.query(
    `select count(*) filter (where status='cleared')::int cleared, count(distinct odoo_move_id)::int moves from invoice_requests`,
  );
  assert.equal(done.cleared, 60);
  assert.equal(done.moves, 60, "one Odoo invoice per request");
  assert.equal(w.odoo.moves.length, 60);
  assert.ok(Date.now() - started < 60_000, "the rehearsal itself must stay fast");
});

test("flow: product pictures travel with the round ticks, and are left out of long drop-down lists", async () => {
  const w = await world();
  const t = await session(w);
  await w.db.query(`update products set image = 'QUJD' where id=$1`, [w.product]);
  await handleFlow(w.db, {
    action: "data_exchange",
    flow_token: t,
    data: { step: "select_customer", customer: w.customer },
  });
  const ticks = await handleFlow(w.db, {
    action: "data_exchange",
    screen: "ITEMS",
    flow_token: t,
    data: { step: "select_category", category: w.category },
  });
  const [item] = ticks.data.products as { image?: string; "alt-text"?: string }[];
  assert.equal(item.image, "QUJD");
  assert.equal(item["alt-text"], "SHAMI - 5");
  for (let i = 0; i < 24; i++)
    await w.db.query(
      `insert into products (name, category_id, max_price, odoo_product_id, image) values ($1,$2,9,$3,'QUJD')`,
      [`More ${i}`, w.category, 500 + i],
    );
  const long = await handleFlow(w.db, {
    action: "data_exchange",
    screen: "ITEMS",
    flow_token: t,
    data: { step: "select_category", category: w.category },
  });
  assert.equal(long.data.use_list, true);
  assert.ok((long.data.products as { image?: string }[]).every((p) => p.image === undefined));
});
