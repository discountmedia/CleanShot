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

## 4. Store in GCP Secret Manager

```bash
# Store each secret individually
echo -n "YOUR_CLIENT_ID"     | gcloud secrets create cleanshot-ms-client-id     --data-file=-
echo -n "YOUR_CLIENT_SECRET" | gcloud secrets create cleanshot-ms-client-secret  --data-file=-
echo -n "YOUR_BETTER_AUTH_SECRET" | gcloud secrets create cleanshot-better-auth-secret --data-file=-

# Grant Cloud Run service account access
gcloud secrets add-iam-policy-binding cleanshot-ms-client-id \
  --member="serviceAccount:forklift-api@cleanshot-493512.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
# Repeat for each secret
```

## 5. Add to Cloud Run deploy command

In `.github/workflows/deploy-web.yml`, add to `--set-secrets`:
```
MICROSOFT_CLIENT_ID=cleanshot-ms-client-id:latest,
MICROSOFT_CLIENT_SECRET=cleanshot-ms-client-secret:latest,
BETTER_AUTH_SECRET=cleanshot-better-auth-secret:latest
```

## 6. Add to Vercel environment variables

In your Vercel project dashboard → Settings → Environment Variables, add:
```
AUTH_ENABLED            = true
MICROSOFT_CLIENT_ID     = [from Secret Manager or direct]
MICROSOFT_CLIENT_SECRET = [from Secret Manager or direct]
MICROSOFT_TENANT_ID     = common
BETTER_AUTH_SECRET      = [generate: openssl rand -hex 32]
ALLOWED_DOMAINS         = yourdomain.com
ALLOWED_EMAILS          = specific@outlook.com
```

## 7. Apply GCS lifecycle rule

```bash
gcloud storage buckets update gs://cleanshot-derivatives-493512 \
  --lifecycle-file=infra/gcs-lifecycle-approved.json
```

Verify:
```bash
gcloud storage buckets describe gs://cleanshot-derivatives-493512 \
  --format="value(lifecycle_config)"
```

## 8. Run Better Auth DB migration

```bash
# From apps/web directory
pnpm dlx @better-auth/cli migrate
```

This creates: `user`, `session`, `account`, `verification` tables in Postgres.
Then run CleanShot's own migration for `authorization`, `approval_sets`, `approval_set_assets`:

```bash
# In FastAPI startup (local) or via psql in production
psql $DATABASE_URL -f db/migrate_auth.sql
```

## 9. Add allowlist entries at runtime (without redeploy)

```sql
-- Add a domain
INSERT INTO authorization (type, value, note)
VALUES ('domain', 'newpartner.com', 'Added by admin 2026-05-15');

-- Add an individual email
INSERT INTO authorization (type, value, note)
VALUES ('email', 'contractor@personal.com', 'Freelance photographer');

-- Remove
DELETE FROM authorization WHERE value = 'oldpartner.com';
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
