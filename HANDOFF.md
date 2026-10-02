# Session handoff — updated 2026-10-02

Resume notes for picking CleanShot back up in a new chat. **`CLAUDE.md` is the authoritative, continuously-updated project briefing** — read it first (esp. "Enhance tab — current shape"). This file is the "where we are right now / what's pending" snapshot.

---

## 2026-10-02 (last push of the day): nothing is held any more

- **Photoroom is the only background-removal engine, and Auto Crop is OFF by
  default.** Stephen asked for both on 2 Oct, after operators had been ticking
  Remove Background AND the Photoroom A/B toggle to get good cutouts (with
  only the first, the live code used fal). The 28 Aug held commit
  (`7bc4523`, earlier `802e1bc` / `421f166` / `a487aab`) shipped, with one
  reversal on top: its Auto Crop default-ON was turned back OFF in the UI
  (`DEFAULT_TOGGLES`) AND the API schema. The Photoroom toggle is hidden and
  ignored; `CUTOUT_ENGINE` (unset in Cloud Run, so `photoroom`) picks the
  engine, and erase/tweak re-mattes follow it too. Same push: its pricing rows
  (Gemini 3.1 $0.101, Photoroom $0.02 amortised), the 28 Aug docs commit, and
  the forklift-catalog seed for the Make/Model dropdowns.
- **There is no held commit now.** `main` and `origin/main` match; the
  replay-and-restack routine below is history.
- **The published Enhance-tab guide Artifact needs republishing** (Manual,
  Cab/Dual Drive, Make/Model dropdowns, one background toggle).

## 2026-10-01: export naming and ZIP auto-download

- **Export names** now come from one function, `build_export_name`
  (`apps/api/src/cleanshot_api/services/export_naming.py`, 98 unit tests in
  `tests/test_export_naming.py`). ZIP, Library folder and images are all
  `MAKE_YEAR_MODEL_TIRE-CAPACITY_FUEL`, images add `_NN.ext`. The provider
  suffix (`_Gemini`) is gone; the sequence number alone keeps names unique.
- **Blank fields are filled from the inventory CSV** only when every matching
  make + model row agrees. The CSV has no header and no tire column, so it can
  never supply a tire. **Two copies exist:** `reference/title-inference-csv.csv`
  (untracked, the operator's file) and `apps/api/src/cleanshot_api/data/`
  (the one the API reads; the Dockerfile ships only `src/`). Edit one, copy to
  the other.
- **The ZIP auto-downloads** when 7x5 EXPORT finishes. The Download ZIP button
  stays as the fallback. Not yet tested in a real browser.
- Not run: the DB-backed `test_api.py` (needs local Postgres).
- **Pushed alone as `2abf213` on 1 Oct.** The held Auto Crop + Photoroom commit
  was NOT released: local `main` was rebuilt as `2abf213` → `a487aab` (held,
  was `802e1bc`) → this docs commit (was `cfc0bb6`). So origin/main is now
  `2abf213`, not `dd2b8e7`, and the 28 Aug "live revision" line below is history.

## 2026-10-02: Color, dropdowns, equipment type

- **Color** is a new optional typed field (MetaCard + export form), the last
  part of the export name: `LIFT_HERO_2024_CPD70_P-15.5K_E_Luminous_Yellow`.
  New nullable `projects.color` column, added by `ADD COLUMN IF NOT EXISTS` at
  API startup. Either deploy order is safe: Pydantic ignores the unknown field
  on an old API, and an old row reads as no colour.
- **Year / Tire Type / Fuel Type are dropdowns**, and **equipment type is a
  grouped dropdown with an InfoTip** (`components/ui/`). Year still has no
  default. "Reach Truck" displays as "Stand-up Reach"; "Turret Truck (VNA)" is
  waiting on DF's own word.
- Verified by rendering the Enhance card on `next start` against a local mock
  FastAPI (no prod calls). The export form only renders with a picked winner,
  so it was typechecked, not rendered.
- **Shipped alone on 2 Oct (second push): Manual fuel + Dual Drive / Cab.**
  Fuel gains `M` (Manual), in BOTH vocabularies (`_FUEL_CODES` and
  `lib/equipment-fields.ts`). Two optional checkboxes in MetaCard and the
  export form go into the name before the fuel, Dual Drive first:
  `..._P-5K_DUAL_DRIVE_CAB_E_Luminous_Yellow`; unticked, names are unchanged.
  New `projects.dual_drive` / `projects.cab` (`BOOLEAN NOT NULL DEFAULT
  FALSE`). Out of scope on purpose: renaming anything that exists, parsing old
  folder names, and any lift-type code. **The published Enhance-tab guide
  Artifact needs republishing.**
- **Same push: Make / Model dropdowns + the known-models list.**
  New `known_models` table (seeded at API start from the inventory CSV, 34
  pairs, and, from the next push, the forklift catalog: 1,144 pairs in all), `GET /api/v1/known-models`, admin `GET/PATCH
  /api/v1/admin/known-models`, and a **Makes & Models** admin tab to fix
  spelling or hide. "Other…" pairs are added at project save. Picking fills
  nothing else (Stephen's call). Verified: Enhance card rendered against a
  mock API; the SQL paths and admin endpoints against a real throwaway
  Postgres (pgserver). NOT rendered locally: the admin tab (no local admin
  session is possible) and the export form (needs a picked winner).
- **Forklift catalog feeds the dropdowns (2 Oct, third push).** Stephen's
  `forklift_catalog.csv` (repo root, gitignored: it carries D: paths) is cut
  down by `scripts/build_catalog_models.py` to Make,Model only in
  `apps/api/src/cleanshot_api/data/known_models_catalog.csv` (1,132 pairs, 87
  makes). Underscores become spaces; 35 folder-name leftovers are skipped
  and printed (Hyster NO_MODEL/DIESEL/CUSHION/C, tire letters glued on like
  Octane FD25_P, MODEX and CRASHCHAMPIONS tags, makes "Un" and "Vegas Media",
  one Genie filed under Gehl). Seeded as source 'inventory' (the CHECK allows
  only that and 'operator'); the admin tab now labels it "Starting list".
  The seed is one `unnest` INSERT now (7 ms on a re-run). Re-run the script
  whenever Stephen drops a new catalog.
- **Color shipped alone earlier on 2 Oct as `94dd762`.** Until the last push of
  the day, each push replayed new work onto origin/main and re-stacked the held
  Auto Crop + Photoroom commit and its docs commit on top. Both are released
  now (see the top of this file).

---

## ⚠️ 2026-08-28 — read this first

**(2 Oct: the held commit below has since shipped, with Auto Crop left OFF by
default. Read the top of this file.)** Everything below is pushed and deployed EXCEPT one held commit. That reverses
the 27 Aug warning this file used to open with; the branch is `main`, it is
current with the remote, and the API has served real batches all day.

- **Live API revision: `cleanshot-api-00178-jhr`**, running commit `dd2b8e7`
  (HEIC ingest), at `cpu=2 / memory=4Gi`.
- **HELD, NOT PUSHED — `a487aab`** (was `802e1bc`, then `421f166`; re-IDed by the 1 and 2 Oct reorders) "Auto Crop on by default, and Photoroom as the
  only cutout engine". Committed locally at the operator's instruction. It also
  carries the corrected pricing rows. **Pushing it deploys both API and web.**
- Today's pushed run, oldest first: `d0cf4b0` → `25837ee` → `acdc2e2` → `4040563`
  (Grok dormant again) → `9969b0a` → `c67a6c7` (fal matting) → `c953dbc` →
  `835cf58` → `7db1700` → `e3615f0` → `4dc558d` → `e4f4731` → `ad540ef` →
  `dd2b8e7`.

### What today actually changed, in dependency order

1. **Matting moved to a vendor, then to a different vendor.** fal BiRefNet v2
   replaced the in-container ONNX model, and then Photoroom replaced *it* in the
   held commit. BiRefNet is a SALIENT OBJECT detector — the first production
   cutouts kept a potted plant and a "Discount Forklift" wall banner alongside
   the machine. `CUTOUT_ENGINE` (default `photoroom`) is now the single place the
   vendor is chosen; `CUTOUT_ENGINE=fal` is a full rollback with no code change.
2. **Two fixes for the distractors, split by what each can reach.** Physical
   objects come out of the MASK (`_isolate_principal_subject`); printed signage
   comes out of the PIXELS, because a banner measured ~36% of the machine's
   masked area and no island filter can drop something that size without also
   being able to amputate a split machine.
3. **The "blurry / JPEG-artifacted" complaint was never fal.** Nothing had ever
   set Gemini's `image_config`, so every stored asset was a **x2.32 lanczos
   upscale of a 1 MP generation**. `GEMINI_IMAGE_SIZE=2K` takes that to x1.16.
   The busy background had always hidden it; the cutout removed the camouflage.
4. **That OOM'd the container within 16 minutes** — 1 GiB was never sized for
   ten concurrent inline jobs. Now `cpu=2 / memory=4Gi`, plus the fal upload
   dropped from a 7 MB PNG to a 0.71 MB JPEG.
5. **Auto Crop**, ported from df-auto-edit rather than reinvented, and **HEIC
   ingest**, decoded in the browser because `createImageBitmap` cannot read it
   in Chrome or Firefox.

### Two regressions I shipped and fixed the same day

Both are written up in CLAUDE.md because the mistakes generalise:

- **The island filter crashed every cutout job** (`unable to call getpoint`).
  `hist_find` on a ushort image sizes the histogram to `max value + 1`, not a
  fixed 65536, and `labelregions` numbers background regions too — so the
  histogram can be shorter than the label range. Six hand-built tests all passed;
  **sweeping island counts 0→312 is the test that would have caught it.**
- **The 2K change OOM-killed the container.** I predicted the ceiling would bite
  at 4K and was wrong about the margin, because I counted only the decoded image
  and not the pipeline's transient buffers.

The shared lesson, and the reason both were caught quickly: **every one of
today's diagnoses came from a log line or a measurement, and the wrong guesses
(fal degrading the image, a fal concurrency limit, a 10-image cap) all came from
reasoning.** The `sizing:` and `cutout:` log lines added today are what made the
difference — keep them.

### The one thing that is broken right now

**The per-image Retry button silently drops every toggle**, so a retry produces
no cutout (and no crop, if Auto Crop was ticked). It is not a plumbing
bug — the batch auto-reset wipes toggles before a Retry button is even
clickable. Diagnosed, unfixed, and the recommended fix (a per-batch toggle
snapshot that Retry reuses) is in CLAUDE.md. **This is the first thing to pick
up.**

---

## Repo state

- **Branch:** `main`. Direct-to-main is the norm (no PR review).
- ⚠️ **STALE FROM HERE DOWN — this section and the ones after it describe the
  2026-08-26/27 batches.** For current state read the 2026-08-28 section at the
  top of this file: head is `dd2b8e7` pushed (`a487aab` held locally, was `802e1bc`), and the
  API is on `cleanshot-api-00178-jhr`. The revision and commit named just below
  are historical, kept because the reasoning around them is still useful.
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

---

## Also in flight: total background removal (`transparentBackground`)

A fifth Enhance toggle that cuts the unit out to a real transparent PNG for the
new-equipment site.

- **It is a matting pass, not a prompt.** `services/cutout.py` runs after
  `upscale_to_standard` over the finished pixels and only computes alpha. Asking
  an image model for "a transparent background" would re-draw the machine and
  make it guess where the mast lattice ends — see the durable findings.
- **The matting engine is fal.ai `fal-ai/birefnet/v2` as of 2026-08-28.** It
  was in-container (`rembg` + `onnxruntime`, `isnet-general-use` prefetched
  into `/opt/rembg-models`) from 2026-08-26 until then. In-container had been
  chosen over a cutout vendor precisely to avoid a new secret, a new rate
  limiter, per-image spend on a bulk workflow, and one more vendor that can
  429 mid-batch — the operator reversed that call. `rembg`, `onnxruntime` and
  the baked model are gone, and they were most of the image weight.
- **We ask fal for the MASK and composite locally**, we do not take its
  finished cutout. Accepting the vendor's composite would mean accepting its
  re-encode on pixels the operator already approved, which discards the
  "RGB is never regenerated" property that is the whole reason this is a
  matting pass. `mask_image` is read in preference to `image` because
  `image` is only the mask if fal honoured `mask_only` — if it did not,
  using its red channel as alpha is nonsense rather than an error.
- **fal's 2048 is `operating_resolution`, not an input cap**, so the
  2800x2000 standard did NOT change. `CUTOUT_MAX_UPLOAD_LONG_EDGE_PX` is a
  per-vendor transport cap only, same shape as `OPENAI_MAX_LONG_EDGE_PX`.
  Worth knowing this is an upgrade: `isnet-general-use` computed at
  1024x1024 internally and upscaled, so the old engine put a 1024-derived
  alpha onto a 2800x2000 image.
- ⚠️ **UNVERIFIED against a real cutout.** pyvips is not installed on the dev
  machine, so `_composite_alpha` has never run, and the mask polarity
  (white = foreground) is assumed from convention. An inverted mask is loud,
  not silent — the machine would vanish and the backdrop would remain.
- ⚠️ **`libglib2.0-0` and `libgomp1` MUST STAY in the Dockerfile.** Their old
  comment credited them to opencv/onnxruntime arriving via rembg, which now
  reads as licence to delete them. libvips is built on GLib and pyvips is the
  entire image pipeline; dropping libglib fails at IMPORT and the whole API
  stops booting.
- **Export changes shape for these images**: PNG, no disclaimer watermark,
  driven by `img.hasalpha()` in `export_pro` rather than by a request flag.
  `_ext_for()` keeps filenames, GCS content-types and ZIP entries in step.
- **Alpha now survives `apply_adjustments`** (it was being dropped outright, so
  a contrast tweak on a cutout returned an opaque image), and the per-variant
  erase/tweak tools re-matte when the variant they edit already had alpha.
- **The operating cost moved from CPU to spend and latency.** No model loads
  on the instance any more, so cold start got materially lighter; instead
  every cutout is a paid fal call inside the enhance request. `fal_rate_limiter`
  (8 per 10s) is a defensive guess and matters more than the other limiters,
  because a 429 fails the whole job rather than degrading — a cutout must
  never come back opaque.
- **`cleanshot-fal-key` is required for the API to DEPLOY**, not just to
  matte: `deploy-api.yml` mounts it via `--set-secrets` and `gcloud run
  deploy` fails outright on a missing secret. It exists as of 2026-08-28 —
  revision `cleanshot-api-00170-64w` deployed clean, which also proves the
  service account can read it.

---

---

## 2026-08-26 session: what shipped, and four findings worth more than the code

### Shipped

- **Total background removal** (`transparentBackground`) — transparent-PNG cutout via in-container matting. The risky part (a Docker image with ~500 MB of new deps plus a baked ONNX model) **built and booted cleanly**, which was most of the risk. The matting itself has still never actually run — the model loads on the first cutout request.
- **Bright-blue template picker** — a third documented palette exception. Fill is `#0A84FF` with **near-black** text, not white: white measures 3.65:1 and fails AA at body size, near-black is 5.09:1. As *text* on a dark surface the blue is lightened to `#5AB0FF` (the plain blue is 3.83:1 there). Fill and text need different values — the same trap the CTA purples have.
- **Both providers selected by default** — reverses open item #11, which is now marked as decided-the-other-way with the reasoning attached rather than deleted. Two costs accepted: the best-of-N judge now fires on every batch (unlogged, unlimited), and wall-clock is set by OpenAI at ~75s.
- **Template body cap 8000 → 32000**, plus readable 422s. See finding 2.
- **`PROMPT-HYSTER.md`** — the operator's Hyster prompt rebuilt for this environment, ~9,700 chars → ~1,400, in two variants. **`TEMPLATES-HOWTO.md`** — operator how-to for the template library, also published as a shareable page.
- **Cutout env vars added to the workflow's `--set-env-vars`** list, without which setting `CUTOUT_MODEL` by hand would revert on the next deploy (lesson #1).

### Finding 1 — how a custom prompt and the toggles combine (the important one)

Documented in full in CLAUDE.md under the Enhance section. Three mechanics that
compound: a custom prompt **skips** the built-in prompt blocks (`if
spine_override is None:`) while toggle `extras` have no such guard; toggle
fragments land **after** the operator's text under "apply ON TOP of the spine
above", so a toggle outranks the prompt on any shared subject.

A third mechanic used to compound this — the differential scanner received
only the operator's first 1,500 characters as intended edits — but that cap
was **removed 2026-08-27** and the full prompt is now passed. Decal preservation,
the other standing example of the prompt-first trap, became a GUARDRAILS bullet
on the same date and is now appended on every path.

Together they produce a defect an operator can create by following the UI
correctly: a careful non-marking-tyre exception in the prompt, plus a ticked
**Shine Tires**, yields white tyres painted black — the one thing the rubric
says nothing can authorise. **This was found by auditing a prompt rewrite, not
by a bug report, and it had already caused me to give one piece of wrong
advice.** Anyone touching prompts should read that CLAUDE.md section first.

### Finding 2 — the 8000-char cap was protecting nothing

A real ~9.7k production prompt could not be saved. `EnhanceRequest.custom_prompt`
has no `max_length` at all, so that prompt already *enhanced* fine — the cap only
blocked *saving* it, which is the worst possible split. Now 32000, still bounded
only because `GET /prompts` ships every body.

The same 422 exposed a second bug: FastAPI puts validation `detail` in a **list**
of objects whose `input` field contains the entire rejected payload, so a
string-only error renderer dumped the operator's whole prompt into the UI. Now
hard-won lesson #27.

### Finding 3 — three per-variant tools are dead-but-wired

`VariantThumb` renders only **↻ Retry** and **✎ Tweak (Gemini)**. **Ideogram
Edit and Ideogram Inpaint** have intact backends, schemas, workers, task
routing, usage attribution and mounted dialogs — and no button. (Flux Erase
was a third such tool until 2026-08-27; it was deleted with BFL rather than
left parked, which is why removing it cost no working functionality.)
CLAUDE.md's "five small icons" table described the design, not the app, and has
been corrected. This is now prioritised open work item #16, because Ideogram Edit
is specifically the tool for decal typography and model-number restoration, so
that work currently routes through Gemini, which is weaker at embedded text.

Also corrected: CLAUDE.md claimed `shine_tires` was on by default. It is not —
`DEFAULT_TOGGLES` and the Pydantic model both default it `false`.

### Finding 4 — CI signals here are actively misleading

Both traps are now hard-won lesson #28.

- **`deploy-web.yml` is manual-only** and has been permanently red since
  2026-06-05 at a `pnpm audit` step it never gets past. **Web deploys go through
  Vercel's own Git integration**, so a web change ships with **zero** Actions
  runs. CLAUDE.md's deploy-pipelines section claimed the opposite (and named a
  wrapper action that lesson #22 already says was dropped); fixed.
- **`gh run list` returned stale results** while a run was in flight, showing no
  runs at all for two consecutive pushes. That produced a confident wrong
  diagnosis ("Actions is not firing") and nearly a pointless manual dispatch,
  when the deploy had in fact succeeded. Check the deployed thing, not the CI
  listing.

### Still unverified from this session

Everything is compile-verified and the deploys are green, but **no real photo has
gone through any of it**. Highest value first: the cutout on a real unit (see the
checklist below), then the Hyster prompt A/B against the old one, then the
template flow with two accounts.

---

## The thing still owed: a real end-to-end smoke test

Everything is verified by `tsc` / `next build` / lint / py-compile and by exercising the prompt-fragment builders directly. **Nobody has put a real photo through the pipeline in prod for any of this.** The API changes in particular are compile-verified only — there is no Python env on the dev machine, so the test suite has not been run.

Highest-value checks, in order:

1. **DIMENSIONS — the one I could not verify at all.** There is no Python environment on the dev machine (no `pyvips`, no `fastapi`) and no GCP credentials, so I could not run a batch or read output files. The crop maths is verified with PIL against six aspect ratios (1.40, 1.50, 4:3, portrait, square, already-standard) and lands exactly 2800x2000 in every case, but that is the ALGORITHM, not the pyvips implementation or the live pipeline. **Please run a batch including at least one non-7:5 source and check actual output dimensions at two points:** the enhanced asset in GCS, and the exported file. Both should read 2800x2000.
2. **Scan colour fix.** Re-scan the grey-to-orange Toyota pair. Expect two `wrong_colour` anomalies: `battery_compartment` and `tires`. Then run several correctly-enhanced images and confirm it stays quiet — the risk with this change is firing on every image, which is worse than the miss it fixes.
3. **Export → library.** Run a 2-provider batch, pick winners, export. Confirm the Photo Library shows the exported files AND the originals, exactly once each, and that a re-export updates that set instead of adding a duplicate.
4. **Shared templates — the highest-risk item in this batch, because it changes data that already exists.** In order: (a) **watch the migration** on the first API revision and confirm the API comes up at all — if two users had the same title, the de-dup `DO` block has to run before the new unique index builds; (b) confirm previously-private prompts are now visible to a SECOND user, with the right author name and date; (c) save a colliding title and confirm it is refused outright with no overwrite offered; (d) confirm there is no rename control anywhere; (e) upvote from two different accounts and confirm the count reads 2, then un-vote and confirm it reads 1; (f) load a template twice and confirm `use_count` climbs while its position in **Newest** does not move; (g) confirm a non-admin has no Curate control and that a direct `DELETE /api/prompts/{id}` from a non-admin session 403s.
5. **Inline scan.** Confirm verdicts appear per variant and that a single failed scan marks only its own image.
6. **Fork conditionals.** Off by default. Turn on, tick both controls on one image, retry, and check the output stops inventing a shank / shortening the forks. Then turn the switch off and confirm the prompt goes back to exactly what it was.
7. **The cutout toggle, end to end.** In order: (a) confirm the **API image
   builds and the revision comes up at all** — that is most of the risk; (b) run
   one batch with the toggle on and open the exported file, expecting a `.png`
   with genuine transparency and **no watermark**; (c) look hard at the mast
   lattice, fork gaps, and under the overhead guard, which is where matting
   either earns its place or does not; (d) apply a contrast tweak to a cutout
   variant and confirm it is still transparent afterwards; (e) run a Tweak or
   Erase on a cutout and confirm it comes back transparent rather than black;
   (f) confirm the differential scan does not flag the removed background. If
   the edges disappoint, the first lever is `CUTOUT_MODEL=birefnet-general`
   plus the matching Dockerfile prefetch line — not a prompt change.
8. **Default-path prompt drift.** The fork block was split from one paragraph into sentences. The "both visible" case is meant to be semantically identical — worth a side-by-side on a few images before trusting it on a real batch, given this repo's history with prompt changes.

---

## Open questions

- **Do cutout edges hold up on warehouse-electric gear?** Reach trucks and
  order pickers are mostly thin mast structure, which is the hardest case for
  matting as much as for generation. Unmeasured. `birefnet-general` is the
  escalation, at roughly 3x the model size.
- **Should cutouts be trimmed to the subject?** They are left at 2800x2000 with
  the unit in its original position, so a product page gets whitespace it has
  to crop itself. Trimming to the alpha bounding box is a few lines, but it
  breaks the "every output is exactly 2800x2000" guarantee, which is worth more
  than the convenience. Not done, deliberately.
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

1. **Judge follow-ups:** log the judge's Claude spend to `usage_events` (needs `OperationEnum.judge` + `ALTER TYPE`, lesson #12); add an `AsyncRateLimiter` on the judge's Anthropic calls (shares scan's `claude-opus-5` tier; the prompt optimizer added 2026-08-27 is a
second unlogged, unlimited Anthropic call on the same footing).
2. **Prompt-first Phase 2 — iterative refinement.** "Change it more without starting over." The per-variant **Tweak** tool already does text-guided refinement — surface/rename it rather than building new.
3. **Model-routing for hard equipment types.** Prompt wording is a DEAD lever for warehouse-electric gear (reach / order-picker / walkie / pallet) — Gemini drifts regardless. The real levers are best-of-N (shipped, extend it) or routing those types elsewhere.
4. **Per-user access control — Phase 2 (admin audit logging).** Still unbuilt. NOTE: `access-control.ts` is currently **defanged** (`USER_RESTRICTIONS = {}`); rebuild it if per-user gating is wanted again.
5. **Extract `_load_image_bytes`** to `services/gcs.download_image` — triplicated across the workers (TODO marker in code).

---

## Pending OPERATOR steps (dashboards / gcloud / env — not code)

- **`AUTH_ENABLED=true`** in Vercel (Production) when ready — locks the app behind Microsoft SSO + activates the email allowlist. Confirm the allowlist first; test on Preview. Still inert; the workspace runs as `dev@local`. **Templates are credited to the signed-in email**, so anything saved while running as `dev@local` shows `dev@local` as its author — and since titles are permanent, those bylines cannot be corrected later.
- **`ADMIN_EMAILS` now gates template deletion**, not just the admin dashboard. Confirm the allowlist is who you want holding the only delete button for the shared library. (This is CleanShot's own `ADMIN_EMAILS` — a different list from the one in df-headshot-archive.)
- **Watch the first API revision after this push** — it runs the shared-templates migration (title de-dup, then the new unique index, then `use_count`, then `saved_prompt_votes`) on startup.
- `cleanshot-xai-key` (Grok) is **live again as of 2026-08-27** and the operator confirms the key value is still good. Safe to delete: `cleanshot-recraft-key`, and after the next deploy `cleanshot-bfl-key`, `cleanshot-reve-key` and `cleanshot-runcomfy-key`.
- Domain onboarding is a **4-place checklist** (lesson #26): Vercel + `lib/auth.ts` trustedOrigins + Entra redirect URI + `infra/gcs-cors.json` (re-apply to BOTH buckets).

---

## Docs

- **CLAUDE.md** — rewritten this session. The three per-session log blocks were replaced by one durable "Enhance tab — current shape" section (keeping the findings that still constrain work), and the archived changelog was pruned. Authoritative.
- **README.md** — current-state note, "What It Does", "The Workflow", and the storage section match the app; the prompt-workflow step and the schema list were rewritten this session for shared templates.
- **PROMPT-HYSTER.md** — NEW. The operator-facing Hyster prompt plus the
  prompt/toggle precedence rules. This is the doc to hand someone who is about to
  write a prompt for this app.
- **TEMPLATES-HOWTO.md** — NEW. A short operator-facing how-to for the shared
  template library (use / save / customise / rate / delete, plus a quick-answers
  table). Also published as a shareable Artifact for the team. If a template
  rule changes, this and the in-app `TipBanner` are the two places users read.
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
