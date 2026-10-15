// Revenue / VAT / alerts schema tests against the REAL migration files (PGlite).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const dir = new URL("../../supabase/migrations/", import.meta.url);
const ADMIN = "11111111-1111-1111-1111-111111111111";
const ACCOUNTS = "44444444-4444-4444-4444-444444444444";
const STAFF = "22222222-2222-2222-2222-222222222222";
let db: PGlite;

async function as<T = any>(role: string, uid: string | null, sql: string): Promise<T[]> {
  await db.exec(`set role ${role}; select set_config('request.jwt.sub', '${uid ?? ""}', false);`);
  try { return (await db.query<T>(sql)).rows; } finally { await db.exec("reset role"); }
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema storage;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true), '')::uuid $$;
    create table storage.buckets (id text primary key, name text, public boolean);
    create publication supabase_realtime; grant all on storage.buckets to service_role;
    grant usage on schema auth, public, storage to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to service_role;
    insert into auth.users values ('${ADMIN}','a@x.com'),('${ACCOUNTS}','acc@x.com'),('${STAFF}','s@x.com');
  `);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(new URL(f, dir), "utf8"));
  await db.exec(`
    select public.bootstrap_admin('a@x.com','Admin');
    insert into public.app_users (auth_user_id,name,role,sections) values ('${ACCOUNTS}','Accounts','accounts','{}'),('${STAFF}','Staff','staff','{bakery}');
    insert into public.sales_invoices (odoo_id,number,kind,state,invoice_date,odoo_created_at,salesman_id,salesman_name,customer_id,customer_name,customer_vat,amount_untaxed,amount_tax,amount_total,zatca_state,reversed_odoo_id,ref) values
     (1,'INV/2026/100','invoice','posted','2026-10-05','2026-10-05 07:00+00',10,'ALI',1,'Shop A','300000000000003',100,15,115,'sent',null,null),
     (2,'INV/2026/101','invoice','posted','2026-10-05','2026-10-05 07:10+00',10,'ALI',2,'Walk-in',null,200,30,230,'sent',null,null),
     (3,'INV/2026/103','invoice','posted','2026-10-06','2026-10-06 07:00+00',11,'OMAR',1,'Shop A','300000000000003',1000,150,1150,'to_send',null,null),
     (4,'RINV/2026/1','credit_note','posted','2026-10-06','2026-10-06 08:00+00',10,'ALI',1,'Shop A','300000000000003',100,15,115,'sent',1,'Reversal of INV/2026/100'),
     (5,'INV/2026/104','invoice','cancel','2026-10-06','2026-10-06 09:00+00',11,'OMAR',1,'Shop A','300000000000003',500,75,575,null,null,null),
     (6,'INV/2026/105','invoice','posted','2026-07-02','2026-07-02 07:00+00',10,'ALI',1,'Shop A','300000000000003',400,60,460,'sent',null,null);
    insert into public.grocery_sales_daily (sale_date,net_sales,vat_amount,credit_net,credit_vat,invoice_count) values ('2026-10-07',1000,150,100,15,40),('2026-07-03',500,75,0,0,20);
    insert into public.bakery_expenses (seller_name,vat_number,invoice_date,total_amount,vat_amount,source) values
     ('Mill','312028501300003','2026-10-04T10:00:00+03',115,15,'admin_manual'),
     ('No VAT shop',null,'2026-10-04T11:00:00+03',50,0,'admin_manual'),
     ('Bad VAT','12345','2026-10-04T12:00:00+03',23,3,'admin_manual');
    insert into public.grocery_expenses (seller_name,vat_number,invoice_date,total_amount,vat_amount,source) values ('Veg','300000000000003','2026-10-09T10:00:00+03',230,30,'admin_manual');
    insert into public.vat_payments (period_year,period_quarter,amount_paid,paid_on,reference) values (2026,3,500,'2026-10-28','SADAD1');
  `);
});
after(() => db.close());

describe("purchases without a valid VAT number", () => {
  it("are stored, flagged vat_number_invalid, and vat_valid=false", async () => {
    const r = await as("service_role", null, "select seller_name, vat_valid, warnings from public.bakery_expenses order by seller_name");
    assert.deepEqual(r.map((x) => [x.seller_name, x.vat_valid]), [["Bad VAT", false], ["Mill", true], ["No VAT shop", false]]);
    assert.ok(r.find((x) => x.seller_name === "Bad VAT").warnings.includes("vat_number_invalid"));
    assert.deepEqual(r.find((x) => x.seller_name === "Mill").warnings, []);
  });
});

describe("revenue_summary", () => {
  it("subtracts credit notes, ignores cancelled invoices, splits B2B / B2C", async () => {
    const day = await as("authenticated", ADMIN, "select * from public.revenue_summary('2026-10-01','2026-10-31','day')");
    const d6 = day.find((x) => x.bucket === "2026-10-06");
    assert.equal(Number(d6.net_sales), 1000); // cancelled 500 excluded
    assert.equal(Number(d6.credit_net), 100);
    assert.equal(Number(d6.net_after_credit), 900);
    assert.equal(Number(d6.vat_after_credit), 135);
    const seg = await as("authenticated", ADMIN, "select bucket, net_sales from public.revenue_summary('2026-10-01','2026-10-31','segment') order by bucket");
    assert.deepEqual(seg.map((x) => [x.bucket, Number(x.net_sales)]), [["B2B", 1100], ["B2C", 200]]);
    const sm = await as("authenticated", ADMIN, "select label, net_after_credit from public.revenue_summary('2026-10-01','2026-10-31','salesman') order by label");
    assert.deepEqual(sm.map((x) => [x.label, Number(x.net_after_credit)]), [["ALI", 200], ["OMAR", 1000]]);
    const month = await as("authenticated", ADMIN, "select bucket from public.revenue_summary('2026-01-01','2026-12-31','month') order by bucket");
    assert.deepEqual(month.map((x) => x.bucket), ["2026-07", "2026-10"]);
  });
});

describe("vat_return", () => {
  it("Q4 2026: output VAT minus credit notes, input VAT only from valid VAT numbers, excluded shown separately", async () => {
    const [{ vat_return: r }] = await as("authenticated", ADMIN, "select public.vat_return(2026, 4) as vat_return");
    assert.equal(r.from, "2026-10-01"); assert.equal(r.to, "2026-12-31");
    assert.equal(Number(r.bakery_sales.net), 1300); assert.equal(Number(r.bakery_sales.vat), 195);
    assert.equal(Number(r.bakery_sales.credit_vat), 15);
    assert.equal(Number(r.grocery_sales.vat), 150); assert.equal(Number(r.grocery_sales.credit_vat), 15);
    assert.equal(Number(r.purchases.bakery.counted_vat), 15);
    assert.equal(Number(r.purchases.bakery.excluded_invoices), 2);
    assert.equal(Number(r.purchases.bakery.excluded_total), 73);
    assert.equal(Number(r.purchases.grocery.counted_vat), 30);
    assert.equal(Number(r.paid), 0);
    const [{ vat_return: q3 }] = await as("authenticated", ADMIN, "select public.vat_return(2026, 3) as vat_return");
    assert.equal(Number(q3.paid), 500); assert.equal(Number(q3.bakery_sales.vat), 60); assert.equal(Number(q3.grocery_sales.vat), 75);
    await assert.rejects(as("authenticated", ADMIN, "select public.vat_return(2026, 5)"), /quarter/);
  });
});

describe("roles and RLS", () => {
  it("accounts staff see alerts and ONLY credit notes / ZATCA problems; never expenses, grocery, payments", async () => {
    await as("service_role", null, "insert into public.alerts (rule_key,title,fingerprint) values ('credit_any','Credit note','fp1')");
    assert.equal((await as("authenticated", ACCOUNTS, "select * from public.alerts")).length, 1);
    assert.equal((await as("authenticated", STAFF, "select * from public.alerts")).length, 0);
    const sales = await as("authenticated", ACCOUNTS, "select number from public.sales_invoices order by number");
    assert.deepEqual(sales.map((x) => x.number), ["INV/2026/103", "INV/2026/104", "RINV/2026/1"]); // to_send, cancelled, credit note
    for (const t of ["bakery_expenses", "grocery_expenses", "grocery_sales_daily", "vat_payments", "verification_runs", "app_settings"]) {
      assert.equal((await as("authenticated", ACCOUNTS, `select * from public.${t}`)).length, 0, t);
    }
    assert.equal((await as("authenticated", ADMIN, "select * from public.sales_invoices")).length, 6);
    await assert.rejects(as("anon", null, "select * from public.sales_invoices"), /permission denied/);
    await assert.rejects(as("authenticated", ACCOUNTS, "update public.alerts set status='resolved'"), /permission denied/);
    await assert.rejects(as("authenticated", ACCOUNTS, "select public.vat_return(2026,4)").then((r) => { if (Number(r[0].vat_return.bakery_sales.net) !== 0) throw new Error("permission denied: leak"); }), /permission denied/);
    await assert.rejects(as("authenticated", STAFF, "select * from public.salesman_stats(30)"), /permission denied/);
  });
  it("accounts role is accepted by app_users; unknown roles are not", async () => {
    await assert.rejects(as("service_role", null, "insert into public.app_users (name, role) values ('x','boss')"), /check/);
  });
});

describe("helpers for the alert engine", () => {
  it("salesman_stats and invoice_number_gaps", async () => {
    await as("service_role", null, `insert into public.sales_invoices (odoo_id,number,kind,state,invoice_date,odoo_created_at,amount_total,amount_tax) values
      (101,'INV/2099/00010','invoice','posted',current_date,now() - interval '2 hours',10,1),
      (102,'INV/2099/00011','invoice','posted',current_date,now() - interval '2 hours',10,1),
      (103,'INV/2099/00014','invoice','posted',current_date,now() - interval '1 hour',10,1)`);
    const gaps = await as("service_role", null, "select * from public.invoice_number_gaps(current_date - 1)");
    assert.deepEqual(gaps.map((g) => [Number(g.gap_from), Number(g.gap_to), g.prefix]), [[12, 13, "INV/2099"]]);
    const st = await as("service_role", null, "select * from public.salesman_stats(30)");
    assert.ok(Array.isArray(st));
    const dt = await as("service_role", null, "select * from public.salesman_daily_totals(15)");
    assert.ok(dt.length >= 1);
  });
  it("db_size_bytes works for admins only", async () => {
    assert.ok(Number((await as("authenticated", ADMIN, "select public.db_size_bytes() as s"))[0].s) > 0);
    await assert.rejects(as("authenticated", STAFF, "select public.db_size_bytes()"), /not allowed/);
  });
  it("defaults are seeded and the migration is re-runnable", async () => {
    const keys = (await as("service_role", null, "select key from public.app_settings where key in ('alert_rules','sync_settings','zatca_thresholds','alert_channels')")).map((x) => x.key).sort();
    assert.deepEqual(keys, ["alert_channels", "alert_rules", "sync_settings", "zatca_thresholds"]);
    // the CI workflow applies every file to a database that may already contain them: a full second pass must not fail
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await db.exec(readFileSync(new URL(f, dir), "utf8"));
    const rt = await as("service_role", null, "select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1");
    assert.deepEqual(rt.map((x) => x.tablename), ["alerts", "bakery_expenses", "grocery_expenses"]);
  });
});
