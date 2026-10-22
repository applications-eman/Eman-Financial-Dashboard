-- Platform database, part 2: who may use the admin functions.
-- The dashboard login is trusted (same sign-in), but WHAT a person may do here is decided by this table.
-- Run once in the Supabase SQL editor of the platform project (after 0001). Safe to run again.

create table if not exists public.platform_admins (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  auth_user_id text,                         -- optional: the dashboard user id; matched by e-mail when empty
  role text not null check (role in ('admin', 'supervisor', 'accountant')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text
);
create unique index if not exists platform_admins_email on public.platform_admins (lower(email));
alter table public.platform_admins enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.platform_admins from anon, authenticated;
  end if;
end $$;
