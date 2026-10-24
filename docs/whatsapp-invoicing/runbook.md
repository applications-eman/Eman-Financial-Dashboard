# WhatsApp invoicing: operations runbook

For the accounts team and the owner. Plain steps; nothing here needs programming.

## Adding things (one place only)
Everything is added in the dashboard; Odoo receives it at once.
- **Customer:** Customers tab, name (and VAT number for a company, then its address). It is created in Odoo by itself. Then give it to the salesmen.
- **Product:** Products tab, name, category, maximum price. It is created in Odoo (the maximum price is its Sales Price there, with the standard 15% VAT).
- **Changing or deleting:** changes follow into Odoo; a delete archives the record in Odoo (Odoo keeps what has history).
- **Something that already exists in Odoo:** Settings > "Import and link from Odoo" brings it in.
- If Odoo refuses (for example a wrong VAT number), the dashboard shows Odoo's reason and nothing is saved.

## Every day (2 minutes)
1. Dashboard > WhatsApp Platform > **Settings**. The top card must say **"Everything is working"**. If it lists a problem, follow the table below.
2. **Invoices** tab, filter by status: look at anything *failed* or *rejected* from the last day. Each row has the reference the salesman was given.

## What the salesman sees, and what to do
| Message | Meaning | What to do |
|---|---|---|
| "We could not create your invoice... Reason: ..." | Nothing was issued. The reason is in the message. | Fix the reason (for example a product without VAT in Odoo), then ask the salesman to create it again. |
| "ZATCA did not accept this invoice. Reason: ..." | The invoice exists in Odoo but ZATCA refused it. | Fix the data named in the reason in Odoo (customer address, VAT number, ...), then in Odoo open the invoice and use Send & Print again. Never create a second invoice for it. |
| "...cleared by ZATCA, but the PDF could not be sent to you (why)" | The invoice is valid. Only the delivery failed. | The salesman taps **Send PDF again**. If it keeps failing, send the PDF from Odoo by hand. |
| "Waiting for ZATCA clearance. Do not create it again." | Odoo has not had ZATCA's answer yet. | Wait. The platform asks again by itself and retries up to 3 times later. If it is still open after 2 hours, open the invoice in Odoo. |
| "A similar invoice was created ... needs supervisor approval" | The duplicate rule fired. | A supervisor decides in the dashboard under Approvals. |

## Health card: what each problem means
- **The oldest invoice has waited N minutes**: the queue is stuck. Check Odoo is reachable; open Cloud Run > eman-platform > Logs.
- **Odoo cannot be reached**: Odoo is down or the API key is wrong or expired. See "Odoo key" below.
- **The Odoo API key expires in N days**: create a new key now (below).
- **N invoice(s) in Odoo are posted but not cleared by ZATCA**: find them in Odoo (journal, state "to send"/"rejected"), fix and send them. ZATCA expects standard (B2B) invoices to be cleared at issue, so do this the same day.
- **Invoicing is paused**: someone switched on the emergency pause (Settings). Switch it off when the problem is solved.

## Odoo key (every 90 days or sooner)
1. In Odoo, as the service user: Preferences > Account Security > New API Key. Copy it once.
2. In Cloud Shell: `printf '%s' 'PASTE-KEY' | gcloud secrets versions add eman-platform-odoo-key --data-file=- --project eman-expenses`, then `gcloud run services update eman-platform --region europe-west1 --project eman-expenses --update-env-vars KEY_ROTATED=$(date +%s)` (this restarts the service so it reads the new key).
3. Dashboard > Settings > "Odoo API key expires on": enter the new date.

## Mistakes after clearance (credit notes)
ZATCA does not allow deleting or editing a cleared invoice. If a salesman issued a wrong invoice:
1. The accounts team opens the invoice in Odoo and creates a **Credit Note** (Add Credit Note) for the full amount, with the reason, and sends it through ZATCA.
2. A correct invoice is then created again by the salesman.
Salesmen cannot do this themselves. Tell them to contact the accounts team with the reference.

## Emergency
- Dashboard > Settings > **Stop all new invoices**. Invoices already in the queue are held, nothing new is accepted.
- The router keeps expense capture working; only invoicing pauses.

## Test mode and going live (owner decision)
Test mode (default) sends every invoice to the ZATCA **sandbox** journal with TEST marking. Before switching it off, all of this must be true:
- The company VAT in Odoo is the **real** number (it is the sandbox number `399999999900003` while testing).
- The real Sales journal is onboarded for ZATCA (Simulation, then Production) by the accountant, and `ODOO_SALES_JOURNAL_ID` points to it.
- The Flow is **published** (not draft) in Meta.
- The Odoo key belongs to a dedicated service user and its expiry date is entered in Settings.
- Alerts are on (`scripts/setup-alerts.sh`) and automatic deployment is on (`scripts/setup-auto-deploy.sh`).
- A one-week pilot with 3 to 5 salesmen has passed, every invoice checked against the paper copy.

## Limits to know
- WhatsApp shows at most 20 round ticks; longer lists of customers or products use a drop-down (up to 200).
- One invoice at a time is sent to Odoo; the load rehearsal in the tests handles 60 invoices in a burst, but real Odoo speed has not been measured.
- Backups of Odoo and of the platform database must be checked with their providers (not verified here).
