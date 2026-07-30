# CleanShot — UI Style Guide

Canonical reference for the CleanShot web app's visual system. Rewritten 2026-07-30 for the **Discount Forklift house palette**. **When adding any new UI element, conform to this document.** If a need arises that this guide doesn't cover, extend the guide in the same PR rather than inventing a one-off.

Stack: Next.js 16 App Router · React 19 · Tailwind v4 (`@theme` tokens, no `tailwind.config.js`) · dark theme only.

---

## 0. The one rule that matters

**[`apps/web/styles/globals.css`](apps/web/styles/globals.css) is the single source of truth for every colour.** Components reference semantic token utilities (`bg-panel`, `text-ink`, `border-line`) — **never a raw hex, never a Tailwind palette family**.

Tailwind's default colour families are **deleted** in `@theme` (`--color-zinc-*: initial`, etc.). This is deliberate: `bg-zinc-900` / `text-amber-300` / `border-blue-500` now generate **no CSS at all**, so a stray legacy class shows up as an obviously-unstyled element in review instead of quietly reintroducing a blue-grey. Only `white` and `black` survive from the defaults, because both are true neutrals.

### Three hard constraints

1. **Every grey is a true neutral — `r == g == b`.** No slate, no blue-grey, no warm grey. Tailwind has no true-neutral ramp (`zinc-900` is `#18181b`, r24 g24 b27 — blue-dominant), which is why the families are gone.
2. **No clay, amber, mustard, orange or terracotta anywhere.** The "attention" colour is **purple** (`attn`). It was briefly red; red is now reserved for genuinely destructive controls only.
3. **The only blue-dominant colours permitted are the three house purples** (`#914EA6`, `#743E85`, `#B786C6`). `#B786C6` is unavoidably blue-dominant — every colour at hue 285° is — so making attention purple widened this constraint from two to three. Nothing else may have blue as its strongest channel.

Audit by channel, not by eye — old blue-greys hide in placeholders, empty states and letterbox backgrounds no design review ever looks at:

```bash
cd apps/web && npx next build
find .next -name '*.css' -path '*static*' | xargs grep -ohE '#[0-9A-Fa-f]{6}' | sort -u
```

---

## 1. Tokens

| Token | Utility | Value | Use |
|---|---|---|---|
| headerBg | `header-bg` | `#131313` | Header + footer plate; **also the text colour on filled accent/grey** |
| bg | `bg` | `#242424` | Main page background |
| panel | `panel` | `#2C2C2C` | Cards, surfaces |
| panelHi | `panel-hi` | `#363636` | Raised surface: active tab, selected control, ghost-button hover |
| well | `well` | `#1A1A1A` | Image letterbox, progress track, recessed areas |
| line | `line` | `#454545` | Borders, dividers |
| ink | `ink` | `#CACACA` | Headings + primary text |
| inkSoft | `ink-soft` | `#9F9F9F` | Sub-headings + secondary text |
| inkFaint | `ink-faint` | `#8A8A8A` | De-emphasised labels only (~4.0:1 on panel) |
| grey | `grey` | `#9A9A9A` | Secondary tags, neutral pills |
| muted | `muted` | `#8E8E8E` | Disabled / archived / inactive |
| accent | `accent` | `#95EA00` | Brand lime — "good" states, progress |
| attn | `attn` | `#B786C6` | **Attention + error**: text, borders, rules, status dots. 5.35:1 page / 4.81:1 card |
| cta | `cta` | `#914EA6` | Primary buttons |
| ctaDark | `cta-dark` | `#743E85` | Primary button hover |
| danger | `danger` | `#C22B2B` | **DESTRUCTIVE controls only** — filled, under white text |
| dangerInk | `danger-ink` | `#E85D5D` | Hairline border on a filled destructive button |
| dangerDark | `danger-dark` | `#8E1D1D` | Destructive button hover |

---

## 2. Semantics — three colours, three meanings

- **lime** (`accent`) = brand identity and "good": complete, active, done, all-clear, progress.
- **purple** (`cta`) = action. Primary buttons.
- **purple** (`attn`) = attention **and** error — text, borders, rules, status dots.
- **red** (`danger`) = **destructive controls only.** Currently exactly three: the two ✕ remove buttons and Clear All. Nothing else in the app is red.

**Red is not a general accent.** Before this palette, red was the brand accent, so `Approve →`, `Download ZIP`, `Retry`, `Regenerate now` and `Send to admin` were all red despite being ordinary actions. They are purple now. If you find yourself reaching for red, ask whether the control actually destroys something.

**Do not add a fourth accent. Do not reintroduce a second green. Do not use amber for warnings.**

Consequences worth knowing:

- The old **blue** "skip/utility" button is now a **neutral ghost button** (`bg-panel` → `hover:bg-panel-hi`), because purple is reserved for primary actions.
- The old **yellow** field hint is now **lime** — the brand "look here" highlight. Lime is 10.4:1 on `bg`, so lime text and rules are safe anywhere on the page.
- The old **amber** warning tone is now **purple** (`attn` on `bg-panel`).
- **Per-provider identity hues are gone.** The palette can't encode six model colours. Provider selection is shown structurally (raised surface + lime border) and differentiated by name plus the speed pill (lime "Fast" / purple "Slow").

---

## 3. Elevation is three-level and slightly unusual

Header and footer are **DARKER** than the page (`#131313` on `#242424`), while cards are **LIGHTER** (`#2C2C2C`). **Do not "fix" this into a conventional single-direction ramp** — the near-black plates top and bottom are the look.

```text
#131313  header / footer plate, sticky command bars, tab strip
#242424    page background
#2C2C2C      cards, panels
#363636        raised: active tab, selected control, ghost hover
#1A1A1A  well — image letterbox, progress track (recessed, not elevated)
```

---

## 4. Text-on-fill rules (the easiest thing to get wrong)

| Fill | Text | Why |
|---|---|---|
| Filled **lime** or filled **grey** | `text-header-bg` (`#131313`) | White on `#95EA00` is ~1.5:1 and effectively unreadable. Covers filled badges, count pills, active pills, **checklist ticks**, toggle knobs. |
| Filled **purple** or filled **red** | `text-white` | 5.5:1 and 5.2:1 — correct. |
| Attention as **text** or a hairline rule | `text-attn` (`#B786C6`) | **Never** a CTA purple as text — `#914EA6` is 2.84:1 and `#743E85` is 2.05:1, both fail AA. The CTA purples are fill-only. |
| Lime as text or rule | `text-accent` | 10.4:1 on `bg` — safe anywhere. |

Two automated checks worth re-running after any bulk change:

```bash
cd apps/web
# 1. light text on a lime/grey FILL — must be empty
grep -rnP "bg-(accent|grey)\b(?!-)" app components lib | grep -P "text-white\b"
# 2. same token as both text and background (invisible) — must be empty
for t in accent cta danger panel panel-hi well ink grey muted header-bg; do
  grep -rnP "(?=[^\"']*\btext-$t\b(?!-))(?=[^\"']*\bbg-$t\b(?!-)(/[0-9]+)?)" app components lib
done
```

---

## 5. Buttons

**Two hard rules:**

1. **Never full-width.** Buttons are `inline-flex` / auto-width. No `w-full` on `<button>`. Group with `flex flex-wrap gap-3`.
2. **Colour = meaning** (§2).

### Canonical button class

```text
inline-flex py-3 px-6 rounded-lg font-bold text-base uppercase tracking-[0.12em] border-2 transition-colors
```

| Semantic | State classes |
|---|---|
| **Primary / proceed / approve / commit** | `border-cta bg-cta hover:bg-cta-dark text-white` |
| **Secondary / skip / utility (ghost)** | `border-line bg-panel hover:bg-panel-hi text-ink` |
| **Destructive (only if it really destroys)** | `border-danger-ink bg-danger hover:bg-danger-dark text-white` |
| **Disabled** | `border-line bg-panel-hi text-muted cursor-not-allowed` |

Buttons stay **flat** — no drop shadows, and no coloured shadows at all (the `shadow-*-900/40` tints were removed with the palette).

---

## 6. Selected / active state pattern

One pattern everywhere — equipment cards, provider chips, toggles, active tabs:

**Raised surface + lime border.** `bg-panel-hi border-accent text-ink`, unselected `bg-panel border-line text-ink-soft`.

The toggle switch (`ToggleSwitch` in `EnhancePanel.tsx`) follows it: track `bg-accent` when ON / `bg-panel-hi` when OFF, and the knob flips to `bg-header-bg` on the lime track (a white knob on lime disappears).

---

## 7. Containers

| Element | Classes |
|---|---|
| Standard card | `rounded-xl border border-line bg-panel p-4` (`p-5` roomy) |
| Recessed / letterbox | `bg-well border border-line` |
| Info callout (`TipBanner` `tone="info"`) | `border-line bg-panel`, icon `text-accent`, title `text-ink` |
| Warn callout (`tone="warn"`) | `border-attn bg-panel`, icon + title `text-attn` |
| Success card | `rounded-xl border-2 border-accent bg-panel px-5 py-4` |
| Error card | `border border-attn bg-panel rounded-lg px-4 py-3 text-attn` |
| Drag-and-drop zone | `border-2 border-dashed rounded-xl p-8 text-center` — idle `border-line`, hover/dragging `border-accent bg-panel-hi/40`, disabled `border-line opacity-50` |
| Image scrims over photos | `bg-header-bg/70` … `/95` (token, not raw black) |
| Radius scale | cards `rounded-xl`; buttons/inputs `rounded-lg`; pills `rounded` |

---

## 8. Links

Global base rule in `globals.css`: `a { font-weight: 700; color: var(--color-accent) }`, hover adds underline. Any link with no explicit colour class lands on **bold lime** automatically.

Not purple (reserved for buttons) and not the previous `#CE6FEC` (blue-dominant, banned).

---

## 9. Typography

Fonts load via `next/font/google` in [`app/layout.tsx`](apps/web/app/layout.tsx) and are referenced through `@theme`:

| Token | Family | Use |
|---|---|---|
| `font-display` | **Archivo Black** | `<h1>`, uppercase section headings |
| `font-sans` (default) | **Archivo** | Body |
| `font-mono` | **IBM Plex Mono** | Labels, metadata, filenames, ids, timings |

**Archivo Black ships a single weight** — never combine `font-display` with `font-bold`/`font-semibold`, or the browser synthesises a smeared faux-bold.

| Element | Classes |
|---|---|
| App name (`<h1>`) | `font-display text-3xl tracking-[0.14em] text-accent uppercase` |
| Section heading | `font-display text-lg–text-xl text-ink uppercase tracking-[0.12em–0.14em]` |
| Body | `text-sm–text-base text-ink leading-relaxed` |
| Secondary | `text-ink-soft` |
| Field hint | `text-base text-accent font-semibold leading-relaxed` |
| Caption / meta | `text-xs–text-sm text-ink-faint` |
| Mono | `font-mono tabular-nums` |

---

## 10. Branding

- **The logo carries "Discount Forklift"**, so the `<h1>` is **just the app name** and there is **no "DISCOUNT FORKLIFT" text eyebrow** above it. The full product name lives in the document `<title>`.
- **One short subheading line** under the `<h1>` stating what the app does, in `text-ink-soft`.
- **Wordmark** is `public/discount-forklift-logo.png` — a wide transparent PNG, 1438×400 (**3.6:1**), red with a black outline and white keyline, so it reads correctly on `#131313` with **no plate behind it**. Header **48px** tall (173px wide); centred **250px** wide on auth screens.
- Always set explicit `width`/`height` on the logo `<img>` — it was the dominant CLS contributor on `/` before those were added.
- The route guard in [`apps/web/proxy.ts`](apps/web/proxy.ts) exempts static assets by extension, so the logo renders on signed-out pages. **If you tighten that matcher, keep the image paths exempt** — a guard that matches everything redirects the image request and serves HTML, giving a broken logo on exactly the page where nobody is logged in.

---

## 11. Layout conventions

- Tab body max width `max-w-screen-2xl mx-auto`; vertical rhythm `space-y-4` / `space-y-6`.
- Sticky command bars: `sticky bottom-0 -mx-6 px-6 py-3 bg-header-bg/95 backdrop-blur border-t border-line`.
- `html { scrollbar-gutter: stable }` reserves the gutter so cards don't jump when the scrollbar appears.
- Tooltip accordions (`TipBanner`) are collapsible, visit-count driven via [`lib/useVisitCount.ts`](apps/web/lib/useVisitCount.ts) — expanded visits 1–4, collapsed visit 5+. **One callout per tab.**

---

## 12. Don't-do list

- ❌ Any Tailwind palette family (`zinc-*`, `blue-*`, `amber-*`, …) — they generate no CSS by design
- ❌ Raw hex in a component — add a token instead
- ❌ A grey where `r != g != b`
- ❌ Amber/orange for warnings — warnings are purple (`attn`)
- ❌ Red for anything that doesn't actually destroy something
- ❌ Purple for anything but a primary button
- ❌ White text on a lime or grey fill (~1.5:1)
- ❌ A CTA purple as text (2.84:1 / 2.05:1) — use `attn` `#B786C6`
- ❌ `font-display` combined with a `font-bold`-family class
- ❌ A second colour vocabulary in a prop union (`color="blue"`) — name props by role (`good`, `attention`, `neutral`, `muted`)
- ❌ Full-width buttons, coloured drop shadows, multiple stacked callouts per tab
- ❌ "Fixing" the header/footer plates to be lighter than the page
