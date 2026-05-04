# CleanShot Backend v2.4 — Multi-Provider Scan Tool

## What's new in v2.4

This release adds the **Scan tool** alongside the existing Enhance tool. Scan
runs an uploaded image through Gemini (Vertex AI), OpenAI (gpt-4o), and
Anthropic (claude-sonnet-4-5) **in parallel** and merges the verdicts via
majority vote.

The frontend can use Scan and Enhance independently. The user can also Enhance
an image, then run Scan on the result — but transitions are always
user-initiated, never automatic.

## Files in this drop

```
backend/
├── app/
│   ├── api/
│   │   ├── condition.py          (REPLACE — v2.3 brand rule toggles, no scan changes)
│   │   └── scan.py               (NEW)
│   ├── services/
│   │   ├── gemini.py             (REPLACE — v2.3 modular prompt, no scan changes)
│   │   └── scan.py               (NEW)
│   ├── workers/
│   │   └── arq_worker.py         (REPLACE — handles scan + enhance operations)
│   └── main.py                   (REPLACE — adds scan router, version 2.4.0)
├── requirements-worker.txt        (REPLACE — adds openai + anthropic SDKs)
└── smoke_test.py                  (REPLACE — supports --scan flag)
```

## Architectural decisions baked in

**Multi-provider voting**

- Gemini always runs (uses Vertex AI ADC, no key needed)
- OpenAI runs if `OPENAI_API_KEY` is present (Secret Manager)
- Anthropic runs if `ANTHROPIC_API_KEY` is present (Secret Manager)
- All three providers fail gracefully — one failure doesn't kill the request
- All three failing throws an error (no silent degradation)

**Verdict logic**

- Full agreement (all providers same verdict) → confidence stays high
- Majority (N-1 agree) → confidence reduced 15%
- Split (no majority) → escalate to REVIEW (unless ALL say FAIL), confidence
  reduced 35%

**Result storage**

- Enhance writes a derivative image to GCS, returns signed download URL
- Scan stores the JSON result inline in the Redis job hash (no GCS write
  needed for scan; the result is small structured data)

**Idempotency**

- Each operation has a stable, deterministic job ID derived from inputs
- Same scan request twice → same job_id → only runs once
- Same enhance request with different toggles → different job_id → both run

## Deploy steps (run in order)

### 1. Replace files

Drop these files into `C:\Users\skcun\Documents\GitHub\CleanShot\backend\`:

```
app/services/scan.py             (NEW — create this file)
app/api/scan.py                  (NEW — create this file)
app/services/gemini.py           (REPLACE)
app/api/condition.py             (REPLACE)
app/workers/arq_worker.py        (REPLACE)
app/main.py                      (REPLACE)
requirements-worker.txt          (REPLACE)
smoke_test.py                    (REPLACE)
```

### 2. Store the OpenAI key in Secret Manager

Run in Cloud Shell. The key value goes through stdin so it never sits in
shell history or chat logs:

```bash
PROJECT=cleanshot-493512

# Create the secret (one-time)
gcloud secrets create openai-api-key \
  --replication-policy="automatic" \
  --project=$PROJECT

# Add a version. Paste your key when prompted, then Ctrl+D
gcloud secrets versions add openai-api-key --data-file=- --project=$PROJECT

# Grant the worker SA access
gcloud secrets add-iam-policy-binding openai-api-key \
  --member="serviceAccount:forklift-worker-image@${PROJECT}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=$PROJECT
```

### 3. Store the Anthropic key in Secret Manager

```bash
gcloud secrets create anthropic-api-key \
  --replication-policy="automatic" \
  --project=$PROJECT

gcloud secrets versions add anthropic-api-key --data-file=- --project=$PROJECT

gcloud secrets add-iam-policy-binding anthropic-api-key \
  --member="serviceAccount:forklift-worker-image@${PROJECT}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=$PROJECT
```

### 4. Build and push v3 images

```cmd
cd C:\Users\skcun\Documents\GitHub\CleanShot\backend

docker compose build

docker tag backend-api:latest us-central1-docker.pkg.dev/cleanshot-493512/cleanshot/api:v3
docker push us-central1-docker.pkg.dev/cleanshot-493512/cleanshot/api:v3

docker tag backend-worker:latest us-central1-docker.pkg.dev/cleanshot-493512/cleanshot/worker-image:v3
docker push us-central1-docker.pkg.dev/cleanshot-493512/cleanshot/worker-image:v3
```

### 5. Update API to v3

The API doesn't need OpenAI/Anthropic keys (only the worker calls them):

```cmd
gcloud run services update forklift-api ^
  --region=us-central1 ^
  --image=us-central1-docker.pkg.dev/cleanshot-493512/cleanshot/api:v3
```

### 6. Update Worker Pool to v3, mount both secrets

```cmd
gcloud beta run worker-pools update forklift-worker-image ^
  --region=us-central1 ^
  --image=us-central1-docker.pkg.dev/cleanshot-493512/cleanshot/worker-image:v3 ^
  --update-secrets=OPENAI_API_KEY=openai-api-key:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest
```

### 7. Smoke test scan

```cmd
cd C:\Users\skcun\Documents\GitHub\CleanShot\backend
python smoke_test.py C:\path\to\forklift.jpg https://forklift-api-l4xpvatepq-uc.a.run.app/api/v1 --scan
```

Expected output ends with something like:

```
[6] DONE in 18s
    verdict:    PASS
    confidence: 88
    agreement:  full
    source:     triple
    summary:    gemini: ... | openai: ... | anthropic: ...
```

If any provider was skipped (no key) or failed, `source` will indicate which
ones contributed and `warnings` will list failures.

## Cost notes

Per scan call (rough order-of-magnitude per image):

- Gemini 2.5 Flash Image: ~$0.005
- GPT-4o vision: ~$0.01
- Claude Sonnet vision: ~$0.012
- **Total per triple-scan: ~$0.027**

That's about 7× the cost of a single-provider scan but provides verdict
robustness via majority vote. For an internal tool with predictable volume,
this is fine. If volume scales, an obvious optimization is to run only Gemini
by default and trigger OpenAI + Anthropic only when Gemini's confidence is low
or verdict is FAIL.

## What did NOT change

- Phase 1 training pipeline (still archived, untouched)
- The `forklift-api` service account, its IAM bindings, or the bucket
  permissions
- The Redis instance, VPC peering, or subnet
- The Enhance tab's prompt logic (already at v2.3 with brand toggles)
- The frontend (still just the connectivity test page; tab UIs come next)
