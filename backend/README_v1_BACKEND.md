# CleanShot Backend — v1 (Phase 2 v2.2)

This drop replaces every Python file in `backend/app/`, the requirements files, and `docker-compose.yml`. It does NOT touch the Dockerfiles — those were already correct.

## What's in this drop

```
backend/
├── docker-compose.yml         # ADC-based, new bucket names
├── requirements-base.txt      # google-genai==1.70.0 pinned, redis added, etc.
├── requirements-api.txt
├── requirements-worker.txt
├── smoke_test.py              # end-to-end test script
└── app/
    ├── __init__.py            # (existing — leave alone)
    ├── config.py              # REPLACED — real bucket names, ADC defaults
    ├── main.py                # REPLACED — all routes wired, lifespan complete
    ├── api/
    │   ├── __init__.py        # NEW — empty marker
    │   ├── health.py          # REPLACED — /healthz + /readyz
    │   ├── sessions.py        # NEW
    │   ├── assets.py          # NEW
    │   ├── condition.py       # REPLACED — real enqueue
    │   └── jobs.py            # REPLACED — polling, no SSE
    ├── services/
    │   ├── gemini.py          # REPLACED — SDK bugs fixed, GA model
    │   ├── storage.py         # REPLACED — signed URLs, ADC
    │   └── session.py         # REPLACED — Redis-backed
    └── workers/
        └── arq_worker.py      # REPLACED — real progress reporting
```

## Setup steps (one-time)

1. **Authenticate with gcloud** so the containers have ADC creds:
   ```cmd
   gcloud auth application-default login
   ```
   This writes `application_default_credentials.json` to `%APPDATA%\gcloud\` on Windows.

2. **Verify the buckets exist** (they should, from the GCP setup):
   ```cmd
   gcloud storage buckets list --filter="name:cleanshot-*"
   ```
   You should see `cleanshot-originals-prod` and `cleanshot-derivatives-prod`.

3. **Drop these files into your repo** at the matching paths under `backend/`.

4. **Build and run**:
   ```cmd
   cd backend
   docker compose build --no-cache
   docker compose up
   ```
   First build is slow (libvips + python deps). Subsequent builds are fast.

5. **In another terminal, run the smoke test** with a real forklift photo:
   ```cmd
   pip install requests
   python smoke_test.py C:\path\to\some_forklift.jpg
   ```

   Expected output: ~30–60 seconds, ending with a `download_url` you can paste into a browser to see the enhanced image.

## What the smoke test proves

- ✅ FastAPI boots and hits Redis
- ✅ Signed PUT URLs work (browser-style direct upload to GCS)
- ✅ Asset record persists in Redis
- ✅ Arq enqueues with idempotency
- ✅ Worker pulls the job, calls Gemini, writes derivative
- ✅ Job hash updates flow back to the API
- ✅ Signed GET URL on the result is browser-loadable

If all six work, **Phase 2 is done** and we can move to deploying these same containers to Cloud Run.

## Common issues

**Smoke test hangs at "uploading"** — your ADC creds aren't being mounted. Check:
```cmd
docker compose exec api ls -la /gcp-creds/
```
You should see `application_default_credentials.json`. If not, your `%APPDATA%` path differs — adjust the volume mount in `docker-compose.yml`.

**Job fails with "Gemini returned no image"** — could be content filter, could be quota. Check worker logs:
```cmd
docker compose logs worker --tail 50
```

**403 Forbidden on the signed PUT URL** — your gcloud user account needs `roles/iam.serviceAccountTokenCreator` on `forklift-api@cleanshot-493512.iam.gserviceaccount.com` for IAM signing to work. We'll create that SA in the next step (Phase 4 Step 10). Until then, signed URLs may need direct credential-based signing — see `storage.py` comments.

## What's NOT in this drop yet

- Clean tab (variation on Enhance — easy follow-up)
- Resize tab (uses pyvips, no Gemini call — different shape)
- Two-queue split (single queue for v1; split lands with Veo in Phase 4.5)
- Postgres-backed video job idempotency (Redis-only for v1)
- Frontend (Phase 3)

## Next

Once smoke test passes locally, we:
1. Create the Cloud Run service accounts (Phase 4 Step 10)
2. Push these images to Artifact Registry
3. Deploy to Cloud Run (API service + worker pool)
4. Re-run the smoke test against the Cloud Run URL
