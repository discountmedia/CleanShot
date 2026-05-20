// CleanShot — redesigned Enhance tab prototype
// Shows three integrated UX improvements:
//   (1) Grouped-by-source compare grid — 5 provider variants side-by-side
//       per uploaded image, with one-click "winner" selection
//   (2) Auto-advance toggle in the header + per-row "Hold" override
//   (3) Lifted forklift metadata — only Make required up front, the rest
//       behind a "More details" disclosure
//
// Built to match the live CleanShot visual vocabulary exactly:
// bg-black + zinc neutrals + red-600 accent, Inter + JetBrains Mono,
// .18em tracked uppercase labels, rounded-xl cards w/ zinc-800 border.

const { useState, useMemo, useCallback } = React;

// ─── Mock data ──────────────────────────────────────────────────────────────

const PROVIDERS = [
  { id: "gemini", label: "Gemini", model: "gemini-3.1-flash-image-preview", costPerCall: 0.134, dur: 20, onBg: "bg-blue-950/40",    onText: "text-blue-300",    onBorder: "border-blue-800" },
  { id: "openai", label: "OpenAI", model: "gpt-image-2-2026-04-21",         costPerCall: 0.12,  dur: 75, onBg: "bg-green-950/40",   onText: "text-green-300",   onBorder: "border-green-800" },
  { id: "flux",   label: "Flux",   model: "flux-2-max",                     costPerCall: 0.05,  dur: 25, onBg: "bg-purple-950/40",  onText: "text-purple-300",  onBorder: "border-purple-800" },
  { id: "reve",   label: "Reve",   model: "reve-edit-fast-latest",          costPerCall: 0.04,  dur: 20, onBg: "bg-fuchsia-950/40", onText: "text-fuchsia-300", onBorder: "border-fuchsia-800" },
  { id: "grok",   label: "Grok",   model: "grok-imagine-image-quality",     costPerCall: 0.08,  dur: 30, onBg: "bg-orange-950/40",  onText: "text-orange-300",  onBorder: "border-orange-800" },
];

// Four source images in different states to show all the patterns at once.
// status per provider: "complete" | "processing" | "failed" | "queued"
const INITIAL_SOURCES = [
  {
    id: "s1",
    filename: "TOYOTA_8FGU25_2019_01.jpg",
    hue: "from-amber-700 via-amber-900 to-zinc-900",
    held: false,
    chosen: "gemini",
    variants: {
      gemini: { status: "complete", elapsed: 18 },
      openai: { status: "complete", elapsed: 71 },
      flux:   { status: "complete", elapsed: 24 },
      reve:   { status: "complete", elapsed: 19 },
      grok:   { status: "complete", elapsed: 31 },
    },
  },
  {
    id: "s2",
    filename: "TOYOTA_8FGU25_2019_02.jpg",
    hue: "from-orange-800 via-stone-900 to-zinc-900",
    held: false,
    chosen: null,
    variants: {
      gemini: { status: "complete",   elapsed: 22 },
      openai: { status: "processing", elapsed: 41, pct: 55 },
      flux:   { status: "complete",   elapsed: 26 },
      reve:   { status: "processing", elapsed: 12, pct: 65 },
      grok:   { status: "complete",   elapsed: 29 },
    },
  },
  {
    id: "s3",
    filename: "TOYOTA_8FGU25_2019_03.jpg",
    hue: "from-yellow-700 via-amber-900 to-stone-900",
    held: true,
    chosen: null,
    variants: {
      gemini: { status: "complete", elapsed: 21 },
      openai: { status: "complete", elapsed: 68 },
      flux:   { status: "complete", elapsed: 23 },
      reve:   { status: "failed",   elapsed: 18, error: "Reve 429 — rate limited, retry queued" },
      grok:   { status: "complete", elapsed: 33 },
    },
  },
  {
    id: "s4",
    filename: "TOYOTA_8FGU25_2019_04.jpg",
    hue: "from-stone-700 via-zinc-800 to-zinc-900",
    held: false,
    chosen: null,
    variants: {
      gemini: { status: "queued",     elapsed: 0 },
      openai: { status: "queued",     elapsed: 0 },
      flux:   { status: "queued",     elapsed: 0 },
      reve:   { status: "queued",     elapsed: 0 },
      grok:   { status: "queued",     elapsed: 0 },
    },
  },
];

// ─── Header (combined with tab bar) ─────────────────────────────────────────

function Header({ autoAdvance, onAutoAdvance, activeTab, onTab, counts }) {
  const TABS = [
    { id: "enhance", label: "Enhance" },
    { id: "scan",    label: "Scan",    count: counts.scan },
    { id: "resize",  label: "Resize",  count: counts.resize },
    { id: "history", label: "History" },
  ];
  return (
    <header className="bg-black border-b-2 border-red-600">
      <div className="flex items-center px-6 h-14 gap-6 max-w-screen-2xl mx-auto">
        {/* Logo */}
        <img src="../assets/discount-forklift-logo.png" alt="Discount Forklift" className="h-7 w-auto block shrink-0" />
        <div className="flex items-baseline gap-3 shrink-0">
          <h1 className="text-sm font-bold tracking-[0.18em] text-white uppercase">CleanShot</h1>
        </div>

        {/* Tabs inline (combined into header — change #8 in the proposal) */}
        <nav className="flex items-stretch gap-8 ml-2" role="tablist">
          {TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => onTab(tab.id)}
                className={`relative flex items-center gap-2 h-14 text-xs font-semibold uppercase tracking-[0.16em] whitespace-nowrap transition-colors ${isActive ? "text-red-500" : "text-zinc-500 hover:text-zinc-300"}`}
              >
                <span>{tab.label}</span>
                {typeof tab.count === "number" && tab.count > 0 && (
                  <span className={`inline-flex items-center justify-center min-w-[22px] h-[18px] px-1.5 rounded text-[10px] font-bold tabular-nums ${isActive ? "bg-red-950 text-red-300" : "bg-zinc-900 text-zinc-400"}`}>
                    {tab.count}
                  </span>
                )}
                {isActive && <span className="absolute left-0 right-0 -bottom-[2px] h-[2px] bg-red-600" />}
              </button>
            );
          })}
        </nav>

        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-3">
          {/* Auto-advance toggle (change #2) — defaults OFF so new operators
              learn the pipeline explicitly. Power users flip it on once they
              trust the flow. */}
          <button
            onClick={() => onAutoAdvance(!autoAdvance)}
            title={autoAdvance
              ? "Picked winners auto-flow to Scan and approved scans auto-flow to Resize"
              : "Click to let picked winners auto-flow into Scan as you make them"}
            className={`group flex items-center gap-2.5 px-3 py-1.5 rounded-md border transition-colors ${autoAdvance ? "border-red-900 bg-red-950/30 hover:border-red-700" : "border-zinc-800 bg-zinc-950 hover:border-zinc-700"}`}
            aria-pressed={autoAdvance}
          >
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-400 group-hover:text-zinc-200">
              Auto-advance
            </span>
            <span className={`relative w-7 h-4 rounded-full transition-colors ${autoAdvance ? "bg-red-600" : "bg-zinc-700"}`}>
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${autoAdvance ? "translate-x-3" : ""}`} />
            </span>
          </button>

          {/* User chip — minimal in the prototype */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800">
            <span className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white">SC</span>
            <span className="text-xs text-zinc-300 hidden sm:block">stephen@discountforklift.us</span>
          </div>
        </div>
      </div>
    </header>
  );
}

// ─── Batch context strip (change #8 bonus — "what am I working on") ─────────

function BatchContextStrip({ make, model, count }) {
  return (
    <div className="border-b border-zinc-900 bg-zinc-950/40">
      <div className="px-6 py-2 max-w-screen-2xl mx-auto flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-600">
          Batch
        </span>
        <span className="font-mono text-xs text-zinc-300">
          {new Date().toISOString().slice(0, 10)}_{(make || "—").toUpperCase()}_{(model || "—").toUpperCase()}
        </span>
        <span className="text-zinc-700">·</span>
        <span className="text-xs text-zinc-400 tabular-nums">{count} image{count !== 1 ? "s" : ""}</span>
      </div>
    </div>
  );
}

// ─── Forklift metadata (lifted — change #1) ─────────────────────────────────

function MetaCard({ meta, onChange, expanded, onExpand }) {
  const update = (k, v) => onChange({ ...meta, [k]: v });
  const makeValid = (meta.make || "").trim().length > 0;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <div className="px-5 py-4 flex items-end gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label className="flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500 mb-1.5">
            Make <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={meta.make || ""}
            onChange={(e) => update("make", e.target.value)}
            placeholder="e.g. Toyota"
            className={`w-full bg-zinc-900 border rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:border-transparent transition ${makeValid ? "border-zinc-700 focus:ring-red-500" : "border-red-900 focus:ring-red-500"}`}
          />
        </div>
        <button
          onClick={() => onExpand(!expanded)}
          className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-400 hover:text-white transition-colors px-3 py-2 border border-zinc-800 hover:border-zinc-600 rounded mb-[1px]"
        >
          {expanded ? "− Hide details" : "+ More details"}
        </button>
        <span className="text-xs text-zinc-500 ml-auto mb-2">
          {makeValid ? "✓ ready to enhance" : "Enter the forklift Make to continue"}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-zinc-900 px-5 py-4 grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            ["model", "Model", "e.g. 8FGU25"],
            ["year", "Year", "e.g. 2019"],
            ["tireType", "Tire Type", "e.g. Pneumatic"],
            ["capacity", "Capacity", "e.g. 5000 lbs"],
            ["fuelType", "Fuel Type", "e.g. LPG"],
          ].map(([k, label, ph]) => (
            <label key={k} className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500">{label}</span>
              <input
                type="text"
                value={meta[k] || ""}
                onChange={(e) => update(k, e.target.value)}
                placeholder={ph}
                className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
              />
            </label>
          ))}
          <p className="col-span-full text-[11px] text-zinc-600 leading-snug">
            These also feed the Resize tab's <span className="font-mono">Save Project</span> form — no need to re-enter.
          </p>
        </div>
      )}
    </section>
  );
}

// ─── Provider selection + cost preview (change #3) ──────────────────────────

function ProviderRow({ selected, onToggle, imageCount }) {
  const total = useMemo(() => {
    const providers = [...selected];
    const cost = providers.reduce((acc, p) => {
      const def = PROVIDERS.find((x) => x.id === p);
      return acc + (def?.costPerCall ?? 0);
    }, 0) * imageCount;
    const maxDur = Math.max(...providers.map((p) => PROVIDERS.find((x) => x.id === p)?.dur ?? 0), 0);
    return { jobs: providers.length * imageCount, cost, dur: maxDur };
  }, [selected, imageCount]);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <header className="flex items-center justify-between px-5 py-3 bg-zinc-900/30 border-b border-zinc-900">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">AI Providers</span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-600">multi-select</span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">
          {selected.size} selected
        </span>
      </header>

      <div className="px-5 py-4">
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => {
            const isOn = selected.has(p.id);
            return (
              <button
                key={p.id}
                onClick={() => onToggle(p.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-md border transition-colors ${isOn ? `${p.onBg} ${p.onText} ${p.onBorder}` : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-700"}`}
              >
                <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${isOn ? "bg-current border-current" : "border-zinc-700"}`}>
                  {isOn && (
                    <svg className="w-2.5 h-2.5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                <span className="text-xs font-semibold uppercase tracking-[0.16em]">{p.label}</span>
                <span className="text-[10px] opacity-60 font-mono">~{p.dur}s</span>
              </button>
            );
          })}
        </div>

        {/* Cost preview strip (change #3) */}
        <div className="mt-4 flex items-center gap-4 text-xs flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-600 uppercase tracking-[0.18em] text-[10px]">Jobs</span>
            <span className="font-mono tabular-nums text-zinc-200">{total.jobs}</span>
          </div>
          <span className="text-zinc-800">·</span>
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-600 uppercase tracking-[0.18em] text-[10px]">Est. cost</span>
            <span className="font-mono tabular-nums text-zinc-200">${total.cost.toFixed(2)}</span>
          </div>
          <span className="text-zinc-800">·</span>
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-600 uppercase tracking-[0.18em] text-[10px]">Wall time</span>
            <span className="font-mono tabular-nums text-zinc-200">~{Math.ceil(total.dur / 60)} min</span>
          </div>
          <div className="ml-auto text-[11px] text-zinc-600 italic max-w-xs text-right">
            Selecting more providers gives you more variants to compare — pick a winner per image before they go to Scan.
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Provider variant thumbnail ─────────────────────────────────────────────

function VariantThumb({ provider, variant, chosen, onChoose, hue }) {
  const def = PROVIDERS.find((x) => x.id === provider);
  const status = variant?.status ?? "queued";
  const isChosen = chosen === provider;

  const baseTint = {
    gemini: "from-blue-900/40",
    openai: "from-green-900/40",
    flux:   "from-purple-900/40",
    reve:   "from-fuchsia-900/40",
    grok:   "from-orange-900/40",
  }[provider];

  return (
    <button
      onClick={() => status === "complete" && onChoose(provider)}
      disabled={status !== "complete"}
      className={`group relative flex flex-col items-stretch text-left rounded-lg overflow-hidden border transition-all
        ${isChosen ? "border-red-500 ring-2 ring-red-600/40" : "border-zinc-800 hover:border-zinc-600"}
        ${status !== "complete" ? "cursor-default" : "cursor-pointer"}`}
    >
      {/* Image / state surface */}
      <div className={`relative aspect-square bg-gradient-to-br ${hue}`}>
        {/* per-provider tint overlay so variants don't look identical */}
        <div className={`absolute inset-0 bg-gradient-to-tr ${baseTint} to-transparent mix-blend-overlay`} />

        {status === "complete" && (
          <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
        {status === "processing" && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2">
            <svg className="animate-spin w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            <span className="font-mono text-[10px] text-blue-300 tabular-nums">{variant.pct}%</span>
          </div>
        )}
        {status === "queued" && (
          <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
            <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Queued</span>
          </div>
        )}
        {status === "failed" && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-1.5 px-2">
            <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <span className="text-[10px] uppercase tracking-[0.16em] text-red-400">Failed</span>
          </div>
        )}

        {isChosen && (
          <div className="absolute inset-x-0 bottom-0 bg-red-600 px-2 py-1 flex items-center justify-center gap-1">
            <span className="text-[9px] uppercase tracking-[0.18em] font-bold text-white">Winner</span>
          </div>
        )}
      </div>

      {/* Footer — provider label */}
      <div className={`px-2 py-1.5 flex items-center justify-between border-t ${isChosen ? "border-red-700 bg-red-950/30" : "border-zinc-800 bg-zinc-950"}`}>
        <span className={`text-[10px] font-bold uppercase tracking-[0.16em] ${isChosen ? "text-red-300" : "text-zinc-300"}`}>
          {def.label}
        </span>
        <span className="text-[9px] font-mono text-zinc-600 tabular-nums">
          {status === "complete" ? `${variant.elapsed}s` : status === "processing" ? "…" : "—"}
        </span>
      </div>
    </button>
  );
}

// ─── Source-image compare card (change #4 — the big one) ────────────────────

function SourceCompareCard({ source, autoAdvance, onChoose, onToggleHold, onRetry }) {
  const completedCount = Object.values(source.variants).filter((v) => v.status === "complete").length;
  const failedCount    = Object.values(source.variants).filter((v) => v.status === "failed").length;
  const totalCount     = Object.keys(source.variants).length;
  const allDone        = completedCount + failedCount === totalCount;

  // If auto-advance is on and not held and a winner is set, show "will send"
  const willAutoSend = autoAdvance && !source.held && source.chosen && allDone;

  return (
    <article className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-900 gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="font-mono text-sm text-zinc-200 truncate" title={source.filename}>
            {source.filename}
          </span>
          <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500 tabular-nums whitespace-nowrap">
            {completedCount}/{totalCount} complete
            {failedCount > 0 && <span className="text-red-400 ml-1">· {failedCount} failed</span>}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Auto-advance status pill */}
          {willAutoSend && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-green-400 bg-green-950/40 border border-green-800 px-2 py-1 rounded">
              → sending to Scan
            </span>
          )}
          {!allDone && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-blue-400 bg-blue-950/40 border border-blue-800 px-2 py-1 rounded">
              working
            </span>
          )}
          {allDone && !source.chosen && !source.held && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-red-400 bg-red-950/40 border border-red-800 px-2 py-1 rounded">
              pick a winner
            </span>
          )}

          {/* Hold toggle (change #2 — per-row override of auto-advance) */}
          <button
            onClick={() => onToggleHold(source.id)}
            title={source.held ? "Holding — won't auto-advance" : "Hold this image (don't auto-send)"}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-semibold uppercase tracking-[0.18em] transition-colors
              ${source.held
                ? "border-amber-700 bg-amber-950/40 text-amber-300 hover:bg-amber-900/40"
                : "border-zinc-800 bg-transparent text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"}`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              {source.held ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6" />
              )}
            </svg>
            {source.held ? "Held" : "Hold"}
          </button>
        </div>
      </header>

      {/* Body — original on left, 5 variants on right */}
      <div className="p-5">
        <div className="grid grid-cols-[140px_auto_1fr] gap-4 items-start">
          {/* Original */}
          <figure className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">Original</span>
            <div className={`relative aspect-square rounded-lg overflow-hidden border border-zinc-800 bg-gradient-to-br ${source.hue}`}>
              <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/80 to-transparent">
                <span className="text-[9px] font-mono text-zinc-300">source</span>
              </div>
            </div>
          </figure>

          {/* Arrow */}
          <div className="self-center text-2xl text-zinc-700 pt-6" aria-hidden="true">→</div>

          {/* Variants */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
                Enhanced — click a variant to pick the winner
              </span>
              {source.chosen && (
                <button
                  onClick={() => onChoose(source.id, null)}
                  className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 hover:text-zinc-300"
                >
                  Clear pick
                </button>
              )}
            </div>
            <div className="grid grid-cols-5 gap-2">
              {PROVIDERS.map((p) => (
                <VariantThumb
                  key={p.id}
                  provider={p.id}
                  variant={source.variants[p.id]}
                  chosen={source.chosen}
                  hue={source.hue}
                  onChoose={(prov) => onChoose(source.id, prov)}
                />
              ))}
            </div>

            {/* Failed-variant inline retry strip */}
            {failedCount > 0 && (
              <div className="mt-1 flex items-center justify-between rounded border border-red-900 bg-red-950/20 px-3 py-2">
                <div className="text-[11px] text-red-300">
                  <span className="font-semibold uppercase tracking-[0.16em] text-red-400">Reve failed</span>
                  <span className="text-zinc-500 ml-2 font-mono">429 — rate limited, retry queued</span>
                </div>
                <button
                  onClick={() => onRetry(source.id, "reve")}
                  className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-300 hover:text-white bg-amber-950/40 hover:bg-amber-700 border border-amber-800 hover:border-amber-600 px-2.5 py-1 rounded transition-colors"
                >
                  ↻ Retry Reve
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

// ─── Footer command bar (sticky action region) ──────────────────────────────

function CommandBar({ sources, autoAdvance, onSendAll }) {
  // Tally pickable images
  const ready = sources.filter((s) => {
    const done = Object.values(s.variants).every((v) => v.status === "complete" || v.status === "failed");
    return done && s.chosen && !s.held;
  });
  const waiting = sources.filter((s) => Object.values(s.variants).some((v) => v.status === "processing" || v.status === "queued")).length;
  const undecided = sources.filter((s) => {
    const done = Object.values(s.variants).every((v) => v.status === "complete" || v.status === "failed");
    return done && !s.chosen && !s.held;
  }).length;
  const held = sources.filter((s) => s.held).length;

  return (
    <section className="sticky bottom-0 mt-2 -mx-6 px-6 py-3 bg-black/95 backdrop-blur border-t border-zinc-900">
      <div className="max-w-screen-2xl mx-auto flex items-center gap-4">
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-zinc-400 tabular-nums">{ready.length} ready</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-zinc-400 tabular-nums">{waiting} working</span>
          </span>
          {undecided > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-red-400 tabular-nums">{undecided} need a pick</span>
            </span>
          )}
          {held > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              <span className="text-amber-300 tabular-nums">{held} held</span>
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {autoAdvance && (
            <span className="text-[11px] text-zinc-500 italic">
              Auto-advance is on — picks send to Scan as they're made
            </span>
          )}
          <button
            onClick={onSendAll}
            disabled={ready.length === 0}
            className={`text-xs uppercase tracking-[0.18em] font-semibold px-4 py-2 rounded border transition-colors ${ready.length === 0
              ? "border-zinc-800 bg-zinc-950 text-zinc-700 cursor-not-allowed"
              : "border-red-500 bg-red-600 hover:bg-red-500 text-white"}`}
          >
            Send {ready.length} to Scan →
          </button>
        </div>
      </div>
    </section>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────

function App() {
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [activeTab, setActiveTab] = useState("enhance");
  const [sources, setSources] = useState(INITIAL_SOURCES);
  const [meta, setMeta] = useState({ make: "Toyota", model: "8FGU25", year: "2019" });
  const [metaExpanded, setMetaExpanded] = useState(false);
  const [providers, setProviders] = useState(new Set(["gemini", "openai", "flux", "reve", "grok"]));

  const handleToggleProvider = (id) => {
    setProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size === 1) return prev;
        next.delete(id);
      } else next.add(id);
      return next;
    });
  };

  const handleChooseWinner = (sourceId, providerId) => {
    setSources((prev) => prev.map((s) => s.id === sourceId ? { ...s, chosen: providerId } : s));
  };

  const handleToggleHold = (sourceId) => {
    setSources((prev) => prev.map((s) => s.id === sourceId ? { ...s, held: !s.held } : s));
  };

  const handleRetry = (sourceId, providerId) => {
    setSources((prev) => prev.map((s) => {
      if (s.id !== sourceId) return s;
      return { ...s, variants: { ...s.variants, [providerId]: { status: "processing", elapsed: 0, pct: 5 } } };
    }));
  };

  const handleSendAll = () => {
    // In the real product this would call onSendToScan with the ready set.
    // Here we just clear the picks to demonstrate the flow.
    alert("Sending picked winners to Scan tab…");
  };

  const counts = useMemo(() => ({
    scan: sources.filter((s) => s.chosen && !s.held).length,
    resize: 0,
  }), [sources]);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <Header
        autoAdvance={autoAdvance}
        onAutoAdvance={setAutoAdvance}
        activeTab={activeTab}
        onTab={setActiveTab}
        counts={counts}
      />
      <BatchContextStrip make={meta.make} model={meta.model} count={sources.length} />

      <main className="flex-1 px-6 py-6 space-y-4 max-w-screen-2xl w-full mx-auto">
        {activeTab !== "enhance" ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-12 text-center text-sm text-zinc-500">
            <span className="uppercase tracking-[0.18em] font-semibold text-zinc-400">{activeTab}</span>
            <p className="mt-2 text-xs text-zinc-600">Tab stub — mockup focuses on the redesigned Enhance flow.</p>
          </div>
        ) : (
          <>
            {/* Forklift metadata — only Make required up front */}
            <MetaCard meta={meta} onChange={setMeta} expanded={metaExpanded} onExpand={setMetaExpanded} />

            {/* Provider selection + cost preview */}
            <ProviderRow selected={providers} onToggle={handleToggleProvider} imageCount={sources.length} />

            {/* Section header */}
            <header className="flex items-baseline justify-between pt-1">
              <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-[0.18em]">
                Results — {sources.length} image{sources.length !== 1 ? "s" : ""}
              </h2>
              <span className="text-[11px] text-zinc-600 italic">
                One card per source · all providers compared side-by-side
              </span>
            </header>

            {/* Compare cards */}
            <div className="space-y-3 pb-4">
              {sources.map((s) => (
                <SourceCompareCard
                  key={s.id}
                  source={s}
                  autoAdvance={autoAdvance}
                  onChoose={handleChooseWinner}
                  onToggleHold={handleToggleHold}
                  onRetry={handleRetry}
                />
              ))}
            </div>

            <CommandBar sources={sources} autoAdvance={autoAdvance} onSendAll={handleSendAll} />
          </>
        )}
      </main>

      <footer className="px-6 py-6 text-center">
        <p className="text-[10px] text-zinc-800 select-none">
          Developed by Stephen Cunningham © AI App Integrations LLC 2026
        </p>
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
