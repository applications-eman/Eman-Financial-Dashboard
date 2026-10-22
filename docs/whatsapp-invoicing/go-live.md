# WhatsApp invoicing: going live (plain steps)

Status: built and tested against a simulated Odoo and WhatsApp. **Not yet run against the real Odoo or WhatsApp.**
Nothing below changes the old Odoo 17 system, the expense capture, or the current Meta webhook until step 7.

## What is already running
- Platform database (Supabase), admin service (Cloud Run `eman-platform`), admin screens in the dashboard.

## Steps (in this order)
1. **Odoo, one-time setup** (the new Odoo 19/20 database)
   - Create a user for the service (not a salesman) with the right to create and post customer invoices and register payments. Create its **API key** (Persistent).
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
Salesman confirms in the Flow, the request is saved and queued (one at a time), the service creates the invoice in Odoo with reference `WA-<ref>`, posts it, sends it to ZATCA through Odoo's own Send & Print, leaves it **unpaid** (credit basis, no payment is recorded), and sends the PDF to the salesman. A crash or timeout never creates a second invoice: Odoo is searched for the reference first.

## Verified on the real Odoo (22 Oct 2026, ZATCA sandbox, test journal "WhatsApp Test")
Run through the connector, step by step, exactly as the service does it:
- Draft invoice with a product line: Odoo applied the 15% VAT itself; amounts matched the service's own calculation (20.00 + 3.00 = 23.00). Default type: simplified.
- Posting creates the ZATCA document in state "to send". Send & Print ("To ZATCA (Testing)") submits it. ZATCA sandbox answered **accepted** (chain index 1).
- The PDF is stored on the invoice (`invoice_pdf_report_id`). Odoo keeps the PDF of the FIRST attempt, even a rejected one, so after a retry it is outdated: the service deletes it and lets Odoo make a new one (`renderFreshPdf`).
- Payment: **credit basis, decided 22 Oct 2026.** The service records no payment; the invoice stays open ("Not paid") as a receivable and payments are handled later in another way. (A test payment was made once and cancelled; the invoice returned to "Not paid", ZATCA status stayed accepted.) If a cash journal id is ever set in the service (`ODOO_CASH_JOURNAL_ID`), it pays every invoice into it; leave it empty.
- Credit basis is a normal tax invoice that is simply unpaid. It is NOT a ZATCA "credit note" (that corrects or cancels an earlier invoice). Odoo's ZATCA file omits payment terms and due date for every invoice, so nothing in it says paid or credit. No payment term is set on the customer, so the PDF carries no credit wording either.
- ZATCA **sandbox only accepts the test VAT 399999999900003**. To test, the company VAT was set to it for the test and then restored (real VAT 312028501300003). The same applies to any future sandbox test.
- Onboarding needs the company name under 64 bytes (Arabic letters count double): shorten it, onboard, restore it. Needs company State/Region (set to Mecca for Jeddah).

## For the accounts team
- Production: the real Sales journal must be onboarded with a real OTP from the Fatoora portal in Simulation, then Production mode. The test journal is for testing only.
- Receipts (money collected) will be recorded separately, outside this service, when the method is decided.

## Still to confirm in the first real runs
- Whether the real customers are B2C (simplified) or B2B (standard, needs the customer's VAT and full address).
- Meta's own validation of `flow-live.json` (the Flow editor).
- Meta's limits (dropdown size, field validation).
