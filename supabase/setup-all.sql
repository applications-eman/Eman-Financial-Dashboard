-- Eman Expenses: complete database setup (generated: concatenation of supabase/migrations/*.sql in order).
-- Paste ALL of this into Supabase > SQL Editor > New query, then press Run. Safe to run more than once.

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
