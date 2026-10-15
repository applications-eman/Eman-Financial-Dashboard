# Test report

Run on 2026-10-15 from the build environment. **Read the "Not verified" section: nothing in this report touched your real Supabase project, Cloud Run, or Meta.**

## Automated suites (all green)

| Suite | Command | Result |
|---|---|---|
| Database: real migration files in PGlite (RLS, constraints, triggers, audit, Realtime publication, private bucket) | `npm run test:backend` | 14 tests |
| ZATCA TLV parser (Arabic seller, Phase 2 tags 6-9, DER lengths, URL-safe Base64, Arabic digits, malformed input) | `npm run test:backend` | 7 tests |
| Shortcut endpoint (saved / duplicate / invalid / bad token / inactive user / wrong section / brute-force throttle / only hashes stored) | `npm run test:backend` | 4 tests |
| WhatsApp webhook (verify token, forged & missing signatures, idempotent `wa_message_id`, Base64 + labelled + plain-line text, unregistered & inactive numbers, feature flag) | `npm run test:backend` | 6 tests |
| Flow encryption round trip (RSA-OAEP-SHA256 + AES-128-GCM flipped IV, passphrase key, tamper/wrong-key), flow tokens, media decryption, QR image decoding (PNG, low-contrast large JPEG), full Flow journey, tampering | `npm run test:backend` | 14 tests |
| Admin API auth (no/forged/expired/wrong-audience JWT → 401, staff → 403, CORS allow-list, token shown once, audit actor, validation, CSV) | `npm run test:backend` | 6 tests |
| Logging redaction, rate limit, WhatsApp retry/backoff, PostgREST mapping, scheduled-report timing | `npm run test:backend` | 6 tests |
| Dashboard aggregation / Riyadh time maths | `npm run test:frontend` | 4 tests |
| Type checking (dashboard + backend, strict) | `npm run typecheck` | clean |
| Lint | `npx biome check src` | 0 errors |
| Production build (Next.js standalone) | `npm run build` | OK |

Total: **57 backend + 4 frontend unit/integration tests passing.**

## Browser end-to-end (local): 21/21

`npm run build && npm run e2e` starts the **built dashboard**, the **real Val Town backend code** and a **local Supabase look-alike**
(Auth + PostgREST subset + Realtime websocket, `valtown/e2e/server.ts`), and drives Chromium through: health check, anonymous redirect, wrong
password, admin login, KPI cards, **Realtime** (Shortcut POST → toast + activity feed, measured **~0.4 s** locally), duplicate handling, table + inline edit persisted
after reload, supplier filter, token generation shown once (old token dies), settings edit + API validation, feature-flag switch blocking the endpoint, category
creation, audit actor, CSV export download, Arabic/RTL, mobile (390 px) without horizontal scroll, dark mode, non-admin → "Not authorized", staff JWT/CORS refusal, no console errors.
Screenshots: `docs/screenshots/`. Raw results: `docs/e2e-local-results.json`.

The post-deploy script `scripts/smoke-test.mjs` was also run against that local stack (12/12), including an `openssl`-generated passphrase-protected RSA key for the Flow ping.

## Deployed Val Town (live, no secrets configured yet)

| Request | Result |
|---|---|
| `GET /health` | 200 |
| `GET /admin/me` (no token) | 401 |
| `POST /api/flow` (unsigned) | 432 (Meta's code for bad signature) |
| `GET /whatsapp/webhook` (no verify token configured) | 403 |
| `POST /whatsapp/webhook` (unsigned) | 401 |
| `POST /api/expense` | 500 – expected until `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are set |

## Not verified (needs credentials / accounts you control)

* **Supabase**: the connector was disconnected during the session and no credentials were available, so the migrations were **not applied** to your project.
  They are verified only in PGlite (real Postgres engine, stubbed Supabase auth/storage/realtime). Real-Supabase Realtime delivery under RLS has not been exercised
  (the dashboard code uses the standard `postgres_changes` API with the admin's JWT; Realtime applies the `admin_select` policy).
* **Cloud Run**: no GCP credentials; the Docker daemon was unavailable so the `Dockerfile` was **not built**. What was verified instead: `next build` standalone output run with
  `node server.js` exactly as the container does (health route, runtime env injection, auth redirect).
* **Meta/WhatsApp**: nothing was sent to or received from Meta. The Flow JSON targets version 7.3 / data API 3.0 (the version marked *Recommended* in Meta's changelog at the time
  of writing); `flow-setup.mjs` prints Meta's validation errors on upload. The PhotoPicker payload shape (`photo` as an array of media objects with `cdn_url` +
  `encryption_metadata`) follows Meta's documentation but has only been tested with a faithful simulation – verify on the first real photo.
  Pure-JS JPEG decoding of a full-size phone photo can take seconds; WhatsApp usually down-scales camera uploads.
* **Val Town env vars, webhook subscription, cron execution** – not configured (secrets). The cron is registered (next run 01:00 UTC); its logic is unit-tested.
* **iOS Shortcut**: described step by step ([docs/ios-shortcut.md](ios-shortcut.md)); a `.shortcut` file cannot be produced here. The endpoint it calls is tested.
* **GitHub Actions / Val Town sync script**: written, not executed (`valtown/scripts/sync.mjs` uses Val Town's REST API and has not been run against it; the initial upload was done through the Val Town tools).

## Housekeeping notes

* `emanbakery/expense-tracker` (an older Val Town stub from before this work) accepts unauthenticated POSTs; consider deleting it.
* The Val Town project is **public** (Free plan limit). It holds no secrets; upgrade to make the source private.
