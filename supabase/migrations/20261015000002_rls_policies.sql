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
