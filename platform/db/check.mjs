// Local check of 0001_core.sql on a real Postgres engine (PGlite). Run: node platform/db/check.mjs

import { PGlite } from "../../valtown/node_modules/@electric-sql/pglite/dist/index.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("./0001_core.sql", import.meta.url), "utf8");
const db = new PGlite();
await db.exec(sql);
await db.exec(sql); // must be safe to run twice
const q = async (text, params) => (await db.query(text, params)).rows;
const fails = async (text, params) => {
  try {
    await db.query(text, params);
    return false;
  } catch {
    return true;
  }
};
let n = 0;
const ok = (m) => console.log(`ok ${++n} - ${m}`);

await q(
  `insert into wa_targets (id, name, url) values ('expense','Expense','https://e.example.com/w'), ('invoicing','Invoicing','https://i.example.com/w')`,
);
assert.ok(await fails(`insert into wa_targets (id, name, url) values ('bad','Bad','http://x.example.com')`));
ok("http target address refused");
await q(`insert into wa_numbers (phone, target_id) values ('966500000001','invoicing'), ('966500000002','expense')`);
assert.ok(await fails(`insert into wa_numbers (phone, target_id) values ('966500000001','expense')`));
ok("one number can belong to one service only");
assert.ok(await fails(`insert into wa_numbers (phone, target_id) values ('+96650','expense')`));
ok("phone must be digits only");

const [s] = await q(
  `insert into salesmen (code, name, phone) values ('FAIZAL-1','Faizal','966500000001') returning id, status, language`,
);
assert.equal(s.status, "inactive");
assert.equal(s.language, "en");
ok("new salesman starts inactive, English");
assert.ok(await fails(`insert into salesmen (code, name, phone) values ('X1','No number','966511111111')`));
ok("salesman needs a registered WhatsApp number");
assert.ok(await fails(`insert into salesmen (code, name, phone) values ('Y1','Dup','966500000001')`));
ok("two salesmen cannot share a number");

const [c] = await q(`insert into customers (name, odoo_partner_id) values ('Al Noor', 7) returning id`);
await q(`insert into salesman_customers (salesman_id, customer_id) values ($1,$2)`, [s.id, c.id]);
assert.ok(await fails(`insert into salesman_customers (salesman_id, customer_id) values ($1,$2)`, [s.id, c.id]));
ok("a customer is listed once per salesman");

assert.ok(await fails(`insert into products (name, max_price) values ('P', 0)`));
ok("price limit must be above zero (or empty)");
await q(`insert into products (name) values ('No limit yet')`);
ok("a product without a limit is allowed (but cannot be invoiced)");

const mk = (key, extra = "") =>
  q(
    `insert into invoice_requests (request_key, salesman_id, customer_id, lines, subtotal, vat, total, content_hash ${extra}) values ($1,$2,$3,'[{"p":"A","q":1,"u":10}]',10,1.5,11.5,'h1') returning id, ref_code, status`,
    [key, s.id, c.id],
  );
const r1 = await mk("flow-1");
assert.equal(r1[0].status, "received");
assert.equal(r1[0].ref_code.length, 8);
ok("request gets a short reference code");
assert.ok(
  await fails(
    `insert into invoice_requests (request_key, salesman_id, customer_id, lines, subtotal, vat, total, content_hash) values ('flow-1',$1,$2,'[{"x":1}]',1,0,1,'h')`,
    [s.id, c.id],
  ),
);
ok("the same request key can never create a second request");
assert.ok(
  await fails(
    `insert into invoice_requests (request_key, salesman_id, customer_id, lines, subtotal, vat, total, content_hash) values ('flow-2',$1,$2,'[]',1,0,1,'h')`,
    [s.id, c.id],
  ),
);
ok("a request needs at least one line");

// queue: oldest first, one claim per call, lease protects a running job
const r2 = await mk("flow-2");
const r3 = await mk("flow-3");
await q(`update invoice_requests set status='queued', created_at = now() - interval '3 min' where id=$1`, [r2[0].id]);
await q(`update invoice_requests set status='queued', created_at = now() - interval '2 min' where id=$1`, [r1[0].id]);
await q(`update invoice_requests set status='queued', created_at = now() - interval '1 min' where id=$1`, [r3[0].id]);
const c1 = await q(`select * from claim_next_invoice_job('w1', 60)`);
assert.equal(c1[0].id, r2[0].id);
assert.equal(c1[0].status, "processing");
assert.equal(c1[0].attempts, 1);
ok("the worker takes the OLDEST queued request");
const c2 = await q(`select * from claim_next_invoice_job('w2', 60)`);
assert.equal(c2[0].id, r1[0].id);
ok("a request being processed is not given to a second worker");
await q(`update invoice_requests set lease_until = now() - interval '1 second' where id=$1`, [r2[0].id]);
await q(`update invoice_requests set status='cleared' where id=$1`, [r1[0].id]);
const c3 = await q(`select * from claim_next_invoice_job('w3', 60)`);
assert.equal(c3[0].id, r2[0].id);
assert.equal(c3[0].attempts, 2);
ok("a job whose worker died (lease expired) comes back");
const c4 = await q(`select * from claim_next_invoice_job('w3', 60)`);
assert.equal(c4[0].id, r3[0].id);
ok("then the next one");
assert.equal((await q(`select * from claim_next_invoice_job('w3', 60)`)).length, 0);
ok("empty queue gives nothing");

// single-writer lock
assert.equal((await q(`select acquire_lock('zatca-chain','a',30) as v`))[0].v, true);
assert.equal((await q(`select acquire_lock('zatca-chain','b',30) as v`))[0].v, false);
ok("second worker cannot take the invoice lock");
assert.equal((await q(`select acquire_lock('zatca-chain','a',30) as v`))[0].v, true);
ok("the holder can renew it");
await q(`update worker_locks set lease_until = now() - interval '1 s'`);
assert.equal((await q(`select acquire_lock('zatca-chain','b',30) as v`))[0].v, true);
ok("an expired lock can be taken over");

// approvals and settings
const [ap] = await q(`insert into approvals (request_id, reason) values ($1,'repeat') returning id`, [r3[0].id]);
assert.ok(await fails(`update approvals set decision='approved' where id=$1`, [ap.id]));
ok("a decision needs a decision time");
await q(`update approvals set decision='approved', decided_at=now(), decided_by='sup' where id=$1`, [ap.id]);
assert.equal((await q(`select value from platform_settings where key='duplicate_window_minutes'`))[0].value, 30);
ok("default settings are in place");

// seen messages purge
await q(`insert into wa_messages_seen (message_id, seen_at) values ('old', now() - interval '3 days'), ('new', now())`);
assert.equal((await q(`select purge_seen_messages() as n`))[0].n, 1);
ok("old message ids are purged");

// updated_at trigger
const before = (await q(`select updated_at from customers where id=$1`, [c.id]))[0].updated_at;
await new Promise((r) => setTimeout(r, 20));
await q(`update customers set name='Al Noor Supermarket' where id=$1`, [c.id]);
assert.ok((await q(`select updated_at from customers where id=$1`, [c.id]))[0].updated_at > before);
ok("updated_at follows changes");

const rls = await q(`select count(*)::int as n from pg_tables where schemaname='public' and rowsecurity`);
assert.equal(rls[0].n, 16);
ok("row level security is on for all 16 tables");
console.log(`\n${n} checks passed`);
