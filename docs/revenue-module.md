# Revenue module (Odoo 17, read-only)

## What it does
- Val Town reads invoices and credit notes from Odoo 17 (`account.move`, types out_invoice / out_refund) with a read-only client and stores them in Supabase (`sales_invoices`).
- Dashboard pages: **Revenue**, **Grocery Sales** (manual daily totals), **VAT Return** (+ payments register), **Alerts**, **ZATCA** (the last two are also open to the `accounts` role).
- B2B = customer has a VAT number, otherwise B2C. Amounts are shown excl. VAT, VAT and total, net of credit notes.
- **Verify data** re-reads Odoo live for a period and compares with the dashboard; each run is stored.

## Safety
- `valtown/lib/odoo.ts` only allows `search_read, read, search_count, fields_get, read_group, search, name_get`. Any other method (write, create, unlink, action_*, button_*) throws before a request is made (tested).
- Requests are spaced at least 300 ms apart, retried with back-off on 429/5xx, and each run has a time budget (`sync_settings.max_run_seconds`).
- Changing the Odoo user later = change `ODOO_LOGIN` / `ODOO_API_KEY` in Val Town. Nothing else.

## Val Town variables
`ODOO_URL`, `ODOO_DB`, `ODOO_LOGIN`, `ODOO_API_KEY` (all set).

## Switching it on (in this order)
1. Apply `supabase/migrations/20261016000001_revenue_alerts_vat.sql` (SQL Editor, or the **Migrate database** GitHub workflow).
2. In the dashboard open **Feature Flags** and switch `odoo_sync` on.
3. Open **Revenue** and press **Sync now** until "still importing history" disappears (12 months, headers only, in small batches).

## Schedule
The Val Town free plan allows an interval of 15 minutes at the shortest, so `cron-sync.ts` runs every 15 minutes (and **Sync now** is available any time). The effective interval can only be longer than that via `sync_settings.interval_minutes`.

## Settings (Settings page, JSON)
`sync_settings`, `alert_rules` (every rule can be enabled/disabled and tuned), `zatca_thresholds`, `alert_channels` (WhatsApp/email are off; system alerts only), `working_hours`.

## Accounts role
Create a user in **Users** with role *Accounts* and link their Supabase Auth user id. They see only **Alerts** and **ZATCA**, and can acknowledge alerts with a note. Database rules (RLS) enforce this, not just the menu.

## Notes
- VAT Return figures are management figures; the accountant should verify them.
- Purchases count toward input VAT only with a valid 15-digit VAT number; the rest are listed as "not counted".
- Free Supabase plan: 500 MB. The Revenue page shows database size. Only invoice headers are stored (no lines, no products).
