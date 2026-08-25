# Session handoff — updated 2026-08-25

Resume notes for picking CleanShot back up in a new chat. **`CLAUDE.md` is the authoritative, continuously-updated project briefing** — read it first (esp. "Enhance tab — current shape"). This file is the "where we are right now / what's pending" snapshot.

---

## Repo state

- **Branch:** `main`. Direct-to-main is the norm (no PR review).
- **This batch is the shared prompt-template library** — saved prompts stopped being private and became one company-wide, rateable library. It is a schema change plus a behaviour change to data that already exists in prod.
- **It ships a schema change**, applied by `db/migrate.py` on API startup, so the deploy applies it. Three parts: the unique index moves from `(user_email, lower(title))` to `lower(title)`, a `use_count` column is added, and a `saved_prompt_votes` table is created. **Watch the first API revision** — a guarded one-time `DO` block de-duplicates any cross-user title collisions (suffixing `(2)`, `(3)`) *before* building the new unique index. If that block fails, the index never builds and the migration wedges.
- **Untracked:** `AGENTS.md` (a Codex-facing pointer to CLAUDE.md) is present but not committed, as found.
- **Previous batch** (`ad7f0a6` + the 2026-08-21 second pass) carried the Enhance restructure, the original per-user saved prompts, scan-bar colours, the 2800x2000 sizing standard, the differential-scan colour fix, and the fork conditionals. If something unrelated to templates is off in prod, those are the commits to look at.

---

## What shipped in this batch

**Saved prompts became shared templates.** Every saved prompt is now visible to, and usable by, every signed-in user. The pre-existing private prompts were **published** by the migration — a deliberate decision, not a side effect. `user_email` on the row is now the CREATOR, not an access scope.

- Reads are unscoped (`list_saved_prompts` has no filtering `WHERE`). The forwarded email resolves exactly one per-viewer field, `voted`.
- Each row carries **author + date** as a byline, resolved by `LEFT JOIN user_profiles` with a fallback chain of full_name, then email local-part, then email.
- The picker is a **custom listbox**, not a `<select>` — a native `<option>` is plain text only and cannot carry a byline, a use count, or a vote button.

**Titles and bodies are immutable.** `PATCH /api/v1/prompts/{id}`, `rename_saved_prompt`, `overwrite_saved_prompt_body`, `RenameSavedPromptRequest` and the `overwrite` request field were **deleted**, not deprecated. Votes and use counts are ratings *of a specific text*, so editing the row underneath them would leave the reputation pointing at something nobody endorsed. Customising is **load, edit, save under a new title**. A 409 now has exactly one resolution: a different title.

**Delete is admin-only.** Not creator-or-admin — once other people rely on a template, its author is not the person with the most at stake in removing it. Enforced in `routers/saved_prompts.py` off the `X-User-Is-Admin` header, which the BFF sets from `isAdmin()` in `lib/auth.ts` (same trust model as `/api/v1/admin/*`). Manage became **"Curate library (admin)"** and lists the whole library.

**Upvotes.** `saved_prompt_votes`, `PRIMARY KEY (prompt_id, user_email)` plus `ON CONFLICT DO NOTHING` — one-vote-per-user is enforced by Postgres, so two tabs still produce one vote. Un-voting is a DELETE, so the count is always the row count. `ON DELETE CASCADE` takes votes with a deleted template. The UI is optimistic and then overwritten by the server's authoritative count, rolling back on failure.

**Use counts.** `use_count` on `saved_prompts`, bumped by `POST /prompts/{id}/use` when a template loads into the prompt box. It deliberately does **not** touch `updated_at` — otherwise the most-used template would permanently also be the most recent, collapsing two sorts into one. Fire-and-forget from the client, since the insert already succeeded locally.

**Sorting** — Newest / Top rated / Most used, applied client-side (`sortSavedPrompts` in `lib/api.ts`) over one fetched payload, so switching is instant. Defaults to **Top rated**.

**Tooltips.** A collapsible `TipBanner` inside `SavedPromptsBar` states the five rules that are not guessable from the controls (one shared library, permanent titles, copy-on-load, votes-versus-uses, admin-only delete), plus `title=` on every control: picker, each sort button, the vote button (state-aware, with the live count), the title field, Save, Curate, and each Delete. The delete confirm recites the template's votes and uses first. **If a rule changes, change the banner** — that copy is the spec users actually read.

**New endpoints:** `POST` / `DELETE /api/v1/prompts/{id}/vote`, `POST /api/v1/prompts/{id}/use`, with BFF proxies at `app/api/prompts/[id]/vote` and `app/api/prompts/[id]/use`.

## The thing still owed: a real end-to-end smoke test

Everything is verified by `tsc` / `next build` / lint / py-compile and by exercising the prompt-fragment builders directly. **Nobody has put a real photo through the pipeline in prod for any of this.** The API changes in particular are compile-verified only — there is no Python env on the dev machine, so the test suite has not been run.

Highest-value checks, in order:

1. **DIMENSIONS — the one I could not verify at all.** There is no Python environment on the dev machine (no `pyvips`, no `fastapi`) and no GCP credentials, so I could not run a batch or read output files. The crop maths is verified with PIL against six aspect ratios (1.40, 1.50, 4:3, portrait, square, already-standard) and lands exactly 2800x2000 in every case, but that is the ALGORITHM, not the pyvips implementation or the live pipeline. **Please run a batch including at least one non-7:5 source and check actual output dimensions at two points:** the enhanced asset in GCS, and the exported file. Both should read 2800x2000.
2. **Scan colour fix.** Re-scan the grey-to-orange Toyota pair. Expect two `wrong_colour` anomalies: `battery_compartment` and `tires`. Then run several correctly-enhanced images and confirm it stays quiet — the risk with this change is firing on every image, which is worse than the miss it fixes.
3. **Export → library.** Run a 2-provider batch, pick winners, export. Confirm the Photo Library shows the exported files AND the originals, exactly once each, and that a re-export updates that set instead of adding a duplicate.
4. **Shared templates — the highest-risk item in this batch, because it changes data that already exists.** In order: (a) **watch the migration** on the first API revision and confirm the API comes up at all — if two users had the same title, the de-dup `DO` block has to run before the new unique index builds; (b) confirm previously-private prompts are now visible to a SECOND user, with the right author name and date; (c) save a colliding title and confirm it is refused outright with no overwrite offered; (d) confirm there is no rename control anywhere; (e) upvote from two different accounts and confirm the count reads 2, then un-vote and confirm it reads 1; (f) load a template twice and confirm `use_count` climbs while its position in **Newest** does not move; (g) confirm a non-admin has no Curate control and that a direct `DELETE /api/prompts/{id}` from a non-admin session 403s.
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
- **Does the colour-phrasing sweep actually help?** Unmeasured, like everything
  else in this batch. It is a prompt change, so it needs a before/after on real
  images rather than a code review. Watch specifically for a faded unit coming
  back in its own colour instead of a brighter brand colour.
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

- **`AUTH_ENABLED=true`** in Vercel (Production) when ready — locks the app behind Microsoft SSO + activates the email allowlist. Confirm the allowlist first; test on Preview. Still inert; the workspace runs as `dev@local`. **Templates are credited to the signed-in email**, so anything saved while running as `dev@local` shows `dev@local` as its author — and since titles are permanent, those bylines cannot be corrected later.
- **`ADMIN_EMAILS` now gates template deletion**, not just the admin dashboard. Confirm the allowlist is who you want holding the only delete button for the shared library. (This is CleanShot's own `ADMIN_EMAILS` — a different list from the one in df-headshot-archive.)
- **Watch the first API revision after this push** — it runs the shared-templates migration (title de-dup, then the new unique index, then `use_count`, then `saved_prompt_votes`) on startup.
- `cleanshot-xai-key` (Grok) is dormant but the secret stays (one-line re-enable). `cleanshot-recraft-key` is still safe to delete.
- Domain onboarding is a **4-place checklist** (lesson #26): Vercel + `lib/auth.ts` trustedOrigins + Entra redirect URI + `infra/gcs-cors.json` (re-apply to BOTH buckets).

---

## Docs

- **CLAUDE.md** — rewritten this session. The three per-session log blocks were replaced by one durable "Enhance tab — current shape" section (keeping the findings that still constrain work), and the archived changelog was pruned. Authoritative.
- **README.md** — current-state note, "What It Does", "The Workflow", and the storage section match the app; the prompt-workflow step and the schema list were rewritten this session for shared templates.
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
