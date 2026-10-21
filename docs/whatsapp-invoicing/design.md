# WhatsApp invoicing – design (Odoo 17, production)

Status: DESIGN FOR REVIEW. No invoicing code exists yet. Nothing in Odoo has been changed.
Baseline requirements: [brief.md](./brief.md) (the original brief; still valid except where this file says otherwise).

## 1. Decisions taken (owner's answers)

| # | Decision |
|---|----------|
| D1 | Odoo 17 stays the production system. Odoo 19 SaaS idea dropped for now. |
| D2 | The new service is the ONLY thing allowed to write to Odoo. The existing dashboard/sync stays read-only. |
| D3 | The invoice is created the same way as today: as a **POS order in the salesman's own POS session**, using the salesman's own Odoo user and API key. |
| D4 | Every invoice is posted immediately and ZATCA-cleared in real time. No draft, no credit, no choice for the salesman. |
| D5 | Payment is automatic and uniform: the salesman's own **Cash** payment method, paid in full. Payments are not tracked in Odoo. |
| D6 | Only active salesmen are onboarded (54 invoiced in the last 30 days). Dormant users are not. |
| D7 | Each salesman sees the customers they actually invoice (history-based, last 6 months), plus customers an admin adds. Odoo's customer "Salesperson" field is ignored (it is not a real assignment). |
| D8 | Products: 64 sellable products today. Duplicate names are cleaned up last. More products will be added later. |
| D9 | No Odoo test copy. Testing = simulation of Odoo in our own tests, then a **pilot with one real salesman** and real invoices (mistakes are fixed with credit notes). |
| D10 | Admin console does everything from the screen (users, keys, prices, customers, rules, alerts, messages, Meta settings). The dashboard gets one sidebar link that opens the console in a new tab. |
| D11 | Once a salesman moves to WhatsApp, the native Odoo login is frozen for them (see section 9). |
| D12 | Same Odoo account is shared with the dashboard. The dashboard's 15-minute read-only sync keeps seeing every invoice, including WhatsApp ones. |

## 2. Facts verified in the live Odoo (read-only)

- Odoo 17.0, hosted by Qbook (emanbakery.qbookerp.com). One company, one sales journal `INV` (Customer Invoices) = one ZATCA chain.
- ZATCA = Odoo `l10n_sa_edi` + third-party **Odooze** module (`oz_sa_edi`) + custom `ap_*` modules (including "ZATCA wait for QR – POS").
- Clearance is immediate: on the latest 40 invoices `l10n_sa_confirmation_datetime` is 0–2 s after creation, `edi_state = sent`, 0 errors.
- Salesmen create invoices through **Point of Sale**: each salesman has his own POS config (name = salesman), POS orders named `SALESMAN/00054`, state `invoiced`, `account_move` set. Invoice `ref`/`invoice_origin` = POS order name.
- Each POS config has its own payment methods: shared **Customer Account** (pay later, id 3) and a per-salesman **Cash** method with its own cash journal (LATHEEF-11: method 64, journal "Cash-Latheef-11"). Invoice journal on the POS config = Customer Invoices.
- POS sessions are long-lived: LATHEEF-11 has had ONE session open since 24 July (54 orders). Cash control is on.
- API keys: the "New API Key" button is missing for normal users on this host; only the admin user (EMAN BAKERY) has created keys.
- Read access per salesman (record rules): a POS user sees only his own POS config, orders, payments, sessions.
- History (6 months): ~574 invoices/day (max 792), 54 active salesmen, busiest 06:00–08:00 Riyadh. Per minute: p99 = 4, only 21 minutes ever had 10+ invoices, worst 33 (likely POS phones uploading queued orders). 1.7% of invoices are identical repeats (same salesman, customer, amount) within 10 minutes; half within ~100 s.
- 1,910 customers; 717 of the 720 customers billed in the last 30 days were billed by exactly one salesman.

## 3. Architecture

```
 Salesman phone ── WhatsApp Cloud API ──▶  invoicing service (NEW, separate Cloud Run service)
                                           ├─ webhook + Flow endpoint (Meta signature + RSA/AES, copied pattern from valtown/lib/flow-*.ts)
                                           ├─ own database (users, encrypted keys, customers, prices, requests, jobs, audit)
                                           ├─ Cloud Tasks queue, concurrency 1 (ZATCA chain)
                                           └─ Odoo adapter (ONLY place that talks to Odoo, JSON-RPC)
 Admin ── dashboard sidebar link ──▶ invoicing console (same service, own login, opens in new tab)
 Odoo 17 ◀── per-salesman API key ── adapter           dashboard sync (read-only, unchanged) ──▶ cross-check
```

- Lives in this repository under `invoicing/` with its own deploy; no shared secrets or credentials with the dashboard.
- WhatsApp: use a **separate WhatsApp number** for invoicing (own webhook), so the existing expense-capture number is untouched.
- Database: separate Supabase project. Pilot may use the free plan with a nightly backup export; **Pro plan (~$25/month) before full rollout**. Odoo remains the system of record for invoices.
- Region: undecided (Saudi hosting not confirmed as a requirement). Keep all region settings in configuration so it can move.
- Adapter keeps Odoo calls behind one interface (JSON-RPC is removed in Odoo 20).

## 4. Invoice creation path (the critical part)

For each queued request the worker, as the salesman (his own key):
1. **Ensure a session is open** for his POS config; open one if none exists. Never auto-close (closing needs a cash count; not tracked).
2. Build one POS order: partner, lines (product, qty, price excl. VAT, Odoo's own taxes), `to_invoice = true`, one payment = his **Cash** method for the full total. A deterministic `pos_reference` derived from our request id (our idempotency key).
3. Submit through the POS order-creation method the POS app itself uses (`pos.order.create_from_ui`), which makes the invoice, posts it and triggers the ZATCA modules exactly as today.
4. Read back the invoice: number, `edi_state`, ZATCA UUID/chain index/confirmation time, error message.
5. Fetch the PDF with QR and send it on WhatsApp (M13). If clearance not yet confirmed: M27 and poll. If rejected: M17 + admin alert.

Open technical risks (to be settled in simulation and the first pilot invoice, in this order):
- **R1 – exact payload** of `create_from_ui` for this Odoo build and the custom `ap_*` modules (must be checked against a real native order of the same salesman, field by field).
- **R2 – PDF retrieval over the API.** Options: the invoice's stored PDF (`invoice_pdf_report_file`/attachment) or the report URL. Decided at the first pilot invoice.
- **R3 – idempotency** by `pos_reference` (confirm Odoo skips an existing reference). Fallback: search before create (salesman + customer + total + last minutes).
- **R4 – API keys for 54 users** (button hidden on this host). Needs the Qbook answer or the temporary "Settings" right method per user.
- **R5 – each salesman's POS config must have a Cash method**; the console blocks activation if not.

Hard rules in code: only the adapter may call Odoo; it only calls the few methods needed; every write is preceded by the duplicate checks below; a timeout is never treated as failure until Odoo has been searched for the invoice.

## 5. Duplicate protection

1. Technical: unique request id (Flow token + message id) enforced by a database unique index. Retries/double taps cannot create a second job.
2. Before submit: search Odoo for an invoice by the same salesman, customer and total in the recent window. A timeout/crash never leads to a second invoice.
3. Business: same salesman + customer + same lines/total within 30 minutes (configurable) is blocked (M14, PDF re-sent). A deliberate repeat needs supervisor approval (M15/M29/M30).
4. Independent control: the dashboard's existing "repeated identical invoices" alert keeps watching Odoo.

## 6. Queue and capacity

- One Cloud Tasks queue, max concurrent dispatches = 1 (single journal). Database job status moves forward only, with a row lock before posting, because Cloud Tasks can deliver twice.
- Capacity: clearance takes 1–3 s, so one chain can do ~20+ invoices per minute. History says a worst-case burst of 33 in a minute clears in about 1.5 minutes.
- Alerts: queue length/wait thresholds, failed jobs, Odoo unreachable.

## 7. Salesman journey (WhatsApp Flow)

Same screens as the brief (customer → product line → cart → review → confirm → "queued"). Differences:
- **No payment screen, no payment choice.**
- Customer list = this salesman's customers (D7), a few dozen at most, well below Meta's drop-down limit.
- Product list = active sellable products with a configured maximum price; price is typed by the salesman and must be <= the maximum (checked in the Flow and again on the server).
- The Flow endpoint never waits for Odoo; everything slow is in the queue.

## 8. Admin console (all from the screen)

Users (add/edit/activate/deactivate, number, Odoo login, key masked, language, daily limit, "usual hours" shown), customers per salesman (auto-suggested from history, editable), product price limits (Excel upload, history), invoice list with ZATCA status and PDF, approvals, live queue, alerts, reports/Excel, audit log, message editor (EN/ML), Meta and WhatsApp settings, kill switch (stops new submissions at once), roles (admin / supervisor / accountant) with strong login.
Secrets set once at deployment (cannot live in the database they protect): master encryption key, database connection. A guided one-time setup will be provided.
Unusual-hours check: a request outside a salesman's normal hours raises an alert (not a block).

## 9. Freezing the native Odoo login per salesman

The service needs the user's API key, so rights cannot be removed. Instead: an admin sets a long random password nobody knows (keys cannot log in to the screen), reversible by resetting the password. To be tested that the key survives the password change. The dashboard sync flags any invoice by a WhatsApp-mode salesman that has no matching WhatsApp request (bypass alert).

## 10. Phases

1. Build in this repo with a simulated Odoo (unit tests like `valtown/tests/odoo-sync.test.ts`), console, queue, messages.
2. Deploy test instance with WhatsApp test number; no Odoo writes yet.
3. **Pilot with one real salesman** (owner's choice): first 1–3 small real invoices, owner watching; compare each against a native POS invoice from the same salesman (read-only); kill switch ready.
4. Pilot group (~10), then all active salesmen; native logins frozen per salesman as they move.

## 11. Owner's part (checklist)

1. Pick the pilot salesman (ideally one who invoices daily; LATHEEF-11 invoices rarely).
2. Get that salesman's API key (temporary "Settings" right method) and ask Qbook about enabling API keys for normal users.
3. Create a separate WhatsApp number/WABA for invoicing (Meta business verification).
4. Decide the invoicing database plan (free for pilot with backups, Pro at rollout) and region (Saudi or not).
5. Malayalam message review by a native speaker.
6. Later: product list clean-up and new products; unassigned customers decisions.
