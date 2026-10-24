# Brief for the agent building the Android salesman app (Flutter)

Read this whole file first. Then read `docs/odoo-reference.md`, `docs/whatsapp-invoicing/runbook.md`, `docs/whatsapp-invoicing/brief.md` and the code under `platform/src/` (especially `invoicing/intake.ts`, `invoicing/worker.ts`, `invoicing/odoo.ts`, `invoicing/messages.ts`, `app.ts`, `db/*.sql`). Do not rely on this brief alone: verify against the code and the official docs.

## 0. Who you work for, and how to talk to them
The owner runs Eman Bakery in Jeddah. They are not a developer. Keep replies short, plain, step by step, with one command to paste at a time and exact values to type. Never ask them to paste secrets into chat (keys and tokens are typed hidden into their terminal). Do not guess: check official documentation and the real code, and say plainly what you verified and what you did not. Report test results honestly. No temporary workarounds: build it properly, in small safe steps. Confirm before writing anything to Odoo.

## 1. What to build
A lightweight **Android app (Flutter, iOS later from the same code)** for salesmen. **Only one job: create an invoice.** No credit notes, no payments, no stock, no reports, no WhatsApp inside the app.

The app is a front for the existing platform. Flow: **app, then the platform's invoice queue, then Odoo, then ZATCA, then the PDF comes back to the app.** The queue exists so invoices reach Odoo one at a time (Odoo rate limits) and no invoice is ever created twice.

### Screens (keep it this small)
1. **Login**: phone number and PIN. Device is remembered; wrong PIN five times locks the account for a while; an admin can switch a salesman or a device off at once.
2. **Customers**: only **this salesman's own customers** (the platform's `salesman_customers`), as cards, A to Z, with a search bar.
3. **Add products**: category buttons, product list with search, tap a product, a pop-up asks **quantity and price**, then Add to cart. A product can be in the cart only once. A cart view lets the salesman change quantity/price or remove a line. A clear back button; going back to the customer list starts a new invoice from zero.
4. **Review and send**: a receipt-style summary (each line, quantity, price, before VAT, VAT 15 percent, total), then Send.
5. **Result and history**: a status screen that follows the real state of the invoice (see section 4), and an **invoice history** list of this salesman's own invoices (number, customer, total, date, status, reason if it failed) with the PDF available to open and share. Printing comes after the first version works (section 6).

### Rules that must hold
- **Maximum price per product, per the platform** (`products.max_price`, before VAT). The salesman cannot send a price above it. The server re-checks it (the existing `submitRequest` already does); the app also checks it for a clear message.
- **A salesman sees only his own customers** and only his own invoice history. Enforce on the server, not only in the app.
- **Nothing in the app is a fixed message about invoice results.** Every error, delay or refusal shown must come from the real state and the real reason (Odoo's or ZATCA's own words, or the platform's own rule), never an invented "it will arrive shortly". The platform already works this way for WhatsApp (see `messages.ts` and `worker.ts`).
- Duplicate protection: keep the platform's existing rule and show its real message. No approval screens in the app.

## 2. What already exists (reuse it, do not rewrite it)
Repository: `applications-eman/Eman-Financial-Dashboard`. The `platform/` folder is a Hono/TypeScript service on Cloud Run with a Supabase Postgres database.
- `invoicing/intake.ts`: `submitRequest` (authoritative checks, totals, VAT, duplicate rule, daily limit), money helpers.
- `invoicing/worker.ts`: the queue worker (one invoice at a time, locks, retries, ZATCA wait, PDF), real failure reasons, `deliverPdf`.
- `invoicing/odoo.ts`: the Odoo client (JSON-2 API) with create/post/send-to-ZATCA/PDF and master-data methods.
- Tables (see `platform/db/*.sql`): `salesmen`, `customers`, `salesman_customers`, `product_categories`, `products`, `invoice_requests`, `invoice_request_events`, `platform_settings`.
- The dashboard (Next.js, `src/app/(main)/dashboard/platform/`) is where the owner manages salesmen, customers, products and settings. Customers and products are created in Odoo automatically when added there.
- Idempotency: `invoice_requests.request_key` is unique, so a retry with the same key never creates a second invoice. Use that for the app's retries.
- The worker currently reports results to WhatsApp. For the app channel the result must be stored and readable (status, invoice number, ZATCA state, reason, PDF), not sent over WhatsApp. Design a clean `channel` concept without breaking WhatsApp; the WhatsApp flow is being worked on in another session, so **keep your platform changes in new files and a separate branch, and keep edits to shared files (`app.ts`, `worker.ts`, `intake.ts`) small and well-tested**.

## 3. What to build on the platform (new code, in `platform/src/mobile/`)
An authenticated **app API** with a written contract (write it as an OpenAPI file in `docs/mobile-app/` first, and get the owner's OK on it):
- Login with phone and PIN (PIN stored as a salted hash; apply the schema change at start-up like `server.ts` already does for `products.image`, and also provide a `.sql` file in `platform/db/`). Short-lived access tokens plus a refresh/device token; rate limit and lockout; admin can reset a PIN and revoke devices (add the controls to the dashboard).
- `GET` lists: my customers, categories, products (with max price), cached for about a minute.
- `POST` an invoice with an idempotency key; returns at once with the request reference. Never waits for Odoo.
- `GET` status of one invoice and `GET` my history (paged); `GET` PDF (fetch from Odoo on demand with `odoo.pdf(attachmentId, moveId)`; files come back as `{filename, content, size}` in Odoo 20).
- Tests for every rule above (own customers only, max price, duplicates, idempotent retry, lockout, token expiry).

## 4. Statuses the app must show (from the real state)
`queued` (with how many are ahead, only if true), `processing`, waiting for ZATCA clearance, `cleared` (PDF ready), `rejected` by ZATCA (show ZATCA's reason), `failed` (show the reason), PDF not ready (say why, with a retry button). Poll with back-off or use a push channel; the app must also survive weak signal: an invoice that could not be sent stays on the phone, clearly marked "not sent yet", and is retried **with the same idempotency key**. The app never invents an invoice number.

## 5. App engineering
- Flutter stable, Android first (`minSdk` 24 or higher), package id `com.emanbakeries.sales`, white-label brand: Eman Bakery logo and colours (see `docs/whatsapp-invoicing/logo.png`, `banner.jpg`).
- Clean structure (feature folders), one state-management approach, typed API client, secure storage for tokens, TLS only, no secrets in the app, localisation ready (English now, Arabic RTL and Malayalam later), accessible tap targets, dark mode.
- Tests: unit tests for the cart/price maths (VAT 15 percent, rounding per line exactly as `intake.ts`), the API client, and widget tests for the main screens. Run `flutter analyze` and `flutter test` before saying anything is done. Build in CI if possible.
- Check the Flutter SDK is available in your environment; if you cannot run the app, say so and rely on the owner's build output, but still run `flutter analyze` if you can.

## 6. Printing (after the first version works)
Bluetooth ESC/POS thermal printers. Paper widths: **80 mm** (about 72 mm printable) and **58 mm** (about 48 mm printable); a per-device setting, default 80. Many cheap printers lack Arabic fonts, so render the receipt as an image and print it as raster. Receipt content: company name and VAT number, invoice number and date, customer, lines, totals, and the **ZATCA QR code** taken from the invoice in Odoo (do not make your own QR). Candidate packages (evaluate maturity first, do not trust claims): `unified_esc_pos_printer`, `srag_printer`. Test on the owner's real printers.

## 7. Google Play
The owner's Play Console account is an **Organization** account (verified). Package id `com.emanbakeries.sales`. Guide the owner click by click: create the app, signing key and its backup, build an app bundle (`flutter build appbundle`), upload to **Internal testing**, then closed testing, then production (store listing, privacy policy URL, data safety form, content rating, screenshots). Check the Play Console's current requirements for the account before promising dates. Public production release needs Google's review, so plan for days, not hours.

## 8. Out of scope, and things to leave alone
- ZATCA production onboarding: the owner handles it later. The system runs in the ZATCA sandbox (Test mode) until then; the app must show a clear "TEST" mark whenever the platform is in test mode.
- The WhatsApp form and the router are being worked on elsewhere: do not change their behaviour.
- The old Odoo 17 system and the old expense capture must not be touched.

## 9. Order of work
1. Read, then write the API contract and get the owner's OK.
2. Platform app API with tests, then the deploy command for the owner.
3. Flutter skeleton that builds and logs in; owner runs it on a phone.
4. Customers, products, cart, review, send, status, history.
5. Real-device testing with the owner; fix.
6. Printing.
7. Play internal testing, then a pilot with 3 to 5 salesmen.
Commit small and often to your own branch; do not open a pull request unless the owner asks.
