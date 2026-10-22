# WhatsApp invoicing: going live (plain steps)

Status: built and tested against a simulated Odoo and WhatsApp. **Not yet run against the real Odoo or WhatsApp.**
Nothing below changes the old Odoo 17 system, the expense capture, or the current Meta webhook until step 7.

## What is already running
- Platform database (Supabase), admin service (Cloud Run `eman-platform`), admin screens in the dashboard.

## Steps (in this order)
1. **Odoo, one-time setup** (the new Odoo 19/20 database)
   - Create a user for the service (not a salesman) with the right to create and post customer invoices and register payments. Create its **API key** (Persistent).
   - Create the **Cash** journal(s) and note the journal's id (Odoo URL of the journal shows it).
   - ZATCA: onboard the sales journal (sandbox first). Until a journal is onboarded, invoices cannot be sent to ZATCA.
2. **Products and customers**: add them in the dashboard (WhatsApp Platform): categories, products with the maximum price, customers, salesmen and each salesman's customers. Then Settings > *Link customers and products to Odoo*.
3. **Meta**: create the invoice Flow (WhatsApp Manager > Flows > Create). Paste `flow-live.json` from this folder. Note its **Flow ID**. Keep it in draft while testing.
4. **Connect**: Cloud Shell: `PROJECT_ID=eman-expenses REGION=europe-west1 ./scripts/connect-invoicing.sh`
   (asks for the Odoo and WhatsApp values, hidden). It prints the **Flow endpoint address**: set it as the Flow's endpoint in Meta.
   - Say "y" to *only for invoicing* only if the WhatsApp number has no other Flow. One number = one Flow key; a new key replaces the old one.
5. **Register the service in the router**: dashboard > WhatsApp Platform > Services & numbers: service id `invoicing`, address = the "Router address" printed in step 4.
6. **Pilot**: add one salesman, assign customers, Activate. He sends any message to the invoicing number, taps the button, creates a small real invoice. The accounts team checks it in Odoo (and the PDF), then the dashboard Invoices tab.
7. **Switch**: only when the pilot is good, deploy the router and point Meta's webhook at it (with the way back ready).

## How an invoice travels
Salesman confirms in the Flow, the request is saved and queued (one at a time), the service creates the invoice in Odoo with reference `WA-<ref>`, posts it, sends it to ZATCA through Odoo's own Send & Print, registers the full cash payment, and sends the PDF to the salesman. A crash or timeout never creates a second invoice: Odoo is searched for the reference first.

## Known points to confirm in the first real runs (not guessable from documentation)
- The exact wording of the Send & Print wizard choices ("To ZATCA" production or testing) on the real company; the service stops with a clear error if the choice is missing.
- That the PDF is stored on the invoice by Send & Print (field `invoice_pdf_report_id`). If not, the salesman gets the text message and the accounts team can resend.
- Simplified (B2C) or standard (B2B) ZATCA invoice type for each customer: set on the customer in Odoo.
- Whether paid invoices show "Paid" or "In payment" for the cash journal (both are accepted).
- Meta's own limits (dropdown size, field validation): Meta's Flow editor validates `flow-live.json`; any message it shows is fixed here.
