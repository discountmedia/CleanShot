# Session handoff — updated 2026-08-21 (second pass)

Resume notes for picking CleanShot back up in a new chat. **`CLAUDE.md` is the authoritative, continuously-updated project briefing** — read it first (esp. "Enhance tab — current shape"). This file is the "where we are right now / what's pending" snapshot.

---

## Repo state

- **Branch:** `main`. Direct-to-main is the norm (no PR review).
- **The Enhance-tab restructure batch is already pushed** (`ad7f0a6`) and deployed. This second pass carries the layout tweaks, the differential-scan colour fix, and the 2800x2000 sizing standard.
- **The first push was a large one** — it carries the Enhance-tab restructure, saved prompts, scan-bar colours, and the experimental fork conditionals, all in one commit. If something is off in prod, that is the commit to look at.
- **The first push shipped a schema change.** `saved_prompts` was added to `db/migrate.py`, which runs on API startup, so the deploy applied it. This second push adds no schema change. No `ALTER TYPE` was needed — `OperationEnum.export` already existed for the export asset rows.
- **Untracked:** `AGENTS.md` (a Codex-facing pointer to CLAUDE.md) is present but not committed, as found.

---

## What shipped in this batch

**Enhance tab restructure**
- Toggles reduced to four visible (`VISIBLE_TOGGLES`); the rest hidden, not deleted.
- Scan runs inline on Enhance, read from the auto-enqueued backend scans. No navigation to the Scan tab.
- Scan tab decoupled into a standalone tool with its own uploader.
- Per-image Retry restored on each variant (it had been deliberately removed in an earlier pass — the operator asked for it back).
- Per-image contrast/saturation; the bulk `ModifyPanel` is unmounted.
- Re-enhance dirty-input guard removed.
- Export writes to the user's project (finished files + originals, one copy each) and is the only save action; Save Project button gone.

**Saved prompts** — new `saved_prompts` table, `routers/saved_prompts.py`, `/api/prompts` BFF, `SavedPromptsBar.tsx`. Unique per user on `lower(title)`; a collision is a 409 the UI turns into overwrite-or-rename.

**Scan provider colours** — `SCAN_PROVIDER_COLOR`, a documented palette exception, applied on both tabs.

**Fork conditionals** — experimental, OFF by default, session-only master switch above the Enhance button.

**Reverted:** the mandatory disclaimer. It is an optional checkbox again, now defaulting ON.

**Layout pass** — save-prompt button moved right and turned lime, the saved-prompt dropdown moved up beside "Insert recommended prompt", Download ZIP moved to the left of its row, and scan verdict text stepped up the type scale on both tabs. Version label is now `Beta V.2`.

**Differential scan can report colour again.** It could not: a blanket "a repaint is NEVER a defect" in the rubric, and an `AnomalyItem.type` description that listed `wrong_colour` while forbidding "paint/colour changes" in the same sentence, meant a full grey-to-orange body repaint scanned clean. Now scoped to same-colour-family, with two explicit defects (body panel colour family, non-marking tyres turned black).

**Sizing standardised at 2800x2000.** `upscale_to_standard()` runs once at the end of enhancement; `export_pro` no longer resizes or crops. Input resolution is uncapped on both the client and the enhance worker; the scan path keeps its own 2576px cap, set to Anthropic's high-resolution vision tier so nothing is uploaded that the model would only downscale.

---

## The thing still owed: a real end-to-end smoke test

Everything is verified by `tsc` / `next build` / lint / py-compile and by exercising the prompt-fragment builders directly. **Nobody has put a real photo through the pipeline in prod for any of this.** The API changes in particular are compile-verified only — there is no Python env on the dev machine, so the test suite has not been run.

Highest-value checks, in order:

1. **DIMENSIONS — the one I could not verify at all.** There is no Python environment on the dev machine (no `pyvips`, no `fastapi`) and no GCP credentials, so I could not run a batch or read output files. The crop maths is verified with PIL against six aspect ratios (1.40, 1.50, 4:3, portrait, square, already-standard) and lands exactly 2800x2000 in every case, but that is the ALGORITHM, not the pyvips implementation or the live pipeline. **Please run a batch including at least one non-7:5 source and check actual output dimensions at two points:** the enhanced asset in GCS, and the exported file. Both should read 2800x2000.
2. **Scan colour fix.** Re-scan the grey-to-orange Toyota pair. Expect two `wrong_colour` anomalies: `battery_compartment` and `tires`. Then run several correctly-enhanced images and confirm it stays quiet — the risk with this change is firing on every image, which is worse than the miss it fixes.
3. **Export → library.** Run a 2-provider batch, pick winners, export. Confirm the Photo Library shows the exported files AND the originals, exactly once each, and that a re-export updates that set instead of adding a duplicate.
4. **Saved prompts.** Save a prompt, re-insert it, save a colliding title (expect overwrite/rename, not a silent duplicate), rename, delete. Confirm a second user cannot see the first's prompts once `AUTH_ENABLED=true`.
5. **Inline scan.** Confirm verdicts appear per variant and that a single failed scan marks only its own image.
6. **Fork conditionals.** Off by default. Turn on, tick both controls on one image, retry, and check the output stops inventing a shank / shortening the forks. Then turn the switch off and confirm the prompt goes back to exactly what it was.
7. **Default-path prompt drift.** The fork block was split from one paragraph into sentences. The "both visible" case is meant to be semantically identical — worth a side-by-side on a few images before trusting it on a real batch, given this repo's history with prompt changes.

---

## Open questions

- **How should the disclaimer watermark finally work?** It is a checkbox defaulting ON as a holding position. Until that is decided, expect this to move again. Note the server-side defaults are now `True` (they were `False` before), so an omitted flag watermarks rather than silently skipping.
- **Do the fork conditionals actually help?** Unmeasured. If they do, the next step is automatic detection — which needs a pre-pass on the SOURCE photo, because the existing scan runs after enhance.
- **Is `deformed_part` worth suppressing at the display layer?** Raised and deferred. `geometry_altered` is already gone from the differential vocabulary, but the isolated scan (standalone Scan-tab uploads) still reports `deformed_part`, which covers both warped geometry and genuinely melted structure.
- **Does the uncapped input break OpenAI?** The 1024px cap existed because `/v1/responses` with full-res smartphone photos was reliably blowing past a 90s timeout. That was the stated reason in the code. Removing it may bring the timeouts back; watch enhance latency and failure rate on the first real batches. `INPUT_MAX_LONG_EDGE_PX` is still there, unapplied, so restoring the cap is one line.
- **Export file size and ZIP memory.** 2800x2000 at Q92 is roughly 1.5-3 MB per image, up from ~150-300 KB. The ZIP builder buffers the whole archive in `io.BytesIO` before upload, so a 150-image batch goes from ~40 MB to ~300 MB resident on a Cloud Run instance. Not addressed — it is outside the sizing path — but it is now a real ceiling on batch size.
- **Centre crop vs attention crop.** `_cover_crop` centres, as specified. On an extreme aspect ratio a centre crop can slice the ends off the machine where `smartcrop(interesting="attention")` would follow it. Worth revisiting if operators report cropped forks.
- **Should `computeConsensus` still return `"mixed"` when one of three providers fails?** A single over-eager vote costs a clean pass badge. This is a verdict-semantics decision, not a bug.
- **Brightness / crop / straighten** are unreachable from the UI now that the bulk panel is gone, though the backend still supports them. Wanted per-image, or genuinely retired?

---

## Pending CODE work (parked, prioritised)

1. **Judge follow-ups:** log the judge's Claude spend to `usage_events` (needs `OperationEnum.judge` + `ALTER TYPE`, lesson #12); add an `AsyncRateLimiter` on the judge's Anthropic calls (shares scan's `claude-sonnet-4-6` tier).
2. **Prompt-first Phase 2 — iterative refinement.** "Change it more without starting over." The per-variant **Tweak** tool already does text-guided refinement — surface/rename it rather than building new.
3. **Model-routing for hard equipment types.** Prompt wording is a DEAD lever for warehouse-electric gear (reach / order-picker / walkie / pallet) — Gemini drifts regardless. The real levers are best-of-N (shipped, extend it) or routing those types elsewhere.
4. **Per-user access control — Phase 2 (admin audit logging).** Still unbuilt. NOTE: `access-control.ts` is currently **defanged** (`USER_RESTRICTIONS = {}`); rebuild it if per-user gating is wanted again.
5. **Extract `_load_image_bytes`** to `services/gcs.download_image` — triplicated across the workers (TODO marker in code).

---

## Pending OPERATOR steps (dashboards / gcloud / env — not code)

- **`AUTH_ENABLED=true`** in Vercel (Production) when ready — locks the app behind Microsoft SSO + activates the email allowlist. Confirm the allowlist first; test on Preview. Still inert; the workspace runs as `dev@local`. **Saved prompts are keyed on the signed-in email**, so everything saved while running as `dev@local` belongs to `dev@local`.
- **Watch the first API revision after this push** — it runs the `saved_prompts` migration on startup.
- `cleanshot-xai-key` (Grok) is dormant but the secret stays (one-line re-enable). `cleanshot-recraft-key` is still safe to delete.
- Domain onboarding is a **4-place checklist** (lesson #26): Vercel + `lib/auth.ts` trustedOrigins + Entra redirect URI + `infra/gcs-cors.json` (re-apply to BOTH buckets).

---

## Docs

- **CLAUDE.md** — rewritten this session. The three per-session log blocks were replaced by one durable "Enhance tab — current shape" section (keeping the findings that still constrain work), and the archived changelog was pruned. Authoritative.
- **README.md** — current-state note, "What It Does", "The Workflow", and the storage section rewritten to match the app.
- **AGENTS.md** — a thin pointer to CLAUDE.md. **Left untracked** (as found — `git add AGENTS.md` if you want it in the repo).
- **STYLE_GUIDE.md / ENTRA_SETUP.md / .instructions.md** — unaffected (evergreen).

---

## Gotchas / conventions (full list in CLAUDE.md)

- **Deps:** `cd apps/web && pnpm add <dep>` — NEVER npm, NEVER from repo root (lesson #25).
- **After API pushes**, arm a Cloud Run revision watcher for a one-shot "deploy done" ping; web-only pushes (Vercel) don't need it.
- **New UI:** conform to `STYLE_GUIDE.md`. Note it predates the house-palette rewrite in places — `globals.css` tokens win where they disagree.
- **`gcloud` is off the session PATH** — call by full path (`C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`), and from Bash it needs PowerShell's `&` call operator, not `cmd /c`.
- **Pre-existing lint debt:** 8 errors, unchanged by this batch — one `enhanceJobsRef` "refs during render" in `EnhancePanel.tsx` plus `react-hooks/set-state-in-effect` across several files. Not the deploy gate; `tsc` is. Don't chase them.
- Commit trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
