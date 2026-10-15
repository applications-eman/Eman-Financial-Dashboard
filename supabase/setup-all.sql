-- Eman Expenses: complete database setup (generated: concatenation of supabase/migrations/*.sql in order).
-- For a NEW project: paste ALL of this into Supabase > SQL Editor > New query and press Run. Safe to run more than once.

-- ===== supabase/migrations/20261015000001_core_schema.sql =====
-- Core schema: expense tables (bakery + grocery), support tables, triggers.
-- All writes happen from Val Town with the service role key. See 20261015000002 for RLS.

-- ---------------------------------------------------------------- support tables
create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  name text not null,
  phone_e164 text unique check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  role text not null default 'staff' check (role in ('admin', 'staff')),
  sections text[] not null default '{}' check (sections <@ array['bakery', 'grocery']::text[]),
  token_hash text unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  section text not null check (section in ('bakery', 'grocery')),
  name text not null,
  name_ar text,
  active boolean not null default true,
  unique (section, name)
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor text,
  action text not null,
  table_name text not null,
  record_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_table_idx on public.audit_log (table_name, record_id);

create table if not exists public.whatsapp_events (
  id bigint generated always as identity primary key,
  wa_message_id text not null unique,
  payload jsonb,
  processed_at timestamptz
);

-- ---------------------------------------------------------------- expense tables
do $$
declare t text;
begin
  foreach t in array array['bakery_expenses', 'grocery_expenses'] loop
    execute format($f$
      create table if not exists public.%1$I (
        id uuid primary key default gen_random_uuid(),
        seller_name text,
        vat_number text not null,
        invoice_date timestamptz not null,
        total_amount numeric(12,2) not null,
        vat_amount numeric(12,2) not null,
        raw_qr text,
        source text not null check (source in ('whatsapp_flow','whatsapp_text','ios_shortcut','admin_manual')),
        submitted_by text,
        category text,
        notes text,
        image_path text,
        status text not null default 'new' check (status in ('new','reviewed','exported')),
        warnings text[] not null default '{}',
        duplicate_count integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz,
        constraint %1$I_vat_number_chk check (vat_number ~ '^[0-9]{15}$'),
        constraint %1$I_amounts_chk check (total_amount >= 0 and vat_amount >= 0),
        constraint %1$I_vat_le_total_chk check (vat_amount <= total_amount),
        constraint %1$I_dedupe_uq unique (vat_number, invoice_date, total_amount)
      )$f$, t);
    -- the same QR can only be recorded once, even if the total was edited afterwards
    execute format('create unique index if not exists %1$I on public.%2$I (raw_qr) where raw_qr is not null', t || '_rawqr_uq', t);
    execute format('create index if not exists %1$I on public.%2$I (invoice_date desc)', t || '_date_idx', t);
    execute format('create index if not exists %1$I on public.%2$I (created_at desc)', t || '_created_idx', t);
    execute format('create index if not exists %1$I on public.%2$I (status)', t || '_status_idx', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- functions
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Flags (does NOT reject) invoices whose VAT is not ~ vat_rate of the net amount.
create or replace function public.compute_expense_warnings() returns trigger
language plpgsql set search_path = public as $$
declare
  rate numeric := 0.15;
  net numeric;
  expected numeric;
  w text[] := '{}';
begin
  begin
    select (value #>> '{}')::numeric into rate from public.app_settings where key = 'vat_rate';
  exception when others then rate := 0.15;
  end;
  rate := coalesce(rate, 0.15);
  net := new.total_amount - new.vat_amount;
  expected := round(net * rate, 2);
  if net <= 0 and new.vat_amount > 0 then
    w := array_append(w, 'vat_rate_mismatch');
  elsif abs(new.vat_amount - expected) > (0.05 + 0.005 * net) then
    w := array_append(w, 'vat_rate_mismatch');
  end if;
  if new.invoice_date > now() + interval '1 day' then
    w := array_append(w, 'future_date');
  end if;
  new.warnings := w;
  return new;
end $$;

create or replace function public.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor text;
  b jsonb;
  a jsonb;
  rid text;
begin
  begin
    actor := (current_setting('request.headers', true)::jsonb) ->> 'x-actor';
  exception when others then actor := null;
  end;
  actor := coalesce(actor, nullif(current_setting('app.actor', true), ''), auth.uid()::text, current_user);
  -- never store token hashes in the log; keep a short fingerprint so rotations are visible
  if tg_op in ('UPDATE', 'DELETE') then
    b := to_jsonb(old);
    if b ? 'token_hash' then b := (b - 'token_hash') || jsonb_build_object('token_fingerprint', left(md5(coalesce(b ->> 'token_hash', '')), 8)); end if;
  end if;
  if tg_op in ('UPDATE', 'INSERT') then
    a := to_jsonb(new);
    if a ? 'token_hash' then a := (a - 'token_hash') || jsonb_build_object('token_fingerprint', left(md5(coalesce(a ->> 'token_hash', '')), 8)); end if;
  end if;
  if tg_op = 'UPDATE' and b = a then return new; end if;
  rid := coalesce((coalesce(a, b)) ->> 'id', (coalesce(a, b)) ->> 'key');
  insert into public.audit_log (actor, action, table_name, record_id, before, after)
  values (actor, tg_op, tg_table_name, rid, b, a);
  return coalesce(new, old);
end $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_users
    where auth_user_id = auth.uid() and role = 'admin' and active
  )
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- ---------------------------------------------------------------- triggers
do $$
declare t text;
begin
  foreach t in array array['bakery_expenses', 'grocery_expenses'] loop
    execute format('drop trigger if exists trg_updated_at on public.%I', t);
    execute format('create trigger trg_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
    execute format('drop trigger if exists trg_warnings on public.%I', t);
    execute format('create trigger trg_warnings before insert or update of total_amount, vat_amount, invoice_date on public.%I for each row execute function public.compute_expense_warnings()', t);
  end loop;
  foreach t in array array['bakery_expenses','grocery_expenses','app_users','app_settings','feature_flags','categories'] loop
    execute format('drop trigger if exists trg_audit on public.%I', t);
    execute format('create trigger trg_audit after insert or update or delete on public.%I for each row execute function public.audit_trigger()', t);
  end loop;
end $$;

drop trigger if exists trg_updated_at on public.app_settings;
create trigger trg_updated_at before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ===== supabase/migrations/20261015000002_rls_policies.sql =====
-- RLS everywhere. No anon access. Admins (app_users.role='admin', active) may SELECT.
-- There are deliberately NO insert/update/delete policies: writes use the service role in Val Town.

do $$
declare t text;
begin
  foreach t in array array['bakery_expenses','grocery_expenses','app_users','app_settings',
                           'feature_flags','categories','audit_log','whatsapp_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
  foreach t in array array['bakery_expenses','grocery_expenses','app_settings','feature_flags','categories','audit_log'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists admin_select on public.%I', t);
    execute format('create policy admin_select on public.%I for select to authenticated using (public.is_admin())', t);
  end loop;
end $$;

-- A signed-in user may read ONLY their own app_users row (to learn their role),
-- and never the token_hash column.
grant select (id, auth_user_id, name, phone_e164, role, sections, active, created_at)
  on public.app_users to authenticated;
drop policy if exists self_select on public.app_users;
create policy self_select on public.app_users for select to authenticated
  using (auth_user_id = auth.uid());
-- whatsapp_events: no policy => service role only.

-- ===== supabase/migrations/20261015000003_storage_realtime.sql =====
-- Private bucket for invoice images (service role only; browsers get signed URLs from the admin API).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('invoice-images', 'invoice-images', false)
    on conflict (id) do update set public = false;
  end if;
  -- Realtime on both expense tables
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.bakery_expenses;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.grocery_expenses;
    exception when duplicate_object then null; end;
  end if;
end $$;

-- ===== supabase/migrations/20261015000004_seed.sql =====
-- Default categories
insert into public.categories (section, name, name_ar) values
  ('bakery','Flour & Grains','دقيق وحبوب'),
  ('bakery','Sugar & Sweeteners','سكر ومحليات'),
  ('bakery','Dairy & Eggs','ألبان وبيض'),
  ('bakery','Packaging','تغليف'),
  ('bakery','Fuel & Gas','وقود وغاز'),
  ('bakery','Equipment & Maintenance','معدات وصيانة'),
  ('bakery','Utilities','مرافق'),
  ('bakery','Other','أخرى'),
  ('grocery','Fresh Produce','خضار وفواكه'),
  ('grocery','Meat & Poultry','لحوم ودواجن'),
  ('grocery','Beverages','مشروبات'),
  ('grocery','Dry Goods','مواد جافة'),
  ('grocery','Cleaning Supplies','مواد تنظيف'),
  ('grocery','Packaging','تغليف'),
  ('grocery','Other','أخرى')
on conflict (section, name) do nothing;

-- Default settings (all editable from the dashboard)
insert into public.app_settings (key, value) values
  ('company_name', '"مخابز إيمان جدة للخبز"'),
  ('company_name_en', '"Eman Bakery Jeddah"'),
  ('vat_rate', '0.15'),
  ('currency', '"SAR"'),
  ('timezone', '"Asia/Riyadh"'),
  ('alert_thresholds', '{"max_invoice_amount": 20000, "vat_tolerance_pct": 0.5, "notify_on_duplicate": true, "notify_on_vat_warning": true}'),
  ('report_schedule', '{"daily_enabled": true, "daily_hour": 21, "weekly_enabled": true, "weekly_day": "sat", "weekly_hour": 9}'),
  ('wa_flow_id', '""'),
  ('wa_trigger_words', '["مصروف","فاتورة","expense","invoice","hi","hello","مرحبا"]'),
  ('message_templates', '{
    "welcome":   {"en": "Welcome {{name}}. Tap the button to record an invoice.", "ar": "أهلاً {{name}}. اضغط الزر لتسجيل فاتورة."},
    "saved":     {"en": "Saved ✅\nSection: {{section}}\nSeller: {{seller}}\nTotal: {{total}} SAR\nVAT: {{vat}} SAR", "ar": "تم الحفظ ✅\nالقسم: {{section}}\nالمورد: {{seller}}\nالإجمالي: {{total}} ر.س\nالضريبة: {{vat}} ر.س"},
    "duplicate": {"en": "Duplicate ⚠️ This invoice was already recorded.", "ar": "مكررة ⚠️ هذه الفاتورة مسجلة مسبقاً."},
    "invalid":   {"en": "Could not read the invoice: {{reason}}", "ar": "تعذرت قراءة الفاتورة: {{reason}}"},
    "not_allowed": {"en": "This number is not registered. Please contact the administrator.", "ar": "هذا الرقم غير مسجل. يرجى التواصل مع المسؤول."},
    "admin_duplicate": {"en": "⚠️ Duplicate attempt by {{name}} in {{section}}: {{seller}} {{total}} SAR", "ar": "⚠️ محاولة تكرار من {{name}} في {{section}}: {{seller}} {{total}} ر.س"},
    "admin_vat_warning": {"en": "⚠️ VAT looks off ({{section}}): {{seller}} total {{total}}, VAT {{vat}}", "ar": "⚠️ الضريبة غير متوافقة ({{section}}): {{seller}} الإجمالي {{total}} الضريبة {{vat}}"}
  }')
on conflict (key) do nothing;

insert into public.feature_flags (key, enabled, description) values
  ('whatsapp_flow', true, 'Allow capture through the WhatsApp Flow'),
  ('whatsapp_text', true, 'Allow capture through plain WhatsApp text / Base64'),
  ('ios_shortcut', true, 'Allow capture through the iOS Shortcut endpoint'),
  ('confirm_to_submitter', true, 'Send a WhatsApp confirmation to the submitter'),
  ('alert_admins', true, 'Alert admins on duplicates and VAT warnings'),
  ('daily_summary', true, 'Send the daily summary per section'),
  ('weekly_report', true, 'Send the weekly report'),
  ('store_invoice_images', true, 'Store uploaded invoice photos in Storage')
on conflict (key) do nothing;

-- Bootstrap the first admin AFTER creating the Auth user (Dashboard > Authentication > Users):
--   select public.bootstrap_admin('admin@example.com', 'Admin Name', '+9665XXXXXXXX');
create or replace function public.bootstrap_admin(p_email text, p_name text, p_phone text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid; rid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then raise exception 'No auth user with email %. Create it in Supabase Auth first.', p_email; end if;
  insert into public.app_users (auth_user_id, name, phone_e164, role, sections, active)
  values (uid, p_name, p_phone, 'admin', array['bakery','grocery'], true)
  on conflict (auth_user_id) do update set role = 'admin', active = true, name = excluded.name
  returning id into rid;
  return rid;
end $$;
revoke all on function public.bootstrap_admin(text, text, text) from public, anon, authenticated;

-- ===== supabase/migrations/20261016000001_revenue_alerts_vat.sql =====
-- Revenue (Odoo sales), ZATCA monitoring, alerts, VAT return, accounts-staff role, purchases without VAT number.
-- Safe to run more than once.

-- ---------------------------------------------------------------- roles
alter table public.app_users drop constraint if exists app_users_role_check;
alter table public.app_users add constraint app_users_role_check check (role in ('admin', 'staff', 'accounts'));

create or replace function public.is_reviewer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_users
    where auth_user_id = auth.uid() and role in ('admin', 'accounts') and active
  )
$$;
create or replace function public.is_accounts() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_users
    where auth_user_id = auth.uid() and role = 'accounts' and active
  )
$$;
revoke all on function public.is_reviewer() from public, anon;
revoke all on function public.is_accounts() from public, anon;
grant execute on function public.is_reviewer() to authenticated, service_role;
grant execute on function public.is_accounts() to authenticated, service_role;

-- ---------------------------------------------------------------- purchases: allow invoices without a valid 15-digit VAT number
-- They are stored and reported, but never counted as input VAT (vat_valid = false).
do $$
declare t text;
begin
  foreach t in array array['bakery_expenses', 'grocery_expenses'] loop
    execute format('alter table public.%I alter column vat_number drop not null', t);
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_vat_number_chk');
    execute format($f$alter table public.%I add column if not exists vat_valid boolean
      generated always as (vat_number is not null and vat_number ~ '^[0-9]{15}$') stored$f$, t);
  end loop;
end $$;

create or replace function public.compute_expense_warnings() returns trigger
language plpgsql set search_path = public as $$
declare
  rate numeric := 0.15;
  net numeric;
  expected numeric;
  w text[] := '{}';
begin
  begin
    select (value #>> '{}')::numeric into rate from public.app_settings where key = 'vat_rate';
  exception when others then rate := 0.15;
  end;
  rate := coalesce(rate, 0.15);
  net := new.total_amount - new.vat_amount;
  expected := round(net * rate, 2);
  if new.vat_number is null or new.vat_number !~ '^[0-9]{15}$' then
    w := array_append(w, 'vat_number_invalid');   -- shown in reports, excluded from input VAT
  end if;
  if net <= 0 and new.vat_amount > 0 then
    w := array_append(w, 'vat_rate_mismatch');
  elsif abs(new.vat_amount - expected) > (0.05 + 0.005 * net) then
    w := array_append(w, 'vat_rate_mismatch');
  end if;
  if new.invoice_date > now() + interval '1 day' then
    w := array_append(w, 'future_date');
  end if;
  new.warnings := w;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['bakery_expenses', 'grocery_expenses'] loop
    execute format('drop trigger if exists trg_warnings on public.%I', t);
    execute format('create trigger trg_warnings before insert or update of total_amount, vat_amount, invoice_date, vat_number on public.%I for each row execute function public.compute_expense_warnings()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- sales (read-only copy of Odoo customer invoices / credit notes)
create table if not exists public.sales_invoices (
  odoo_id bigint primary key,
  section text not null default 'bakery' check (section in ('bakery', 'grocery')),
  number text,
  kind text not null check (kind in ('invoice', 'credit_note')),
  state text not null,
  invoice_date date,
  odoo_created_at timestamptz,
  odoo_write_at timestamptz,
  salesman_id integer,
  salesman_name text,
  created_by_id integer,
  created_by_name text,
  customer_id integer,
  customer_name text,
  customer_vat text,
  segment text generated always as (case when coalesce(btrim(customer_vat), '') <> '' then 'B2B' else 'B2C' end) stored,
  amount_untaxed numeric(14,2) not null default 0,
  amount_tax numeric(14,2) not null default 0,
  amount_total numeric(14,2) not null default 0,
  payment_state text,
  origin text,
  ref text,
  reversed_odoo_id bigint,
  reversed_number text,
  zatca_state text,
  zatca_uuid text,
  zatca_chain_index bigint,
  zatca_confirmed_at timestamptz,
  zatca_error text,
  synced_at timestamptz not null default now()
);
create index if not exists sales_invoices_date_idx on public.sales_invoices (invoice_date);
create index if not exists sales_invoices_salesman_idx on public.sales_invoices (salesman_id, invoice_date);
create index if not exists sales_invoices_kind_idx on public.sales_invoices (kind, invoice_date);
create index if not exists sales_invoices_write_idx on public.sales_invoices (odoo_write_at);
create index if not exists sales_invoices_zatca_idx on public.sales_invoices (zatca_state) where state = 'posted';
create index if not exists sales_invoices_created_idx on public.sales_invoices (odoo_created_at);

-- Grocery is sold in a system without an API: totals are entered by hand for now (all B2C).
create table if not exists public.grocery_sales_daily (
  sale_date date primary key,
  net_sales numeric(14,2) not null default 0 check (net_sales >= 0),
  vat_amount numeric(14,2) not null default 0 check (vat_amount >= 0),
  credit_net numeric(14,2) not null default 0 check (credit_net >= 0),
  credit_vat numeric(14,2) not null default 0 check (credit_vat >= 0),
  invoice_count integer not null default 0 check (invoice_count >= 0),
  notes text,
  entered_by text,
  updated_at timestamptz
);

create table if not exists public.vat_payments (
  id uuid primary key default gen_random_uuid(),
  period_year integer not null check (period_year between 2020 and 2100),
  period_quarter integer not null check (period_quarter between 1 and 4),
  amount_paid numeric(14,2) not null check (amount_paid >= 0),
  paid_on date,
  reference text,
  notes text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists vat_payments_period_idx on public.vat_payments (period_year, period_quarter);

-- ---------------------------------------------------------------- alerts, sync log, verification log
create table if not exists public.alerts (
  id bigint generated always as identity primary key,
  rule_key text not null,
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  title text not null,
  detail jsonb not null default '{}',
  section text not null default 'bakery',
  salesman_name text,
  odoo_id bigint,
  amount numeric(14,2),
  fingerprint text not null unique,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  note text,
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists alerts_status_idx on public.alerts (status, created_at desc);
create index if not exists alerts_rule_idx on public.alerts (rule_key, created_at desc);

create table if not exists public.sync_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_runs (
  id bigint generated always as identity primary key,
  kind text not null default 'incremental',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched integer not null default 0,
  upserted integer not null default 0,
  alerts_created integer not null default 0,
  error text,
  details jsonb
);
create index if not exists sync_runs_started_idx on public.sync_runs (started_at desc);

create table if not exists public.verification_runs (
  id bigint generated always as identity primary key,
  kind text not null,
  period_from date,
  period_to date,
  ok boolean not null,
  result jsonb not null,
  run_by text,
  created_at timestamptz not null default now()
);
create index if not exists verification_runs_created_idx on public.verification_runs (created_at desc);

-- audit trail for the data an admin edits by hand
do $$
declare t text;
begin
  foreach t in array array['grocery_sales_daily', 'vat_payments'] loop
    execute format('drop trigger if exists trg_audit on public.%I', t);
    execute format('create trigger trg_audit after insert or update or delete on public.%I for each row execute function public.audit_trigger()', t);
  end loop;
  execute 'drop trigger if exists trg_audit_alerts on public.alerts';
  execute 'create trigger trg_audit_alerts after update or delete on public.alerts for each row execute function public.audit_trigger()';
end $$;
create or replace function public.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor text; b jsonb; a jsonb; rid text;
begin
  begin
    actor := (current_setting('request.headers', true)::jsonb) ->> 'x-actor';
  exception when others then actor := null;
  end;
  actor := coalesce(actor, nullif(current_setting('app.actor', true), ''), auth.uid()::text, current_user);
  if tg_op in ('UPDATE', 'DELETE') then
    b := to_jsonb(old);
    if b ? 'token_hash' then b := (b - 'token_hash') || jsonb_build_object('token_fingerprint', left(md5(coalesce(b ->> 'token_hash', '')), 8)); end if;
  end if;
  if tg_op in ('UPDATE', 'INSERT') then
    a := to_jsonb(new);
    if a ? 'token_hash' then a := (a - 'token_hash') || jsonb_build_object('token_fingerprint', left(md5(coalesce(a ->> 'token_hash', '')), 8)); end if;
  end if;
  if tg_op = 'UPDATE' and b = a then return new; end if;
  rid := coalesce((coalesce(a, b)) ->> 'id', (coalesce(a, b)) ->> 'key', (coalesce(a, b)) ->> 'sale_date');
  insert into public.audit_log (actor, action, table_name, record_id, before, after)
  values (actor, tg_op, tg_table_name, rid, b, a);
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------- row level security
do $$
declare t text;
begin
  foreach t in array array['sales_invoices', 'grocery_sales_daily', 'vat_payments', 'alerts', 'sync_state', 'sync_runs', 'verification_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  foreach t in array array['grocery_sales_daily', 'vat_payments', 'verification_runs'] loop
    execute format('drop policy if exists admin_select on public.%I', t);
    execute format('create policy admin_select on public.%I for select to authenticated using (public.is_admin())', t);
  end loop;
  foreach t in array array['alerts', 'sync_state', 'sync_runs'] loop
    execute format('drop policy if exists reviewer_select on public.%I', t);
    execute format('create policy reviewer_select on public.%I for select to authenticated using (public.is_reviewer())', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to service_role;

-- Sales: admins see everything; accounts staff see only credit notes and ZATCA problem documents (monitoring).
drop policy if exists admin_select on public.sales_invoices;
drop policy if exists accounts_monitor on public.sales_invoices;
create policy admin_select on public.sales_invoices for select to authenticated using (public.is_admin());
create policy accounts_monitor on public.sales_invoices for select to authenticated
  using (public.is_accounts() and (kind = 'credit_note' or state <> 'posted' or zatca_state is distinct from 'sent'));

-- ---------------------------------------------------------------- aggregate functions (security invoker => RLS applies)
create or replace function public.revenue_summary(
  p_from date, p_to date, p_group text default 'day', p_segment text default null, p_section text default 'bakery'
) returns table (
  bucket text, label text,
  invoice_count bigint, net_sales numeric, vat numeric, total numeric,
  credit_count bigint, credit_net numeric, credit_vat numeric, credit_total numeric,
  net_after_credit numeric, vat_after_credit numeric, total_after_credit numeric
) language sql stable set search_path = public as $$
  with base as (
    select
      case p_group
        when 'month' then to_char(invoice_date, 'YYYY-MM')
        when 'salesman' then coalesce(salesman_id::text, '0')
        when 'customer' then coalesce(customer_id::text, '0')
        when 'segment' then segment
        else invoice_date::text
      end as b,
      case p_group
        when 'month' then to_char(invoice_date, 'YYYY-MM')
        when 'salesman' then coalesce(salesman_name, '—')
        when 'customer' then coalesce(customer_name, '—')
        when 'segment' then segment
        else invoice_date::text
      end as l,
      kind, amount_untaxed, amount_tax, amount_total
    from public.sales_invoices
    where state = 'posted' and section = p_section
      and invoice_date between p_from and p_to
      and (p_segment is null or segment = p_segment)
  )
  select
    b, max(l),
    count(*) filter (where kind = 'invoice'),
    coalesce(sum(amount_untaxed) filter (where kind = 'invoice'), 0),
    coalesce(sum(amount_tax) filter (where kind = 'invoice'), 0),
    coalesce(sum(amount_total) filter (where kind = 'invoice'), 0),
    count(*) filter (where kind = 'credit_note'),
    coalesce(sum(amount_untaxed) filter (where kind = 'credit_note'), 0),
    coalesce(sum(amount_tax) filter (where kind = 'credit_note'), 0),
    coalesce(sum(amount_total) filter (where kind = 'credit_note'), 0),
    coalesce(sum(case when kind = 'invoice' then amount_untaxed else -amount_untaxed end), 0),
    coalesce(sum(case when kind = 'invoice' then amount_tax else -amount_tax end), 0),
    coalesce(sum(case when kind = 'invoice' then amount_total else -amount_total end), 0)
  from base group by b order by b;
$$;
grant execute on function public.revenue_summary(date, date, text, text, text) to authenticated, service_role;

-- Quarterly VAT figures (management view, NOT an official return). Purchases count only with a valid 15-digit VAT number.
create or replace function public.vat_return(p_year integer, p_quarter integer)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  d_from date; d_to date;
  bakery_sales jsonb; grocery_sales jsonb; purchases jsonb; paid numeric;
begin
  if p_quarter not between 1 and 4 then raise exception 'quarter must be 1..4'; end if;
  d_from := make_date(p_year, (p_quarter - 1) * 3 + 1, 1);
  d_to := (d_from + interval '3 months' - interval '1 day')::date;
  select jsonb_build_object(
    'net', coalesce(sum(amount_untaxed) filter (where kind = 'invoice'), 0),
    'vat', coalesce(sum(amount_tax) filter (where kind = 'invoice'), 0),
    'credit_net', coalesce(sum(amount_untaxed) filter (where kind = 'credit_note'), 0),
    'credit_vat', coalesce(sum(amount_tax) filter (where kind = 'credit_note'), 0),
    'invoices', count(*) filter (where kind = 'invoice'),
    'credit_notes', count(*) filter (where kind = 'credit_note'))
  into bakery_sales
  from public.sales_invoices where state = 'posted' and section = 'bakery' and invoice_date between d_from and d_to;

  select jsonb_build_object(
    'net', coalesce(sum(net_sales), 0), 'vat', coalesce(sum(vat_amount), 0),
    'credit_net', coalesce(sum(credit_net), 0), 'credit_vat', coalesce(sum(credit_vat), 0),
    'invoices', coalesce(sum(invoice_count), 0), 'days_entered', count(*))
  into grocery_sales
  from public.grocery_sales_daily where sale_date between d_from and d_to;

  select jsonb_build_object(
    'bakery', (select jsonb_build_object(
        'counted_net', coalesce(sum(total_amount - vat_amount) filter (where vat_valid), 0),
        'counted_vat', coalesce(sum(vat_amount) filter (where vat_valid), 0),
        'counted_invoices', count(*) filter (where vat_valid),
        'excluded_total', coalesce(sum(total_amount) filter (where not vat_valid), 0),
        'excluded_vat', coalesce(sum(vat_amount) filter (where not vat_valid), 0),
        'excluded_invoices', count(*) filter (where not vat_valid))
      from public.bakery_expenses where (invoice_date at time zone 'Asia/Riyadh')::date between d_from and d_to),
    'grocery', (select jsonb_build_object(
        'counted_net', coalesce(sum(total_amount - vat_amount) filter (where vat_valid), 0),
        'counted_vat', coalesce(sum(vat_amount) filter (where vat_valid), 0),
        'counted_invoices', count(*) filter (where vat_valid),
        'excluded_total', coalesce(sum(total_amount) filter (where not vat_valid), 0),
        'excluded_vat', coalesce(sum(vat_amount) filter (where not vat_valid), 0),
        'excluded_invoices', count(*) filter (where not vat_valid))
      from public.grocery_expenses where (invoice_date at time zone 'Asia/Riyadh')::date between d_from and d_to))
  into purchases;

  select coalesce(sum(amount_paid), 0) into paid from public.vat_payments where period_year = p_year and period_quarter = p_quarter;

  return jsonb_build_object(
    'year', p_year, 'quarter', p_quarter, 'from', d_from, 'to', d_to,
    'bakery_sales', bakery_sales, 'grocery_sales', grocery_sales, 'purchases', purchases, 'paid', paid);
end $$;
grant execute on function public.vat_return(integer, integer) to authenticated, service_role;

-- Per-salesman statistics for the alert engine (service role only)
create or replace function public.salesman_stats(p_days integer default 30)
returns table (salesman_id integer, salesman_name text, invoices bigint, avg_amount numeric, max_amount numeric, active_days bigint, zero_tax_invoices bigint)
language sql stable set search_path = public as $$
  select salesman_id, max(salesman_name), count(*), coalesce(avg(amount_total), 0), coalesce(max(amount_total), 0),
         count(distinct invoice_date), count(*) filter (where amount_tax = 0 and amount_total > 0)
  from public.sales_invoices
  where kind = 'invoice' and state = 'posted' and invoice_date >= current_date - p_days
  group by salesman_id;
$$;
revoke all on function public.salesman_stats(integer) from public, anon, authenticated;
grant execute on function public.salesman_stats(integer) to service_role;

create or replace function public.salesman_daily_totals(p_days integer default 15)
returns table (salesman_id integer, salesman_name text, day date, total numeric, invoices bigint)
language sql stable set search_path = public as $$
  select salesman_id, max(salesman_name), invoice_date, sum(amount_total), count(*)
  from public.sales_invoices
  where kind = 'invoice' and state = 'posted' and invoice_date >= current_date - p_days
  group by salesman_id, invoice_date;
$$;
revoke all on function public.salesman_daily_totals(integer) from public, anon, authenticated;
grant execute on function public.salesman_daily_totals(integer) to service_role;

-- Missing invoice numbers (gaps) in the recent past; number format "PREFIX/YYYY/NNNNN"
create or replace function public.invoice_number_gaps(p_since date default current_date - 3)
returns table (gap_from bigint, gap_to bigint, prefix text)
language sql stable set search_path = public as $$
  with n as (
    select regexp_replace(number, '/[0-9]+$', '') as prefix,
           (regexp_match(number, '/([0-9]+)$'))[1]::bigint as seq
    from public.sales_invoices
    where kind = 'invoice' and number ~ '/[0-9]+$' and odoo_created_at >= p_since and odoo_created_at < now() - interval '30 minutes'
  ), s as (
    select prefix, seq, lag(seq) over (partition by prefix order by seq) as prev from n
  )
  select prev + 1, seq - 1, prefix from s where prev is not null and seq - prev > 1;
$$;
revoke all on function public.invoice_number_gaps(date) from public, anon, authenticated;
grant execute on function public.invoice_number_gaps(date) to service_role;

create or replace function public.db_size_bytes() returns bigint
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() and current_user <> 'service_role' then raise exception 'not allowed'; end if;
  return pg_database_size(current_database());
end $$;
revoke all on function public.db_size_bytes() from public, anon;
grant execute on function public.db_size_bytes() to authenticated, service_role;

-- ---------------------------------------------------------------- realtime for alerts
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.alerts;
    exception when duplicate_object then null; end;
  end if;
end $$;

-- ---------------------------------------------------------------- default settings (all editable in the dashboard)
insert into public.app_settings (key, value) values
  ('sync_settings', '{"enabled": true, "interval_minutes": 5, "history_months": 12, "batch_size": 400, "pause_ms": 400, "max_run_seconds": 25}'),
  ('zatca_thresholds', '{"b2b_minutes": 5, "b2c_hours": 24, "b2c_warn_hours": 12}'),
  ('alert_channels', '{"dashboard": true, "whatsapp": false, "email": false, "email_to": []}'),
  ('working_hours', '{"start_hour": 5, "end_hour": 23}'),
  ('alert_rules', '{
    "credit_any": {"enabled": true, "severity": "warning"},
    "credit_amount": {"enabled": true, "severity": "critical", "min_amount": 500},
    "credit_per_salesman_day": {"enabled": true, "severity": "warning", "max_per_day": 3},
    "credit_old_invoice": {"enabled": true, "severity": "warning", "max_age_days": 3},
    "credit_by_office": {"enabled": true, "severity": "info", "office_users": ["EMAN BAKERY"]},
    "credit_no_reason": {"enabled": true, "severity": "warning"},
    "credit_period_end": {"enabled": true, "severity": "warning", "days_before_quarter_end": 5},
    "refund_unlinked": {"enabled": true, "severity": "warning"},
    "tiny_invoice": {"enabled": true, "severity": "info", "max_amount": 2},
    "zero_tax_invoice": {"enabled": true, "severity": "warning"},
    "zero_tax_ratio": {"enabled": true, "severity": "warning", "min_ratio_pct": 20, "min_invoices": 10, "window_days": 7},
    "invoice_cancelled": {"enabled": true, "severity": "critical"},
    "invoice_backdated": {"enabled": true, "severity": "warning", "max_days": 1},
    "number_gap": {"enabled": true, "severity": "critical"},
    "duplicate_burst": {"enabled": true, "severity": "warning", "window_minutes": 10, "min_count": 3},
    "unusual_amount": {"enabled": true, "severity": "warning", "multiplier": 8, "min_amount": 1000},
    "off_hours": {"enabled": true, "severity": "info"},
    "sales_drop": {"enabled": true, "severity": "warning", "drop_pct": 60, "check_after_hour": 15, "min_usual_amount": 500},
    "no_sales_by_time": {"enabled": false, "severity": "info", "by_hour": 11},
    "unpaid_invoice": {"enabled": false, "severity": "info", "after_hours": 72},
    "zatca_delay_b2b": {"enabled": true, "severity": "critical"},
    "zatca_delay_b2c": {"enabled": true, "severity": "warning"},
    "zatca_error": {"enabled": true, "severity": "critical"},
    "zatca_chain_gap": {"enabled": true, "severity": "critical"}
  }')
on conflict (key) do nothing;

insert into public.feature_flags (key, enabled, description) values
  ('odoo_sync', true, 'Pull sales invoices and credit notes from Odoo (read-only)'),
  ('revenue_alerts', true, 'Create alerts for credit notes, ZATCA problems and unusual sales')
on conflict (key) do nothing;
