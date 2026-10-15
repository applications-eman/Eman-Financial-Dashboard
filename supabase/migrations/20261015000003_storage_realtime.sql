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
