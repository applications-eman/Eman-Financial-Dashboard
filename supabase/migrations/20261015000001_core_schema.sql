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
