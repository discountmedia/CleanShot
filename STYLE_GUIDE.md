# CleanShot — UI Style Guide

Canonical reference for the CleanShot web app's visual system. Established during the 2026-05-27 UI consistency pass. **When adding any new UI element, conform to this document.** If a need arises that this guide doesn't cover, extend the guide in the same PR rather than inventing a one-off.

Stack: Next.js 16 App Router · React 19 · Tailwind v4 (`@theme` tokens, no `tailwind.config.js`) · dark theme only.

---

## 1. Colors

### Brand / surface

| Purpose | Tailwind | Hex | Notes |
|---|---|---|---|
| App background | `bg-black` | `#000000` | Every page + panel base |
| Brand accent (borders, header rule) | `red-600` | `#dc2626` | The Discount Forklift brand red — header underline, active-tab marker |
| Card surface | `bg-zinc-900` | `#18181b` | Standard container fill |
| Card border | `border-zinc-800` | `#27272a` | Standard container border |
| Muted card border | `border-zinc-700` | `#3f3f46` | Inputs, secondary borders |
| Body text | `text-zinc-100 / zinc-200 / zinc-300` | — | Primary → secondary → tertiary |
| Dim text | `text-zinc-500` | `#71717a` | Captions, metadata |

### Semantic button colors (STRICT — see §3)

| Meaning | Tailwind fill | Hex |
|---|---|---|
| 🟢 Approve / proceed / commit | `bg-green-600` (border `green-500`) | `#16a34a` |
| 🔵 Skip next step / utility | `bg-blue-600` (border `blue-500`) | `#2563eb` |
| 🔴 Cancel / clear / start over | `bg-red-600` (border `red-500`) | `#dc2626` |
| Disabled | `bg-zinc-800 text-zinc-500` | — |

### Accent colors (non-button)

| Purpose | Tailwind | Hex | Notes |
|---|---|---|---|
| Hyperlinks / inline CTAs | `sky-400` (hover `sky-300`) | `#38bdf8` | **Always bold.** Set globally in `globals.css` base layer; see §4 |
| Field hints / "fill this in" guidance | `yellow-300` | `#fde047` | The ONE yellow. Matches AI-provider card text. Never use `yellow-200` |
| Info tooltip (blue accordion) | `blue-*` family | — | `border-blue-900 bg-blue-950/30`, icon `blue-300`, title `blue-100` |
| Warning tooltip (amber) | `amber-*` family | — | `border-amber-900 bg-amber-950/30` — reserve for genuine gotchas |
| Beta banner | `amber-*` | — | `bg-amber-950/40 border-amber-900`, text `amber-100`, badge `amber-300` |

### Provider chip colors (Enhance tab, per-model identity — leave as-is)

`gemini` blue · `openai` green · `grok` orange · `kontext` purple · `ideogram` cyan · `reve` fuchsia. These are intentional per-provider identities, exempt from the semantic button system.

### Rules

- **No new accent colors.** If you need an accent, it's one of: brand red, sky (links), yellow-300 (hints), or a semantic button color.
- The deprecated one-offs removed in this pass — `sky-400`/`fuchsia-400` section headings, `purple-600` collage button, `emerald` collage box — **do not reintroduce**. Headings are `text-white`; export/commit buttons are green.

---

## 2. Containers / boxes

| Element | Classes |
|---|---|
| Standard card | `rounded-xl border border-zinc-800 bg-zinc-900 p-4` (or `p-5` for roomy) |
| Tooltip accordion | `rounded-xl border border-blue-900 bg-blue-950/30 px-5 py-4` (see §6) |
| Drag-and-drop zone | `relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors` — idle `border-zinc-600 hover:border-blue-500 hover:bg-blue-950/20`; dragging `border-blue-500 bg-blue-950/20`; disabled `border-zinc-700 opacity-50 cursor-not-allowed`. **This is the canonical uploader — identical on every tab (Scan is the reference).** |
| Success card | `rounded-xl border-2 border-green-600 bg-green-950/50 px-5 py-4` |
| Error card | `border border-red-800 bg-red-950/40 rounded-lg px-4 py-3 text-red-300` |
| Radius scale | cards `rounded-xl`; buttons/inputs `rounded-lg`; pills/badges `rounded` |

No drop shadows on flat cards. Shadows (`shadow-lg shadow-*-900/40`) were removed from buttons in this pass — keep buttons flat.

---

## 3. Buttons

**Two hard rules:**

1. **Never full-width.** Buttons are `inline-flex` / auto-width. No `w-full` on `<button>`. Group multiple buttons with `flex flex-wrap gap-3`.
2. **Color = meaning** (§1). Green = proceed/approve/commit · Blue = skip/utility · Red = cancel/clear/start-over.

### Canonical button class

```
inline-flex py-3 px-6 rounded-lg font-bold text-base uppercase tracking-[0.12em] border-2 transition-colors
```

Then per semantic:

| Semantic | State classes |
|---|---|
| Green | `border-green-500 bg-green-600 hover:bg-green-500 text-white` |
| Blue | `border-blue-500 bg-blue-600 hover:bg-blue-500 text-white` |
| Red | `border-red-500 bg-red-600 hover:bg-red-500 text-white` |
| Disabled | `border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed` |

### Bottom action row pattern (per tab)

When a tab has flow actions, place them in a bottom row in this order: **🟢 Proceed · 🔵 Skip · 🔴 Clear All**. Reference implementation: Modify tab.

---

## 4. Links / CTAs

- **Global default** (`globals.css` base layer): `a { font-weight: 700; color: #38bdf8 }`, hover `#7dd3fc` + underline.
- Any link with no explicit color class lands on sky-400 automatically. Tailwind `text-*` utilities still override when a link genuinely needs a different color (rare).
- Inline text CTAs (e.g. "Send a support ticket") follow the same: bold sky-400.
- **Don't** style a link to look like a filled button unless it's an actual navigation action that belongs in the button system.

---

## 5. Typography

| Element | Classes |
|---|---|
| Brand mark ("CleanShot") | `text-3xl font-extrabold tracking-[0.14em] text-white uppercase` |
| Section heading (h3) | `text-base–text-xl font-bold/extrabold text-white uppercase tracking-[0.12em–0.14em]` |
| Tooltip title | `text-base font-semibold uppercase tracking-[0.12em]` (tone-colored) |
| Body | `text-sm–text-base text-zinc-200 leading-relaxed` |
| Field hint | `text-base text-yellow-300 font-semibold leading-relaxed` |
| Caption / meta | `text-xs–text-sm text-zinc-500` |
| Mono (filenames, sizes) | `font-mono tabular-nums` |
| Beta banner | badge `text-sm`, message `text-base sm:text-lg` |

Fonts: `--font-sans: Inter`, `--font-mono: JetBrains Mono` (tokens in `globals.css`).

---

## 6. Components

### Tooltip accordion (`TipBanner`)

`apps/web/components/workspace/TipBanner.tsx`. Collapsible by default (`collapsible` prop, defaults true). The title row is a toggle button with a chevron; body + steps collapse.

**Default open/closed is visit-count driven** via `apps/web/lib/useVisitCount.ts`:
- Visits 1–4 → expanded (operator still learning)
- Visit 5+ → collapsed (operator knows the tool)
- Counter is `localStorage["cleanshot_visit_count"]`, +1 per page load (module-guarded so multiple banners don't multi-count)

Use `tone="info"` (blue, default) for "what this tab does"; `tone="warn"` (amber) only for genuine gotchas. **One blue tooltip per tab** — don't stack multiple callouts (the gold "optional" box on Modify was removed for this reason).

### Toggle switch

`ToggleSwitch` (local to `EnhancePanel.tsx`). Pill style: `w-10 h-6 rounded-full` track + `w-5 h-5` white knob translating `translate-x-4` when checked. Label wrapper `flex items-start gap-3 p-3 rounded-lg border cursor-pointer` — checked `bg-blue-950 border-blue-500 text-white`, unchecked `bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-500`. **This is the reference style for any on/off selection**, including equipment-type selection (pending migration — see §8 of the overhaul / open items).

### Equipment chips (current → target)

Currently segmented-control chips grouped into "warehouse forks" vs "aerial" clusters (`EQUIPMENT_GROUPS` in `lib/types.ts`). **Target: restyle to the toggle look-and-feel above** on both the Enhance MetaCard and the Resize collage picker (open item).

---

## 7. Layout conventions

- Tab body max width: `max-w-screen-2xl mx-auto`.
- Standard vertical rhythm between sections: `space-y-4` / `space-y-6`.
- Sticky command bars: `sticky bottom-0 -mx-6 px-6 py-3 bg-black/95 backdrop-blur border-t border-zinc-900`.
- Every tab opens with its blue tooltip accordion, then the drag-drop uploader directly below it.

---

## 8. Don't-do list (regressions this pass fixed)

- ❌ Full-width buttons (`w-full` on `<button>`)
- ❌ Auto-advance toggle / feature (removed entirely)
- ❌ `yellow-200` for hints (use `yellow-300`)
- ❌ Per-section heading accent colors (`sky-400`, `fuchsia-400`) — use `text-white`
- ❌ One-off button colors (`purple-600`) — use the green/blue/red system
- ❌ Green-bordered "focal" boxes for routine content — neutral `border-zinc-800`
- ❌ Multiple stacked callout boxes per tab — one blue tooltip accordion
- ❌ New accent colors of any kind without adding them here first
