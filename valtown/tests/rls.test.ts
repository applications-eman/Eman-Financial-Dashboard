// RLS / constraint tests against the REAL migration files, run in PGlite (in-process Postgres).
// Supabase-specific objects (auth schema, roles, storage, realtime publication) are stubbed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const dir = new URL("../../supabase/migrations/", import.meta.url);
const ADMIN = "11111111-1111-1111-1111-111111111111";
const STAFF = "22222222-2222-2222-2222-222222222222";
const NOBODY = "33333333-3333-3333-3333-333333333333";

let db: PGlite;

async function as<T>(role: string, uid: string | null, sql: string): Promise<T[]> {
  await db.exec(`set role ${role}; select set_config('request.jwt.sub', '${uid ?? ""}', false);`);
  try {
    const r = await db.query<T>(sql);
    return r.rows;
  } finally {
    await db.exec("reset role");
  }
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
    alter default privileges in schema public grant all on sequences to service_role;
    grant usage on schema auth, public, storage to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    insert into auth.users values ('${ADMIN}','admin@x.com'),('${STAFF}','staff@x.com'),('${NOBODY}','nobody@x.com');
  `);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(new URL(f, dir), "utf8"));
  }
  await db.exec(`
    select public.bootstrap_admin('admin@x.com','Admin');
    insert into public.app_users (auth_user_id,name,role,sections,token_hash) values ('${STAFF}','Staff','staff','{bakery}','secrethash');
    insert into public.bakery_expenses (seller_name,vat_number,invoice_date,total_amount,vat_amount,source)
      values ('شركة مخابز ايمان جدة للخبز','312028501300003','2026-08-11T15:19:20+03',145.52,18.98,'ios_shortcut');
  `);
});
after(() => db.close());

describe("RLS", () => {
  it("admin can read expenses, settings, flags, categories, audit_log", async () => {
    for (const t of ["bakery_expenses", "grocery_expenses", "app_settings", "feature_flags", "categories", "audit_log"]) {
      const rows = await as("authenticated", ADMIN, `select * from public.${t}`);
      if (t === "bakery_expenses") assert.equal(rows.length, 1);
      if (t === "app_settings") assert.ok(rows.length > 3);
    }
  });
  it("non-admin staff cannot read any protected table", async () => {
    for (const t of ["bakery_expenses", "grocery_expenses", "app_settings", "feature_flags", "categories", "audit_log"]) {
      assert.equal((await as("authenticated", STAFF, `select * from public.${t}`)).length, 0, t);
    }
  });
  it("user with no app_users row reads nothing", async () => {
    assert.equal((await as("authenticated", NOBODY, "select * from public.bakery_expenses")).length, 0);
  });
  it("anon has no access at all", async () => {
    await assert.rejects(as("anon", null, "select * from public.bakery_expenses"), /permission denied/);
    await assert.rejects(as("anon", null, "select * from public.app_settings"), /permission denied/);
  });
  it("whatsapp_events is service-role only", async () => {
    await assert.rejects(as("authenticated", ADMIN, "select * from public.whatsapp_events"), /permission denied/);
  });
  it("token_hash is never readable by authenticated users", async () => {
    await assert.rejects(as("authenticated", STAFF, "select token_hash from public.app_users"), /permission denied/);
    await assert.rejects(as("authenticated", ADMIN, "select * from public.app_users"), /permission denied/);
    const own = await as<{ name: string }>("authenticated", STAFF, "select name, role from public.app_users");
    assert.equal(own.length, 1); // only own row
  });
  it("authenticated admins cannot write directly", async () => {
    await assert.rejects(
      as("authenticated", ADMIN, "insert into public.categories (section,name) values ('bakery','x')"),
      /permission denied/,
    );
    await assert.rejects(as("authenticated", ADMIN, "delete from public.bakery_expenses"), /permission denied/);
  });
  it("service_role can write", async () => {
    await as("service_role", null, "insert into public.categories (section,name) values ('bakery','Test cat')");
  });
});

describe("constraints & triggers", () => {
  const ins = (vat: string, total: number, v: number, date = "2026-01-01T00:00:00Z") =>
    `insert into public.grocery_expenses (vat_number,invoice_date,total_amount,vat_amount,source) values ('${vat}','${date}',${total},${v},'admin_manual')`;
  it("accepts (and flags) a non-15-digit VAT number, rejects negative amounts and vat>total", async () => {
    // since migration 20261016 such purchases are stored for reporting but never counted as input VAT
    await as("service_role", null, ins("123", 10, 1, "2026-01-03T00:00:00Z"));
    const flagged = await as<{ warnings: string[]; vat_valid: boolean }>("service_role", null, "select warnings, vat_valid from public.grocery_expenses where vat_number='123'");
    assert.equal(flagged[0].vat_valid, false);
    assert.ok(flagged[0].warnings.includes("vat_number_invalid"));
    await assert.rejects(as("service_role", null, ins("312028501300003", -1, 0)), /amounts_chk/);
    await assert.rejects(as("service_role", null, ins("312028501300003", 10, 11, "2026-01-02T00:00:00Z")), /check/);
  });
  it("blocks duplicates", async () => {
    await as("service_role", null, ins("312028501300003", 115, 15, "2026-02-01T00:00:00Z"));
    await assert.rejects(as("service_role", null, ins("312028501300003", 115, 15, "2026-02-01T00:00:00Z")), /dedupe_uq|duplicate key/);
  });
  it("the same raw QR cannot be stored twice even with an edited total", async () => {
    const q = (t: number) => `insert into public.grocery_expenses (vat_number,invoice_date,total_amount,vat_amount,source,raw_qr) values ('312028501300003','2026-04-01T00:00:00Z',${t},${t - t / 1.15},'whatsapp_flow','QRX')`;
    await as("service_role", null, q(115));
    await assert.rejects(as("service_role", null, q(116)), /rawqr_uq|duplicate key/);
  });
  it("flags VAT that is not ~15%", async () => {
    await as("service_role", null, ins("312028501300003", 100, 50, "2026-03-01T00:00:00Z"));
    const ok = await as<{ warnings: string[] }>("service_role", null, "select warnings from public.grocery_expenses where total_amount=115");
    const bad = await as<{ warnings: string[] }>("service_role", null, "select warnings from public.grocery_expenses where total_amount=100");
    assert.deepEqual(ok[0].warnings, []);
    assert.deepEqual(bad[0].warnings, ["vat_rate_mismatch"]);
    const sample = await as<{ warnings: string[] }>("service_role", null, "select warnings from public.bakery_expenses");
    assert.deepEqual(sample[0].warnings, []); // 145.52 / 18.98 sample is exactly 15%
  });
  it("sets updated_at and writes audit_log with actor and without token_hash", async () => {
    await as("service_role", null, `select set_config('app.actor','admin@x.com',false)`);
    await as("service_role", null, "update public.bakery_expenses set status='reviewed'");
    await as("service_role", null, "update public.app_users set token_hash='newhash' where name='Staff'");
    const e = await as<{ updated_at: string }>("service_role", null, "select updated_at from public.bakery_expenses");
    assert.ok(e[0].updated_at);
    const a = await as<{ actor: string; action: string; before: any }>(
      "service_role", null, "select actor, action, before, after from public.audit_log where table_name='bakery_expenses' and action='UPDATE'");
    assert.equal(a[0].actor, "admin@x.com");
    const u = await as<{ before: Record<string, unknown> }>(
      "service_role", null, "select before from public.audit_log where table_name='app_users' and action='UPDATE'");
    assert.ok(!("token_hash" in u[0].before));
  });
  it("realtime publication includes both expense tables (and alerts); bucket is private", async () => {
    const t = await as<{ tablename: string }>("service_role", null, "select tablename from pg_publication_tables where pubname='supabase_realtime'");
    assert.deepEqual(t.map((x) => x.tablename).sort(), ["alerts", "bakery_expenses", "grocery_expenses"]);
    const b = await as<{ public: boolean }>("service_role", null, "select public from storage.buckets where id='invoice-images'");
    assert.equal(b[0].public, false);
  });
});
