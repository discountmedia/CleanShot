# Session handoff — 2026-05-26

Resume notes for picking up CleanShot work on the home machine. This file is a snapshot of where things were left at end-of-session; CLAUDE.md is the authoritative project briefing (read that for full context).

---

## State of the repo

- **Branch:** `main`
- **All session commits are pushed** to `origin/main` (last pushed commit: `f004606`).
- **One commit pending** at session end — pairs the perf bump with this handoff doc + the CLAUDE.md refresh. Push it from the home machine to land everything:

  ```bash
  git pull origin main         # safety net in case anything else landed
  git push origin main
  ```

---

## Manual ops that still need to happen on Cloud Shell

These are *not* in code — they're shared-infra side effects of recent commits. Do them in this order.

### 1. Cloud Tasks dispatch rate (single biggest perf win)

**Why this matters:** the `cleanshot-image-gen` queue currently dispatches at `0.1` jobs/sec. A 10-image × 6-provider batch is 60 jobs → **600 seconds just to dispatch** before any vendor call begins. Per-provider rate limiters (5/60s OpenAI, 3/30s Reve/Grok) become the *real* ceiling at 1.5/s — the queue is a bottleneck right now.

```bash
gcloud tasks queues update cleanshot-image-gen \
  --location=us-central1 \
  --max-dispatches-per-second=1.5 \
  --max-concurrent-dispatches=20 \
  --project=cleanshot-493512
```

Verify:

```bash
gcloud tasks queues describe cleanshot-image-gen \
  --location=us-central1 --project=cleanshot-493512 \
  --format="value(rateLimits)"
```

Should print something like `maxConcurrentDispatches: 20, maxDispatchesPerSecond: 1.5`.

### 2. Verify the photo-library lifecycle clear actually took

The bucket lifecycle was cleared mid-session via `gcloud storage buckets update gs://cleanshot-derivatives-prod --clear-lifecycle`. Re-verify it didn't snap back:

```bash
gcloud storage buckets describe gs://cleanshot-derivatives-prod \
  --format="value(lifecycle_config)" \
  --project=cleanshot-493512
```

Empty output = good. If it shows a `rule=[{...age: 60...}]` block, re-run `--clear-lifecycle`.

### 3. Reve API key rotation (only if not already done)

CLAUDE.md hard-won lesson #21 has the pattern. Quick version — paste your real Reve key:

```bash
read -s -p "Reve key (input hidden): " K && echo
printf "%s" "$K" | gcloud secrets versions add cleanshot-reve-key --data-file=- --project=cleanshot-493512
unset K
history -d $((HISTCMD-1))
```

Verify (length only, no value leak):

```bash
gcloud secrets versions access latest --secret=cleanshot-reve-key --project=cleanshot-493512 | wc -c
```

Expect ~30–80 bytes. Then roll the running revision so it picks up the new value:

```bash
gcloud run services update cleanshot-api \
  --region=us-central1 \
  --update-secrets="REVE_API_KEY=cleanshot-reve-key:latest" \
  --project=cleanshot-493512
```

(Or push an empty commit — the workflow's `--set-secrets` line already includes `REVE_API_KEY=cleanshot-reve-key:latest` as of the Recraft→Reve swap.)

---

## What landed this session — commit-by-commit

In chronological order on `main`:

| Commit | Subject | App(s) affected |
|---|---|---|
| `9fd8df1` → `b98f1f1` | Recraft V3 wire-up + five fixes (auth strip / body alignment / whitespace nuke / prompt cap × 2) | API |
| `b21e9eb` | CLAUDE.md — Recraft end-to-end lessons + hard-won lesson #21 (secret-value contamination) | Docs |
| `d06424a` | Modify → "Continue to Resize" CTA after successful Apply | Web |
| `367cafa` | **Recraft → Reve swap.** Recraft removed, Reve restored as 6th primary generator. | API + Web + Docs |
| `32df157` | **Infinite photo-library storage.** GCS lifecycle deleted; `expires_at` nullable; UI badge hides when NULL. | API + Web + Docs |
| `f004606` | Toggles default OFF on landing + "Select all" checkbox in AI providers header | Web |
| *(pending)* | Cloud Run `min-instances` 2 → 5 + CLAUDE.md perf refresh + this HANDOFF doc | API workflow + Docs |

---

## Open items by priority (top of CLAUDE.md "Open work items" — full list there)

1. **Cloud Tasks dispatch rate bump (above).** One gcloud command, biggest perceived-speed win.
2. **OpenAI `/v1/responses` quota pressure.** Enhance (gpt-5 + image_generation) and scan (gpt-5.4) share the same endpoint quota — already caused one scan cascade failure. Pick: tier-bump the OpenAI org, OR add a scan-side `AsyncRateLimiter` on `/v1/responses`.
3. **Per-model enhance prompts** — biggest *quality* lever left. `_build_kontext_prompt` first (Kontext wants 1-3-sentence imperative prose, not the 200-line scene prose), then `_build_reve_prompt` (Reve has a 2560-char cap and auto-enhances internally — terse prose), then `_build_openai_prompt` + eval harness.
4. ~~Gemini thinking_level High → Medium~~ — **DEAD LEVER.** `gemini-3.1-flash-image-preview` only accepts `"High"`. CLAUDE.md item #4 marked accordingly this session.
5. **Provider-output cache** keyed on `(image_sha256, prompt, provider)` via Valkey. Big win on the "tweak toggles, re-enhance" loop.

---

## Heads-up gotchas worth re-reading

- **Hard-won lesson #21** in CLAUDE.md (secret-value contamination with gcloud command text). Bit `cleanshot-recraft-key` twice this session. Pattern: `read -s` + `printf "%s"` + `--data-file=-`. Never `echo`.
- **The `--set-secrets` line in `.github/workflows/deploy-api.yml` is authoritative.** Manual `gcloud run services update --set-secrets` from the CLI wipes the others. Use `--update-secrets` for single-key rotations.
- **Auto-mode classifier blocks `git push` from the assistant.** All pushes this session were either manual by you or allowed through. If a future session ends with unpushed commits, that's why.
- **Process-local rate limiters under min-instances=5.** Effective ceiling is `limit × 5` under burst load. Either accept the looser real ceiling or move to Valkey-backed (CLAUDE.md Open Work Item #6). Don't tighten the local values to "compensate" — that wastes capacity on cold instances.

---

## How to verify the pending commit deployed correctly

After pushing:

1. Watch the API deploy: `gh run watch --repo=discountmedia/CleanShot` (or the GitHub Actions tab).
2. Confirm `min-instances=5` actually took:

   ```bash
   gcloud run services describe cleanshot-api \
     --region=us-central1 --project=cleanshot-493512 \
     --format="value(spec.template.metadata.annotations.run\.googleapis\.com/minScale)"
   ```

   Should print `5`.
3. Then run the Cloud Tasks dispatch-rate bump (step 1 above). Don't conflate the two — they're independent wins.

---

## Quick context: where the time goes on a typical 10-image batch

| Phase | Time (current) | After unlocks |
|---|---|---|
| Upload (web → GCS) | 5–15s (parallel) | unchanged |
| Cloud Tasks dispatch (60 jobs at 0.1/s) | **~600s** | ~40s @ 1.5/s |
| Cold-start tax (first 1-2 jobs) | 2–5s × bursts | ~0s @ min-instances=5 |
| Vendor inference (slowest provider) | 75s (OpenAI) | unchanged — provider mix |
| Wall-clock end-to-end | ~10–12 min | ~90s (best case) |

Dispatch rate is the bottleneck right now. After step 1 above, the binding constraint becomes the per-provider rate limiters and vendor inference time — and the bottleneck shifts to "do we have OpenAI checked or not."
