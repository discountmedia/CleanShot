# Microsoft Entra App Registration — CleanShot Microsoft SSO Setup

Follow these steps exactly. Estimated time: 10 minutes.

## 1. Register the App

1. Go to [entra.microsoft.com](https://entra.microsoft.com)
2. In the left menu → **Identity** → **Applications** → **App registrations** → **New registration**
3. Fill in:
   - **Name:** `CleanShot`
   - **Supported account types:** `Accounts in any organizational directory and personal Microsoft accounts`
     > This allows any Microsoft account to attempt sign-in. The domain/email allowlist
     > in CleanShot gates who actually gets in.
   - **Redirect URI:** Platform = `Web`
     - Production: `https://your-domain.com/api/auth/callback/microsoft`
     - Local dev:   `http://localhost:3000/api/auth/callback/microsoft`
     > Add both. You can add more redirect URIs later under Authentication.
4. Click **Register**

## 2. Copy your credentials

On the app overview page, copy:
- **Application (client) ID** → `MICROSOFT_CLIENT_ID`
- **Directory (tenant) ID** → `MICROSOFT_TENANT_ID` (use `common` to allow any tenant)

## 3. Create a Client Secret

1. Left menu → **Certificates & secrets** → **New client secret**
2. Description: `cleanshot-production`
3. Expiry: **24 months** (set a calendar reminder to rotate)
4. Click **Add** → copy the **Value** immediately (it won't be shown again)
   → `MICROSOFT_CLIENT_SECRET`

## 4. Add to Vercel environment variables

The web app runs on Vercel, not Cloud Run, so the Microsoft secrets live in
the Vercel project's env vars (not GCP Secret Manager).

In your Vercel project dashboard → Settings → Environment Variables, add (set
for **Production** and **Preview**; mark the two `*_SECRET` vars as Sensitive):

```
AUTH_ENABLED            = true
MICROSOFT_CLIENT_ID     = <client id from step 2>
MICROSOFT_CLIENT_SECRET = <client secret value from step 3>
MICROSOFT_TENANT_ID     = common
BETTER_AUTH_SECRET      = <generate: openssl rand -hex 32>
BETTER_AUTH_URL         = https://<your-vercel-domain>
ALLOWED_DOMAINS         = yourdomain.com,otherdomain.com
ALLOWED_EMAILS          = specific@outlook.com           # optional, comma-separated
```

For the Development environment, Vercel blocks sensitive vars by default — set
`AUTH_ENABLED=false` there so `next dev` skips SSO entirely.

After saving, trigger a redeploy from the Vercel dashboard so the new env
vars are picked up.

## 5. (Removed — Cloud Run deploy doesn't carry MS secrets)

The Microsoft OAuth flow runs entirely in the Next.js BFF on Vercel. Cloud
Run only sees the authenticated `X-User-Email` header that the BFF injects.

## 6. GCS lifecycle — photo library is stored indefinitely

As of 2026-05-26, the approved/ photo library is kept forever (operator
decided "photo library storage is infinite"). No lifecycle rule needed.

If the bucket inherits an old policy from a prior setup, clear it:

```bash
gcloud storage buckets update gs://cleanshot-derivatives-prod \
  --clear-lifecycle
```

Verify the bucket has no active lifecycle rules:
```bash
gcloud storage buckets describe gs://cleanshot-derivatives-prod \
  --format="value(lifecycle_config)"
```

Expected output:
```
rule=[{'action': {'type': 'Delete'}, 'condition': {'age': 60, 'matchesPrefix': ['approved/']}}]
```

## 7. (Was: Vercel env vars — now covered in step 4)

## 8. DB schema (automatic)

You don't run anything manually. The FastAPI service applies the full auth +
approval schema on startup via `apps/api/src/cleanshot_api/db/migrate_auth.py`:

- Better Auth tables: `ba_user`, `ba_session`, `ba_account`, `ba_verification`
- CleanShot tables: `authorizations`, `approval_sets`, `approval_set_assets`
- Seed: the 4 `discountforklift*` domains are inserted into `authorizations`

The migration is idempotent (CREATE TABLE IF NOT EXISTS / ON CONFLICT DO
NOTHING) and serialized across replicas via `pg_advisory_xact_lock`. So
deploying the API is what creates the schema — no separate migration step.

If you ever need to inspect or hand-edit the schema, use Cloud Shell:
```bash
gcloud sql connect cleanshot-postgres --user=postgres --database=cleanshot
```

## 9. Add allowlist entries at runtime (without redeploy)

```sql
-- Add a domain
INSERT INTO authorizations (type, value, note)
VALUES ('domain', 'newpartner.com', 'Added by admin 2026-05-15');

-- Add an individual email
INSERT INTO authorizations (type, value, note)
VALUES ('email', 'contractor@personal.com', 'Freelance photographer');

-- Remove
DELETE FROM authorizations WHERE value = 'oldpartner.com';
```

## Auth flow recap (matches your diagram)

```
User visits CleanShot
    ↓
AUTH_ENABLED=false? → bypass, app works normally (dev mode)
    ↓ yes
Has valid Better Auth session cookie? → yes → App loads
    ↓ no
Redirect → /login
    ↓
Clicks "Sign in with Microsoft"
    ↓
Microsoft OAuth → returns email + oid
    ↓
checkAuthorization(email):
  1. ALLOWED_DOMAINS env var (e.g. acme.com)
  2. ALLOWED_EMAILS env var (specific addresses)
  3. Postgres authorization table (runtime additions)
    ↓ pass              ↓ fail
Set session cookie    → /unauthorized
Redirect → app
```
