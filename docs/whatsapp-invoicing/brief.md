# WhatsApp Invoicing for Odoo 17 – Brief and Requirements

---

# PART 1 – MESSAGE TO THE EXISTING AGENT (READ FIRST – DO NOT IMPLEMENT ANYTHING)

I am thinking about adding a new feature and I want your opinion and clear advice BEFORE anything is built. This is an investigation and advice request only. **Do not write, change, deploy, or delete anything. Do not create invoices. Do not touch live data, Cloud Run services, secrets, or the Odoo database.**

The idea: our salesmen (about 90) currently create B2B invoices in the Odoo 17 mobile browser UI. It is confusing, the page sometimes hangs while the invoice is actually created and cleared by ZATCA in the background, the salesman closes and reopens the browser, and issues the same invoice again. We want a controlled, limited WhatsApp front end (WhatsApp Cloud API, directly with Meta, using WhatsApp Flows) where the salesman can only: pick one of their customers, pick products, enter quantity and price (with a maximum price per product), confirm, and receive the cleared ZATCA invoice PDF back on WhatsApp. Part 2 of this document is the full requirement list.

You already have a running project (Google Cloud Run) that is linked to this same Odoo 17 account and has some WhatsApp integration. Because a lot is already built there, I do not want to build something separate that breaks what works, or duplicates it badly. Please check the project and the Odoo connection and answer the questions below.

## What I want you to check and report back

**A. Existing Odoo connection**
1. Which protocol is used today (JSON-RPC, XML-RPC, or other)? Which Odoo URL/hosting type (it is not a standard *.odoo.com URL; it was bought through a third party), which Odoo edition, and which database?
2. How is authentication done (one shared user vs per-user)? Where are credentials/secrets stored?
3. Does Odoo allow login with a per-user API key over the same protocol? Can we authenticate AS each salesman and create/post invoices as them?
4. Are there rate limits, firewall rules, or IP whitelisting on the Odoo host that would affect a new service?
5. How is the invoice created and posted today by the salesmen (journal, defaults, taxes, pricelist, salesperson field)? Which journal(s) do they use?
6. How is ZATCA clearance triggered after posting (immediately, or by a scheduled job)? Which fields show the status, UUID, chain index and any rejection message? How long does clearance take?
7. How can the invoice PDF (with ZATCA QR code) be downloaded programmatically, the same way a user would get it?
8. How can customers assigned to a salesman be listed (which field defines "their customers")? Are there ~100 products we care about and how are they identified?

**B. Existing WhatsApp integration**
1. Which WhatsApp number / WABA / Meta app does it use? Which webhook URL is registered with Meta? (Meta allows only one webhook URL per app, so a new feature may have to share the existing webhook.)
2. Are WhatsApp Flows already used? Is there already a Flow endpoint with Meta's encryption (RSA/AES) implemented? Is webhook signature verification already implemented?
3. What features currently use this WhatsApp number that we must not break?

**C. Existing infrastructure**
1. Cloud Run region, services, scaling settings (min instances, concurrency, timeouts).
2. What database and queue/cache exist (Cloud SQL, Redis/Memorystore, Cloud Tasks, Pub/Sub, none)?
3. Logging, monitoring, alerting, backups, CI/CD, secret management. How are environments (test vs production) separated?
4. Languages/frameworks used and code quality/structure; is there an existing admin UI or user table we could reuse?

**D. Your advice (the most important part)**
1. Should the new feature be built (a) inside the existing project, (b) as a new separate service in the same Google Cloud project that reuses shared libraries, or (c) as a fully separate project? Give a clear recommendation and the reasons, with the risk to existing features.
2. How should the single shared WhatsApp webhook be handled so existing features keep working?
3. For the invoice queue (one invoice at a time per journal because of ZATCA hash chaining), what is the best fit on this infrastructure (e.g. Cloud Tasks with concurrency 1, Pub/Sub, Redis worker)? Cloud Run can scale to zero or run several instances, so explain how ordering and duplicate protection stay safe.
4. Any conflict between Part 2 requirements and what already exists? Anything in Part 2 that is wrong, risky or impossible with Odoo 17 / ZATCA / WhatsApp Flows limits (for example Flow dropdown size limits, 24-hour messaging window, document size limits)?
5. Data residency: is the current Cloud Run region acceptable for storing invoice data (a Saudi region may be required)? Flag it, do not decide it.
6. A phased plan with the smallest safe first step, and what must be tested on a COPY of the database / ZATCA Simulation before production.

**Reply format:** a short written report with findings (facts you verified, clearly separated from assumptions), your recommendation, risks, and open questions for me. Do not make changes.

---

# PART 2 – SYSTEM REQUIREMENTS (AGREED SO FAR)

## 1. Background and goal
- Company in Saudi Arabia, Odoo 17, ZATCA Phase 2 already integrated and working (B2B clearance). Users already issue invoices through the Odoo 17 mobile browser UI.
- Problems today: the UI hangs or shows nothing while the invoice is actually posted and cleared; salesmen (low technical literacy) close the browser and issue the same invoice again; Odoo accepts the duplicate. There are many mistakes.
- Goal: replace only the front end. Salesmen use WhatsApp (Cloud API, WhatsApp Flows) with a limited, guided flow. In the end the invoice must be created in Odoo as if the salesman had used the native Odoo UI with their own user. Invoice numbering, journals, sequences, taxes and ZATCA behaviour must not change.
- Volume: about 90 salesmen, about 650 invoices per day, mostly issued in a 7–8 hour field window. Plan for peaks of 5–10 invoices per minute with bursts of 20–30 in a minute or two, with headroom. Validate by load test.

## 2. Hard principles
1. **No custom code inside Odoo and no direct database access.** Everything goes through Odoo's official API from an external service.
2. **No change to Odoo configuration**, invoice sequences, journals or ZATCA setup.
3. **Invoices are created by the salesman's own Odoo user** using that user's own API key (same creator, salesperson and history as native UI).
4. **Safety over speed:** never create a duplicate invoice; never lose a request; never leave the salesman guessing.
5. **Every case (success, error, delay) shows a clear message** in the salesman's language, telling them what happened and what to do.
6. Build and test on a **copy of the database / ZATCA Simulation** first. Production only after a pilot.

## 3. Users and roles
- **Salesman (WhatsApp):** can only use the invoice Flow from a registered, activated mobile number.
- **Admin (console):** manages users, keys, price limits, settings; sees everything.
- **Supervisor (console):** views activity, approves blocked repeat invoices.
- **Accountant (console):** view-only on invoices, ZATCA status and reports.

## 4. Salesman registration and activation
- Admin adds a salesman in the console: name, WhatsApp number, Odoo login, the salesman's own Odoo API key, language (English or Malayalam), optional daily invoice limit.
- Admin generates each key manually in Odoo (using the salesman's credentials in the Odoo UI) and pastes it into the console. The key is stored encrypted, shown masked, and can be replaced or revoked.
- A new user is **inactive** until the admin presses **Activate**.
- WhatsApp accepts requests **only** from numbers that are linked to an **activated** user. Any other number gets only a fixed polite refusal (message M01) and never sees customers, products or prices.
- Deactivating a user, or changing their number or key, takes effect immediately for new requests.
- If the key stops working in Odoo, the salesman gets M19 and the admin gets an alert.

## 5. WhatsApp Flow (salesman journey)
Entry: the salesman sends any message (or taps a button) and receives the "Create invoice" interactive message (M03) that opens the Flow. The Flow token identifies the session and user; it must be unpredictable and expire.

Screens:
1. **Select customer** – only customers assigned to this salesman (as defined in Odoo for them). Dropdown, with search/paging if the list is large. If none: M04.
2. **Add product line** – select product (from the ~100 invoiceable products), enter quantity, enter unit price (free entry, excluding VAT). Immediate validation:
   - quantity must be greater than zero (M05);
   - price must be valid (M06);
   - price must not exceed the product's maximum price excl. VAT (M07). If it does, the salesman cannot continue and must correct it;
   - product with no maximum configured cannot be invoiced (M09).
3. **Cart** – shows lines so far; choices: add another product, remove a line, or continue. At least one line is required (M08). A maximum number of lines per invoice is configurable.
4. **Review and confirm** – customer, each line (product, quantity, price), total before VAT, VAT, grand total (M10). One clear "Confirm" action. The Confirm button works once per session.
5. **Result** – immediate acknowledgement: M11 (queued) – never a spinner that hangs.

Rules for the Flow:
- The Flow endpoint must always answer within Meta's time limits. All slow work happens in the background, never inside the Flow request.
- Flow state (draft lines) is kept by the service, keyed by the Flow token.
- Text, voice or image messages cannot create invoices (M24).
- If the Flow session expired: M22.
- Verify Meta's Flow limits (dropdown size, number of screens, payload size) in Meta's current documentation before finalizing the design.

## 6. Price rules
- Each of the ~100 products has a **maximum sale price, excluding VAT**, maintained in the admin console (bulk upload from Excel and manual edit).
- The salesman may type any price **up to and including** the maximum.
- Checked **twice**: in the Flow (for a clear immediate error) and again on the server just before the invoice is created (the authoritative check, because the Flow check alone can be bypassed or the limit may have changed).
- Violations are rejected with message M07 and logged. The console reports repeated attempts per salesman.
- Price field is otherwise free (no pricelist force), as decided.

## 7. Duplicate prevention (two layers)
**Technical layer (same submission twice):**
- Every submission has a unique key (Flow token / message ID). The service database enforces uniqueness, so a double tap or Meta webhook retry never creates a second job.
- Before creating an invoice, the worker checks Odoo for an already created matching invoice (same user, customer, total and recent time) so that a crash or timeout in the middle never causes a second invoice. A timeout is never treated as failure until this check is done.
- Do not add custom fields in Odoo for this. The service database is the record of submissions.

**Business layer (same invoice issued again by mistake):**
- If the same salesman submits the same customer with the same lines and total within a configurable window (default 30 minutes), no new invoice is created. The salesman gets M14 and can receive the existing PDF again.
- A deliberate repeat requires supervisor approval (M15). The supervisor approves or rejects in the console.

## 8. Queue and Odoo protection
- All invoice creation goes through a queue. The salesman gets an immediate acknowledgement with queue position and estimated time (M11) and is told not to resubmit.
- **One invoice at a time per journal** (ZATCA invoices are hash-chained; parallel posting is risky). Different journals could run in parallel only if the accountant confirms it is safe with ZATCA onboarding.
- Measure real time per invoice (create, post, clearance, PDF) on the test copy; use that to size throughput. Example: 10 s per invoice ≈ 6 per minute per journal.
- Rate limit calls to Odoo from the service. Retry temporary failures with increasing delays. After the maximum retries the job moves to a failed list and an alert is raised.
- Customer and product lists are **cached in the service's own database** and refreshed every few minutes, so salesmen browsing never query Odoo. Odoo is called only to create/post the invoice and to fetch status and PDF.
- Alerts when the queue length or waiting time exceeds thresholds.
- Load-test bursts (for example 50 submissions in one minute) before go-live and report time to clear and failures.

## 9. Odoo integration details (to be confirmed by the investigation)
- Authenticate as the salesman using their API key over the supported protocol (JSON-RPC or XML-RPC as confirmed). Keep Odoo calls in one small module so a later protocol change (JSON-RPC/XML-RPC are scheduled for removal in Odoo 20) is easy.
- Create the customer invoice (out_invoice) with the selected customer, product lines, quantities and entered prices; let Odoo apply the usual taxes, journal and defaults exactly as the native UI does; then post it.
- Odoo's existing ZATCA module handles signing, chaining and clearance. The service only reads the resulting status, UUID and any rejection reason.
- Only after clearance succeeds: download the invoice PDF (with ZATCA QR) the same way a user would, and send it to the salesman's WhatsApp as a document with caption M13.
- If clearance is pending: M27. If rejected: M17 (and alert). Never send the PDF as "cleared" before clearance.
- Odoo-side hygiene: each salesman's own Odoo user keeps minimum rights. After go-live, consider removing invoice-creation rights from their native logins so the old UI cannot create duplicates (a business decision for the admin).

## 10. Admin console
- **Users:** add, edit, activate/deactivate, number, Odoo login, key (encrypted, masked, replaceable), language, daily limit.
- **Roles and login:** admin, supervisor, accountant, with secure login (two-factor recommended).
- **Product price limits:** list of ~100 products with maximum price excl. VAT; Excel upload and edit; change history.
- **Invoices list:** invoice number, customer, salesman, amount, ZATCA status and UUID, timings, PDF download, search and filters.
- **Approvals:** repeat-invoice requests waiting for supervisor decision.
- **Live dashboard (real time):** queue length, in progress, invoices today, failures, average time per invoice, busiest salesmen, ZATCA rejections.
- **Alerts** (WhatsApp or email to admin/accounts): queue too long, jobs stuck or failed, ZATCA rejection, Odoo unreachable, a salesman's key invalid, repeated price-limit violations, unusual number of attempts by one user.
- **Reports:** daily and monthly by salesman, customer and status; Excel export; daily reconciliation of service records against Odoo.
- **Audit log:** every console change and every invoice request (who, what, when).
- **Message management:** view of all message templates (English and Malayalam).

## 11. Security
- Webhook signature verification for all Meta calls; Flow request decryption per Meta's specification.
- All secrets (Meta credentials, user API keys) encrypted and kept in a secret manager, never in code or logs.
- API keys never displayed in full after saving and never sent over WhatsApp.
- HTTPS only; least-privilege access; backups of the service database with tested restore.
- Technical details (stack traces, Odoo internals) are never shown to salesmen; they go to the console and logs.

## 12. Languages
- Salesmen messages and Flow screens: **English and Malayalam** (no Arabic). Language is a per-user setting.
- Malayalam text below must be reviewed by a native speaker on the team before the pilot.
- Console and alerts for admin/accounts: English.
- Messages must be short, plain, and say what happened and what to do.

## 13. Technology stack (recommended; the existing agent may adjust after checking current infrastructure)
- Backend: Python, FastAPI.
- Queue/workers: Redis-based worker, or Cloud Tasks with concurrency of one per journal if the existing Google Cloud setup is a better fit.
- Database: PostgreSQL with daily backups.
- Admin console: web app (React).
- Deployment: Docker, HTTPS, automatic restart, error tracking, uptime monitoring.
- Preference: mainstream, well-supported parts only so there is no future breakage.

## 14. Rollout
1. Test environment: copy of the Odoo database, ZATCA Simulation, a few users. Measure time per invoice.
2. Build admin console, price limits, alerts, reports. Load test.
3. Pilot with about 10 salesmen on production.
4. Full roll-out to about 90 salesmen. Keep the native UI available for a short fallback period.
5. After stable operation, decide on removing invoice-creation rights from the native UI.

## 15. Open items still to be confirmed
1. Time per invoice today (seconds from pressing issue to cleared).
2. Odoo hosting details from the third-party provider (API reachable, firewall/IP whitelist, rate limits, test database copy, edition).
3. Whether the service must be hosted in Saudi Arabia.
4. Whether different groups of salesmen can use different sales journals (needs accountant confirmation for ZATCA).
5. Customer assignment rule in Odoo (which field defines a salesman's customers).
6. Malayalam wording review.
7. Whether existing WhatsApp number and webhook are shared with other features (see Part 1, section B).

---

# PART 3 – MESSAGE CATALOGUE (WHAT THE SALESMAN SEES)

Placeholders in {braces} are filled by the system. All messages exist in English (EN) and Malayalam (ML). Malayalam needs native-speaker review.

| ID | When | EN | ML |
|---|---|---|---|
| M01 | Number not registered | This number is not registered for invoicing. Please contact your supervisor. | ഈ നമ്പർ ഇൻവോയ്സിംഗിനായി രജിസ്റ്റർ ചെയ്തിട്ടില്ല. ദയവായി നിങ്ങളുടെ സൂപ്പർവൈസറെ ബന്ധപ്പെടുക. |
| M02 | Account not active | Your account is not active. Please contact your supervisor. | നിങ്ങളുടെ അക്കൗണ്ട് ആക്ടീവ് അല്ല. ദയവായി സൂപ്പർവൈസറെ ബന്ധപ്പെടുക. |
| M03 | Start / welcome | Hello {name}. Tap the button below to create an invoice. | ഹലോ {name}. ഇൻവോയ്സ് തയ്യാറാക്കാൻ താഴെയുള്ള ബട്ടൺ അമർത്തുക. |
| M04 | No customers assigned | No customers are assigned to you. Please contact your supervisor. | നിങ്ങൾക്ക് കസ്റ്റമർമാരെ നൽകിയിട്ടില്ല. ദയവായി സൂപ്പർവൈസറെ ബന്ധപ്പെടുക. |
| M05 | Quantity invalid | Please enter a quantity greater than zero. | പൂജ്യത്തേക്കാൾ കൂടുതൽ അളവ് നൽകുക. |
| M06 | Price invalid | Please enter a valid price. | ശരിയായ വില നൽകുക. |
| M07 | Price above maximum | The price you entered for {product} is {entered}. The maximum allowed is {max} (before VAT). Please enter {max} or less. | {product}-ന് നിങ്ങൾ നൽകിയ വില {entered} ആണ്. അനുവദനീയമായ പരമാവധി വില {max} ആണ് (VAT ഒഴികെ). ദയവായി {max} അല്ലെങ്കിൽ അതിൽ കുറവ് നൽകുക. |
| M08 | No product added | Please add at least one product before creating the invoice. | ഇൻവോയ്സ് തയ്യാറാക്കുന്നതിന് മുമ്പ് കുറഞ്ഞത് ഒരു ഉൽപ്പന്നമെങ്കിലും ചേർക്കുക. |
| M09 | Product has no price limit set | {product} cannot be invoiced right now because no price limit is set. Please contact your supervisor. | {product}-ന് വില പരിധി സജ്ജമാക്കിയിട്ടില്ലാത്തതിനാൽ ഇപ്പോൾ ഇൻവോയ്സ് ചെയ്യാൻ കഴിയില്ല. ദയവായി സൂപ്പർവൈസറെ ബന്ധപ്പെടുക. |
| M10 | Review before confirm | Please check: Customer {customer}. {lines}. Total before VAT {subtotal}. VAT {vat}. Total {total}. Tap Confirm to create the invoice. | ദയവായി പരിശോധിക്കുക: കസ്റ്റമർ {customer}. {lines}. VAT ഒഴികെയുള്ള തുക {subtotal}. VAT {vat}. ആകെ തുക {total}. ഇൻവോയ്സ് തയ്യാറാക്കാൻ Confirm അമർത്തുക. |
| M11 | Request queued | Received. Your invoice is in the queue (position {n}). It will arrive here in about {minutes} minutes. Please do not submit it again. | സ്വീകരിച്ചു. നിങ്ങളുടെ ഇൻവോയ്സ് ക്യൂവിലാണ് (സ്ഥാനം {n}). ഏകദേശം {minutes} മിനിറ്റിനുള്ളിൽ ഇവിടെ ലഭിക്കും. ദയവായി വീണ്ടും സമർപ്പിക്കരുത്. |
| M12 | Being processed | Your invoice is being created. Please wait. Do not submit it again. | നിങ്ങളുടെ ഇൻവോയ്സ് തയ്യാറാക്കി കൊണ്ടിരിക്കുന്നു. ദയവായി കാത്തിരിക്കുക. വീണ്ടും സമർപ്പിക്കരുത്. |
| M13 | Success (PDF caption) | Invoice {number} for {customer}. Total {total}. ZATCA cleared. | {customer}-നുള്ള ഇൻവോയ്സ് {number}. ആകെ തുക {total}. ZATCA അംഗീകരിച്ചു. |
| M14 | Duplicate blocked | You already created this invoice at {time}: {number}. It was not created again. Tap below to receive the PDF again. | ഈ ഇൻവോയ്സ് നിങ്ങൾ {time}-ന് തയ്യാറാക്കിയിട്ടുണ്ട്: {number}. വീണ്ടും തയ്യാറാക്കിയിട്ടില്ല. PDF വീണ്ടും ലഭിക്കാൻ താഴെ അമർത്തുക. |
| M15 | Repeat needs approval | A similar invoice was created at {time} ({number}). A new one needs supervisor approval. Your request has been sent to your supervisor. | സമാനമായ ഇൻവോയ്സ് {time}-ന് തയ്യാറാക്കിയിട്ടുണ്ട് ({number}). പുതിയത് തയ്യാറാക്കാൻ സൂപ്പർവൈസറുടെ അനുമതി വേണം. നിങ്ങളുടെ അഭ്യർത്ഥന സൂപ്പർവൈസർക്ക് അയച്ചിട്ടുണ്ട്. |
| M16 | System busy / Odoo slow | The system is busy. Your request is saved and will be processed automatically. You do not need to do anything. | സിസ്റ്റം തിരക്കിലാണ്. നിങ്ങളുടെ അഭ്യർത്ഥന സേവ് ചെയ്തിട്ടുണ്ട്, സ്വയമേവ പ്രോസസ്സ് ചെയ്യും. നിങ്ങൾ ഒന്നും ചെയ്യേണ്ടതില്ല. |
| M17 | ZATCA rejected | ZATCA did not accept this invoice. Reason: {reason}. Please contact the accounts team with reference {ref}. Do not create it again. | ZATCA ഈ ഇൻവോയ്സ് അംഗീകരിച്ചില്ല. കാരണം: {reason}. ദയവായി റഫറൻസ് {ref} സഹിതം അക്കൗണ്ട്സ് ടീമിനെ ബന്ധപ്പെടുക. വീണ്ടും തയ്യാറാക്കരുത്. |
| M18 | Failed, confirmed not issued | We could not create your invoice. It was not issued. Please contact the accounts team with reference {ref}. | നിങ്ങളുടെ ഇൻവോയ്സ് തയ്യാറാക്കാൻ കഴിഞ്ഞില്ല. ഇൻവോയ്സ് ഇഷ്യൂ ചെയ്തിട്ടില്ല. ദയവായി റഫറൻസ് {ref} സഹിതം അക്കൗണ്ട്സ് ടീമിനെ ബന്ധപ്പെടുക. |
| M19 | User's Odoo key invalid | There is a problem with your invoicing access. Your request was not processed. Please contact your supervisor. | നിങ്ങളുടെ ഇൻവോയ്സിംഗ് ആക്‌സസിൽ ഒരു പ്രശ്നമുണ്ട്. നിങ്ങളുടെ അഭ്യർത്ഥന പ്രോസസ്സ് ചെയ്തിട്ടില്ല. ദയവായി സൂപ്പർവൈസറെ ബന്ധപ്പെടുക. |
| M20 | Not allowed for this customer | You are not allowed to invoice this customer. Please contact your supervisor. | ഈ കസ്റ്റമർക്ക് ഇൻവോയ്സ് തയ്യാറാക്കാൻ നിങ്ങൾക്ക് അനുമതിയില്ല. ദയവായി സൂപ്പർവൈസറെ ബന്ധപ്പെടുക. |
| M21 | Customer data incomplete for ZATCA | This customer's details are incomplete for ZATCA ({field}). Please contact the accounts team. | ZATCA-യ്ക്ക് ആവശ്യമായ ഈ കസ്റ്റമറുടെ വിവരങ്ങൾ പൂർണ്ണമല്ല ({field}). ദയവായി അക്കൗണ്ട്സ് ടീമിനെ ബന്ധപ്പെടുക. |
| M22 | Flow session expired | This form has expired. Please start again by tapping the button below. | ഈ ഫോമിന്റെ സമയം കഴിഞ്ഞു. താഴെയുള്ള ബട്ടൺ അമർത്തി വീണ്ടും തുടങ്ങുക. |
| M23 | Daily limit reached | You have reached today's invoice limit. Please contact your supervisor. | ഇന്നത്തെ ഇൻവോയ്സ് പരിധി എത്തി. ദയവായി സൂപ്പർവൈസറെ ബന്ധപ്പെടുക. |
| M24 | Text/voice/image sent instead of using button | Please use the invoice button. Messages cannot be used to create invoices. | ദയവായി ഇൻവോയ്സ് ബട്ടൺ ഉപയോഗിക്കുക. സന്ദേശങ്ങൾ വഴി ഇൻവോയ്സ് തയ്യാറാക്കാൻ കഴിയില്ല. |
| M25 | Customer not found (search) | No customer found. Please check and try again. | കസ്റ്റമറെ കണ്ടെത്തിയില്ല. പരിശോധിച്ച് വീണ്ടും ശ്രമിക്കുക. |
| M26 | PDF delayed after clearance | Your invoice is created and cleared, but the PDF is delayed. It will arrive here shortly. | നിങ്ങളുടെ ഇൻവോയ്സ് തയ്യാറായി, ZATCA അംഗീകരിച്ചു. PDF എത്താൻ അൽപ്പം വൈകും. ഉടൻ ഇവിടെ ലഭിക്കും. |
| M27 | Waiting for ZATCA clearance | Invoice {number} is created. Waiting for ZATCA clearance. Do not create it again. | ഇൻവോയ്സ് {number} തയ്യാറായി. ZATCA അംഗീകാരത്തിനായി കാത്തിരിക്കുന്നു. വീണ്ടും തയ്യാറാക്കരുത്. |
| M28 | Too many lines | You can add up to {max} products in one invoice. Please create a second invoice for the rest. | ഒരു ഇൻവോയ്സിൽ പരമാവധി {max} ഉൽപ്പന്നങ്ങൾ ചേർക്കാം. ബാക്കിയുള്ളവയ്ക്ക് മറ്റൊരു ഇൻവോയ്സ് തയ്യാറാക്കുക. |
| M29 | Supervisor rejected repeat request | Your supervisor did not approve this invoice. Please contact your supervisor. | ഈ ഇൻവോയ്സിന് നിങ്ങളുടെ സൂപ്പർവൈസർ അനുമതി നൽകിയില്ല. ദയവായി സൂപ്പർവൈസറെ ബന്ധപ്പെടുക. |
| M30 | Supervisor approved repeat request | Your supervisor approved this invoice. It is now in the queue. Please do not submit it again. | നിങ്ങളുടെ സൂപ്പർവൈസർ ഈ ഇൻവോയ്സിന് അനുമതി നൽകി. ഇപ്പോൾ ക്യൂവിലാണ്. വീണ്ടും സമർപ്പിക്കരുത്. |

Notes on messages:
- M18 may only be sent after the worker has confirmed in Odoo that no invoice was created. If unsure, use M16 and keep retrying; never tell the salesman "not issued" when it might have been.
- If the WhatsApp 24-hour messaging window is closed when the PDF is ready, send the PDF through a pre-approved Meta template (for example "Your invoice {number} is ready"). The template must be approved by Meta in advance.
- Every error message includes a short reference code {ref} that the accounts team can find in the console.

## Admin alert messages (English, to admin/accounts only)
| ID | Alert |
|---|---|
| A01 | Queue length is {n} (threshold {t}). Oldest request waiting {minutes} min. |
| A02 | Invoice job failed after {retries} retries: user {user}, customer {customer}, ref {ref}. |
| A03 | ZATCA rejected invoice {number} for {customer} ({user}). Reason: {reason}. |
| A04 | Odoo is not reachable. Requests are being queued. |
| A05 | Odoo API key invalid for user {user}. User cannot issue invoices. |
| A06 | User {user} exceeded the price limit {count} times today. |
| A07 | Unusual activity: user {user} made {count} attempts in {minutes} minutes. |
| A08 | Repeat-invoice approval waiting from user {user} ({number}). |
| A09 | Daily reconciliation found {count} differences between service and Odoo. |
