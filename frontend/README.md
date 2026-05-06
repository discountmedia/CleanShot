# CleanShot — `apps/web`

CleanShot frontend, scaffolded against the **Phase 2 v2.4.1** backend (Gemini 3 Pro Image / Flash 3 cutover) and the **Phase 3 cutover decisions** (Next.js + App Router replacing Vite).

## Stack

| | |
|---|---|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript 5.6, strict mode |
| UI | React 19 + Tailwind CSS 3.4 |
| State | Zustand 5 |
| Upload | react-dropzone → V4 signed PUT URL → direct GCS |
| Progress | `setInterval` polling on `/api/v1/jobs/{id}` every 2s |
| Auth | `NEXT_PUBLIC_API_KEY` injected into bundle + origin pinning server-side |
| Hosting | Vercel Pro (full Next.js runtime, **not** `output: 'export'`) |

## Routing topology

```
/             → Enhance (default tab)
/scan         → Scan (triple-provider voting display)
/resize       → Resize (marketplace presets + format)
/jobs/[id]    → Shareable job permalink for any operation
```

All four pages live under a shared root layout (`app/layout.tsx`) which renders the brand strip, `<TabNav>`, and footer. The layout is a Server Component; everything below it is `"use client"`.

## Server vs Client component split

| Server Component | Client Component |
|---|---|
| `app/layout.tsx` | `app/providers.tsx` |
| | `app/page.tsx` (Enhance) |
| | `app/scan/page.tsx` |
| | `app/resize/page.tsx` |
| | `app/jobs/[id]/page.tsx` |
| | All `components/*.tsx` |

The split is mechanical: anything that uses `useState`, `useEffect`, `useStore`, or browser APIs (XHR for uploads, `EventSource` if it's ever added) gets `"use client"`. The root layout stays a Server Component to keep bundle size honest and metadata server-rendered.

## Environment variables

Two vars, both `NEXT_PUBLIC_*` (baked into the bundle by design — see `.env.example` for the rationale).

| Variable | Production | Preview | Development |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.cleanshot.app` | `https://staging-api.cleanshot.app` | `http://localhost:8000` |
| `NEXT_PUBLIC_API_KEY` | (prod key from Secret Manager) | (staging key) | `local-dev-key` |

Set them in `.env.local` for development and in Vercel project settings per environment for deploys.

## Running locally

```bash
# from monorepo root
pnpm install
pnpm --filter @cleanshot/web dev
# or, from apps/web/
pnpm dev
```

Visit `http://localhost:3000`. The app expects a Phase 2 v2.4.1 backend running at `NEXT_PUBLIC_API_URL` — without it, `createSession` will fail in the providers and the upload zone will surface the error.

## Building for Vercel

```bash
pnpm --filter @cleanshot/web build
```

Vercel project settings:

- **Framework Preset**: Next.js (auto-detected)
- **Root Directory**: `apps/web`
- **Build Command**: `pnpm build` (default)
- **Install Command**: `pnpm install --frozen-lockfile`
- **Node.js Version**: 20.x or 22.x
- **Output**: `.next/` (auto, do not configure)

No `vercel.json` needed — App Router handles deep links natively. The Phase 3 v3.4 SPA rewrite rule (`/(.*) → /index.html`) is obsolete.

## What's implemented

### Fully wired

- Session bootstrap (lazy on first mount)
- Direct-to-GCS upload with progress
- 2s polling against `/api/v1/jobs/{id}`
- Enhance: brand-rule toggles (apply_fork_paint, apply_tire_shine, apply_rust_removal), intensity (light/moderate/heavy), resolution (1K/2K), extra instructions, submit, progress, result with `<ModelBadge>` for Pro/Flash 2.5 fallback distinction
- Scan: submit + poll + result envelope with verdict pill, agreement badge, 12-check grid (per Phase 2 § 2.4 schema)
- Resize: submit + poll + result URI display
- Permalink page (`/jobs/[id]`)
- Cross-tab deep link: Enhance result → "Scan this image" → `/scan?asset=...`

### Stubbed (works but UI not finalized)

- Scan visual polish — confidence bar that drops on disagreement, per-provider attribution display, dissenting-note presentation. The data model is correct; the styling pass lives in the Phase 3 v3.5 doc.
- Resize advanced controls — custom dimensions, ΔE color tolerance, naming-token export. The MVP preset list works; full controls come with v3.5.
- Batch download (multi-asset ZIP) — `lib/api.ts#downloadZip` exists, no UI surface yet.
- Toast/error region — currently inline per-form errors only.

### Deferred (Phase 3.5 or later)

- Server-side proxy auth (`app/api/proxy/[...path]/route.ts`) to remove the API key from the bundle. Per cutover decision D, deferred to coincide with real auth (Auth0/Clerk/WorkOS).
- SWR or TanStack Query — keeping `setInterval` + native `fetch` for v1.
- next/image for previews — using plain `<img>` tags against signed GCS URLs because preview URLs rotate every 15 minutes and Vercel's image proxy adds a round-trip we don't need for already-optimized derivatives.

## File map

```
apps/web/
├── app/
│   ├── layout.tsx           # Server Component — brand strip, TabNav, footer
│   ├── providers.tsx        # Client boundary — session bootstrap
│   ├── globals.css          # Tailwind directives + base styles
│   ├── page.tsx             # Enhance tab (default)
│   ├── scan/page.tsx        # Scan tab
│   ├── resize/page.tsx      # Resize tab
│   └── jobs/[id]/page.tsx   # Shareable job permalink
├── components/
│   ├── TabNav.tsx           # Top-nav active tab via usePathname
│   ├── UploadZone.tsx       # react-dropzone + direct GCS upload
│   ├── JobProgress.tsx      # Progress bar + status + message
│   ├── ModelBadge.tsx       # Pro vs Flash 2.5 fallback indicator
│   ├── EnhanceForm.tsx      # Brand toggles + intensity + extra
│   └── EnhanceResult.tsx    # Final image + download + scan link
├── lib/
│   ├── api.ts               # fetch wrapper, all endpoints
│   ├── store.ts             # Zustand: session, assets, active, jobs
│   ├── types.ts             # Mirrors Phase 2 v2.4.1 backend schema
│   ├── upload.ts            # XHR PUT with progress
│   ├── usePolling.ts        # 2s job polling hook
│   └── utils.ts             # sanitizeFilename, formatBytes, cx
├── .env.example
├── .gitignore
├── eslint.config.mjs        # Flat config, Next 15 + TypeScript
├── next.config.ts
├── package.json
├── postcss.config.mjs
├── tailwind.config.ts
└── tsconfig.json
```

## Notes for future work

1. **Replace `lib/types.ts` with codegen** from the FastAPI OpenAPI schema once `packages/api-types` lands per Phase 4 v4.2. The hand-written types in this scaffold are correct against v2.4.1 but will drift if the backend ships ahead of the frontend.

2. **The `<ModelBadge>` is load-bearing** in the Enhance result UI. When Pro Image gets sunset and the worker falls back to gemini-2.5-flash-image (per Phase 2 v2.4.1 § 1.5), users should see the badge change. If you simplify this away, you also need to remove the fallback path in the worker — the two pieces are paired.

3. **Job idempotency hash** is computed server-side in the worker, not here. Brand toggle states, intensity, resolution, and `model_used` are all part of the hash. Different toggle states on the same asset → different `job_id` → separate cached results. The frontend can submit freely without worrying about cache poisoning.

4. **Polling interval is 2s, fixed.** Don't introduce exponential backoff or per-operation cadence variation. v3.4 explicitly tested 2s as the right cadence — it shows progress without hammering, and Scan jobs (10–25s) finish in 5–12 polls.

5. **Tab state is route state, not store state.** `<TabNav>` reads `usePathname()` and Zustand only tracks per-tab data. This is the cutover decision B (split tabs into routes) showing up in the UI layer — don't add a `selectedTab` field to the store.
