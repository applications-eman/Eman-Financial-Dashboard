# Deployment guide

## 1. Supabase

1. Create the first admin in **Authentication → Users** (email + password).
2. Apply the migrations in order (`supabase/migrations/*.sql`):
   ```bash
   supabase link --project-ref <ref> && supabase db push
   ```
   (or paste the four files into the SQL editor). They create the tables, constraints, RLS, triggers, the private
   `invoice-images` bucket, Realtime publication, categories, settings and feature flags.
3. Make that user an admin: `select public.bootstrap_admin('you@company.com', 'Your Name', '+9665XXXXXXXX');`
4. **Authentication → URL configuration**: add the dashboard URL (needed for magic-link sign-in).
5. Copy *Project URL*, *anon key*, *service_role key* and *JWT secret* (Settings → API). The service role key and JWT secret go
   **only** into Val Town.

Safety: RLS is on for every table; only active `admin` users can `SELECT`; `anon` has no privileges at all; there are no
insert/update/delete policies, so all writes must use the service role (Val Town). `app_users.token_hash` is not readable
by any browser session. Tests: `valtown/tests/rls.test.ts` runs the real migration files in PGlite.

## 2. Val Town (backend)

The code lives in `valtown/` and is deployed as `applications/eman-expense-api`
(base URL `https://applications--5ea60f0ec82c11f183e41607ee4eb77e.web.val.run`; the project is public because the Free plan has no private
projects – it contains no secrets). Endpoints: `/health`, `/api/expense`, `/whatsapp/webhook`, `/api/flow`, `/admin/*`;
`cron-reports.ts` runs hourly.

* Env vars: see `valtown/.env.example` (set them under *Environment variables* of the val).
* Re-deploy after code changes: `VAL_TOWN_API_KEY=… node valtown/scripts/sync.mjs` (or push to `main`; the workflow does it).
* Cron: `cron-reports.ts` is an hourly interval (`0 * * * *`, UTC). Saudi time is UTC+3 all year, so hourly in UTC is hourly in
  Riyadh; the Riyadh hour to send at comes from the `report_schedule` setting (default daily 21:00, weekly Saturday 09:00 Saudi time).

## 3. Cloud Run (dashboard)

One-time: create the secrets (values are not confidential but are kept in Secret Manager as required):

```bash
printf '%s' 'https://xxxx.supabase.co'      | gcloud secrets create eman-supabase-url      --data-file=-
printf '%s' 'eyJ…anon…'                     | gcloud secrets create eman-supabase-anon-key --data-file=-
printf '%s' 'https://….web.val.run'         | gcloud secrets create eman-admin-api-url     --data-file=-
# let the Cloud Run runtime service account read them
for s in eman-supabase-url eman-supabase-anon-key eman-admin-api-url; do
  gcloud secrets add-iam-policy-binding $s --member "serviceAccount:$(gcloud projects describe $PROJECT_ID --format 'value(projectNumber)')-compute@developer.gserviceaccount.com" --role roles/secretmanager.secretAccessor
done
```

Deploy: `PROJECT_ID=<id> ./scripts/deploy-cloud-run.sh` – builds with Cloud Build (multi-stage `Dockerfile`, Next.js standalone) and
deploys with `--min-instances 0`. The container serves on `8080`; health check: `GET /healthz`.
Because the settings are read at *request time*, rotating a secret only needs a new revision (`gcloud run services update …`), not a rebuild.

Then set Val Town `ALLOWED_ORIGIN` to the printed Cloud Run URL (CORS is restricted to exactly that origin).

### GitHub Actions (optional)

`ci.yml` runs lint, typecheck, tests and the build on every PR. `deploy.yml` (push to `main`) tests, syncs Val Town and deploys Cloud Run via
Workload Identity Federation (no GCP key in GitHub). Configure:

| Kind | Name | Value |
|---|---|---|
| secret | `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/…/locations/global/workloadIdentityPools/…/providers/…` |
| secret | `GCP_DEPLOY_SERVICE_ACCOUNT` | deployer SA email (roles: Cloud Run Admin, Cloud Build Editor, Artifact Registry Writer, Service Account User) |
| secret | `VAL_TOWN_API_KEY` | Val Town API token with vals read+write |
| variable | `GCP_PROJECT_ID`, `GCP_REGION` (default `me-central2`), `VAL_TOWN_VAL` | |

### Custom domain

```bash
gcloud beta run domain-mappings create --service eman-expenses --domain expenses.example.com --region <region>
```
Add the DNS records Cloud Run prints (CNAME `ghs.googlehosted.com.` or the A/AAAA set for apex domains), wait for the certificate, then
update `ALLOWED_ORIGIN` in Val Town and the Supabase *URL configuration* to the new domain.

## Meta (WhatsApp) setup

1. **Meta developer app** → add *WhatsApp*; note the **Phone number ID** and **WhatsApp Business Account ID**; create a **System user**
   permanent token with `whatsapp_business_management` + `whatsapp_business_messaging` (`WA_TOKEN`). *App settings → Basic → App secret* is `WA_APP_SECRET`.
   Choose any random string for `WA_VERIFY_TOKEN`.
2. **Flow encryption key** (RSA-2048, passphrase protected):
   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -aes-256-cbc -out flow_private.pem
   openssl rsa -in flow_private.pem -pubout -out flow_public.pem
   ```
   Put the contents of `flow_private.pem` into `WA_FLOW_PRIVATE_KEY` and the passphrase into `WA_FLOW_PRIVATE_KEY_PASSPHRASE`. Do not commit either.
   Upload the **public** key to the phone number:
   `WA_TOKEN=… WA_PHONE_NUMBER_ID=… node valtown/scripts/flow-setup.mjs public-key --pem flow_public.pem`
3. **Webhook**: *WhatsApp → Configuration → Webhook*: callback URL `<backend>/whatsapp/webhook`, verify token = `WA_VERIFY_TOKEN`, then **subscribe to the `messages` field**.
4. **Create & publish the Flow** (`whatsapp/flow.json`: screens SECTION → PHOTO (camera `PhotoPicker`) → CONFIRM (editable total, category, notes) → SUCCESS / DUPLICATE, RETRY and FAILURE):
   ```bash
   WA_TOKEN=… WA_WABA_ID=… node valtown/scripts/flow-setup.mjs create --endpoint <backend>/api/flow --publish
   ```
   The script prints the Flow ID and any Flow-JSON validation errors reported by Meta. Paste the ID into **Dashboard → Settings → `wa_flow_id`**.
   To change the Flow later: `… flow-setup.mjs update --flow-id <id>` (drafts only; a published Flow is immutable – create a new one).
5. **Staff numbers**: Dashboard → Users → add each person with their WhatsApp number in international format. Only numbers of *active* users are accepted;
   messages from other numbers are ignored silently.
6. **How staff use it**: send `مصروف` / `expense` / `hi` to the business number → the bot replies with a button that opens the Flow. They can also paste the Base64
   text or the five fields, or send a photo (single-section users).
7. **Notifications outside 24 h**: WhatsApp only allows free-form messages inside 24 h of the user's last message. For admin alerts and daily/weekly summaries to
   arrive reliably, create an approved *utility* template with one body variable (`{{1}}`) and set Settings → `wa_notify_template` to `{"name":"your_template","lang":"ar"}`.
   Without it the system falls back to plain text (delivered only inside the 24 h window).

## Post-deploy verification

`scripts/smoke-test.mjs` (header lists the env vars) posts sample payloads to the Shortcut, webhook and Flow endpoints, confirms the rows through the admin's RLS-protected
session, checks the audit log, and cleans up. Keep a dashboard tab open while it runs to see the live toast.
