-- Platform database, part 3: the WhatsApp invoice Flow keeps each salesman's unfinished invoice here.
-- Run once in the Supabase SQL editor of the platform project (after 0001 and 0002). Safe to run again.

create table if not exists public.flow_sessions (
  token text primary key,                                  -- unpredictable Flow token we hand to WhatsApp
  salesman_id uuid not null references public.salesmen(id),
  customer_id uuid references public.customers(id),
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  request_id uuid references public.invoice_requests(id),  -- set when the salesman confirmed
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists flow_sessions_salesman on public.flow_sessions (salesman_id, created_at desc);
create index if not exists flow_sessions_expiry on public.flow_sessions (expires_at);

alter table public.flow_sessions enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.flow_sessions from anon, authenticated;
  end if;
end $$;

create or replace function public.purge_flow_sessions()
returns integer language sql as $$
  with d as (delete from public.flow_sessions where expires_at < now() - interval '2 days' returning 1) select count(*)::integer from d;
$$;
