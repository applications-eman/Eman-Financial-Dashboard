-- Platform database, part 4: one service can be the DEFAULT (e.g. the existing expense capture). It receives every WhatsApp
-- sender that no other service has claimed, so putting the router in front cuts nobody off.
-- Run once in the Supabase SQL editor of the platform project (after 0001-0003) and BEFORE deploying the router. Safe to run again.

alter table public.wa_targets add column if not exists is_default boolean not null default false;
create unique index if not exists wa_targets_one_default on public.wa_targets (is_default) where is_default;
