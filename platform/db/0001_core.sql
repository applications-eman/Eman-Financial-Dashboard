-- Eman platform database, part 1: routing registry, salesmen, customers, products, invoice requests and queue, audit.
-- Run once in the Supabase SQL editor of the NEW project (eman-platform). Safe to run again: everything is "if not exists".
-- Access model: only the platform service (service role key) reads and writes these tables.
-- Row level security is ON with no policies, so the browser keys (anon / authenticated) can reach nothing.

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ------------------------------------------------------------------ WhatsApp router registry
create table if not exists public.wa_targets (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  name text not null,
  url text not null check (url like 'https://%'),
  secret text,
  enabled boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- one WhatsApp number belongs to exactly ONE service (primary key)
create table if not exists public.wa_numbers (
  phone text primary key check (phone ~ '^[0-9]{8,15}$'),
  target_id text not null references public.wa_targets(id) on update cascade,
  role text not null default 'user',
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- durable duplicate guard for Meta's retries (works across several router instances)
create table if not exists public.wa_messages_seen (
  message_id text primary key,
  seen_at timestamptz not null default now()
);
create index if not exists wa_messages_seen_at on public.wa_messages_seen (seen_at);

-- ------------------------------------------------------------------ people, customers, products
create table if not exists public.salesmen (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,30}$'),   -- stable short code, also used in Odoo references
  name text not null,
  phone text not null unique references public.wa_numbers(phone) on update cascade,
  language text not null default 'en' check (language in ('en', 'ml')),
  status text not null default 'inactive' check (status in ('inactive', 'active', 'frozen')),
  daily_limit integer check (daily_limit is null or daily_limit > 0),
  odoo_analytic_id bigint,                  -- the salesman's analytic account in Odoo (reports per salesman)
  activated_at timestamptz,
  activated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  odoo_partner_id bigint unique,
  name text not null,
  vat text,
  status text not null default 'active' check (status in ('active', 'frozen')),
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customers_name on public.customers (lower(name));

-- which customers a salesman may invoice (starts from his invoice history, the admin can add or remove)
create table if not exists public.salesman_customers (
  salesman_id uuid not null references public.salesmen(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  source text not null default 'admin' check (source in ('history', 'admin')),
  created_at timestamptz not null default now(),
  primary key (salesman_id, customer_id)
);
create index if not exists salesman_customers_customer on public.salesman_customers (customer_id);

create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order integer not null default 0,
  active boolean not null default true
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  odoo_product_id bigint unique,
  name text not null,
  category_id uuid references public.product_categories(id) on delete set null,
  max_price numeric(12, 2) check (max_price is null or max_price > 0),   -- before VAT; null = cannot be invoiced
  status text not null default 'active' check (status in ('active', 'frozen')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_category on public.products (category_id);

create table if not exists public.product_price_history (
  id bigserial primary key,
  product_id uuid not null references public.products(id) on delete cascade,
  old_max numeric(12, 2),
  new_max numeric(12, 2),
  changed_by text,
  changed_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ invoice requests and the queue
create table if not exists public.invoice_requests (
  id uuid primary key default gen_random_uuid(),
  request_key text not null unique,                       -- idempotency key (Flow token / message id): a repeat can never create a second row
  ref_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),   -- short reference shown to the salesman and the accounts team
  salesman_id uuid not null references public.salesmen(id),
  customer_id uuid not null references public.customers(id),
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 200),
  subtotal numeric(14, 2) not null check (subtotal >= 0),
  vat numeric(14, 2) not null check (vat >= 0),
  total numeric(14, 2) not null check (total >= 0),
  content_hash text not null,                             -- same salesman + customer + lines = same hash (business duplicate check)
  status text not null default 'received' check (status in
    ('received', 'awaiting_approval', 'queued', 'processing', 'cleared', 'rejected', 'failed', 'duplicate_blocked', 'cancelled')),
  attempts integer not null default 0,
  worker text,
  lease_until timestamptz,
  odoo_move_id bigint,
  invoice_number text,
  zatca_status text,
  zatca_uuid text,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists invoice_requests_queue on public.invoice_requests (status, created_at);
create index if not exists invoice_requests_dup on public.invoice_requests (salesman_id, customer_id, content_hash, created_at desc);
create index if not exists invoice_requests_salesman on public.invoice_requests (salesman_id, created_at desc);

create table if not exists public.invoice_request_events (
  id bigserial primary key,
  request_id uuid not null references public.invoice_requests(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  detail jsonb
);
create index if not exists invoice_request_events_req on public.invoice_request_events (request_id, at);

-- a deliberate repeat needs a supervisor's decision
create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.invoice_requests(id) on delete cascade,
  reason text,
  requested_at timestamptz not null default now(),
  decision text check (decision in ('approved', 'rejected')),
  decided_by text,
  decided_at timestamptz,
  check ((decision is null) = (decided_at is null))
);

-- ------------------------------------------------------------------ settings, secrets, audit
create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.platform_settings (key, value) values
  ('duplicate_window_minutes', '30'),
  ('max_lines_per_invoice', '20'),
  ('kill_switch', 'false'),
  ('queue_alert_length', '20'),
  ('queue_alert_wait_minutes', '10')
on conflict (key) do nothing;

-- secrets typed in the admin screen (Odoo key, Meta token): stored ENCRYPTED by the service; the master key lives in Secret Manager
create table if not exists public.secret_values (
  name text primary key,
  ciphertext text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb
);
create index if not exists audit_log_at on public.audit_log (at desc);
create index if not exists audit_log_entity on public.audit_log (entity, entity_id);

-- ------------------------------------------------------------------ queue helpers
-- one worker at a time takes the OLDEST queued request. A request whose worker died (lease expired) comes back.
-- The worker must always search Odoo for an invoice with this request's reference before creating one.
create or replace function public.claim_next_invoice_job(p_worker text, p_lease_seconds integer default 120)
returns setof public.invoice_requests language sql as $$
  update public.invoice_requests r
     set status = 'processing', worker = p_worker, lease_until = now() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(r.started_at, now()), attempts = r.attempts + 1
   where r.id = (
     select q.id from public.invoice_requests q
      where q.status = 'queued' or (q.status = 'processing' and q.lease_until < now())
      order by q.created_at
      for update skip locked
      limit 1)
  returning r.*;
$$;

-- a lease that makes sure only ONE worker posts invoices at a time (ZATCA chain). Returns true if this holder has the lock.
create table if not exists public.worker_locks (
  name text primary key,
  holder text not null,
  lease_until timestamptz not null
);
create or replace function public.acquire_lock(p_name text, p_holder text, p_seconds integer)
returns boolean language plpgsql as $$
declare ok boolean;
begin
  insert into public.worker_locks as l (name, holder, lease_until)
  values (p_name, p_holder, now() + make_interval(secs => p_seconds))
  on conflict (name) do update
     set holder = excluded.holder, lease_until = excluded.lease_until
   where l.holder = p_holder or l.lease_until < now()
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.purge_seen_messages(p_older interval default interval '2 days')
returns integer language sql as $$
  with d as (delete from public.wa_messages_seen where seen_at < now() - p_older returning 1) select count(*)::integer from d;
$$;

-- ------------------------------------------------------------------ updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['wa_targets', 'wa_numbers', 'salesmen', 'customers', 'products', 'invoice_requests'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_updated', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_updated', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ lock everything for browser keys
do $$
declare t text;
begin
  foreach t in array array['wa_targets', 'wa_numbers', 'wa_messages_seen', 'salesmen', 'customers', 'salesman_customers',
    'product_categories', 'products', 'product_price_history', 'invoice_requests', 'invoice_request_events', 'approvals',
    'platform_settings', 'secret_values', 'audit_log', 'worker_locks'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke execute on all functions in schema public from anon, authenticated;
  end if;
end $$;
