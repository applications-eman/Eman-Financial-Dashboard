-- Speed: the revenue/VAT screens timed out ("canceling statement due to statement timeout") on 220,000+ invoices.
-- Cause: the row-level-security checks called is_admin()/is_accounts() once PER ROW.
-- Wrapping them in (select ...) makes Postgres evaluate them once per query. Same rules, same access, just fast.
-- Re-runnable.

drop policy if exists admin_select on public.sales_invoices;
drop policy if exists accounts_monitor on public.sales_invoices;
create policy admin_select on public.sales_invoices for select to authenticated using ((select public.is_admin()));
create policy accounts_monitor on public.sales_invoices for select to authenticated
  using ((select public.is_accounts()) and (kind = 'credit_note' or state <> 'posted' or zatca_state is distinct from 'sent'));

do $$
declare t text;
begin
  foreach t in array array['alerts', 'sync_state', 'sync_runs'] loop
    execute format('drop policy if exists reviewer_select on public.%I', t);
    execute format('create policy reviewer_select on public.%I for select to authenticated using ((select public.is_reviewer()))', t);
  end loop;
  foreach t in array array['grocery_sales_daily', 'vat_payments', 'verification_runs'] loop
    execute format('drop policy if exists admin_select on public.%I', t);
    execute format('create policy admin_select on public.%I for select to authenticated using ((select public.is_admin()))', t);
  end loop;
end $$;

-- the report queries always filter on section + state + invoice date
create index if not exists sales_invoices_report_idx on public.sales_invoices (section, state, invoice_date);
analyze public.sales_invoices;
