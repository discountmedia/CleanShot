// CleanShot — redesigned Scan tab prototype
// Integrated UX improvements:
//   A. Consensus-first card layout — one card per image, PASS/FAIL up top
//   B. Deduplicated unified anomaly list with "N/3 flagged" tags
//   C. Real per-provider progress (percent + elapsed/expected timer)
//   D. Inline regenerate panel — auto-prompt editable, one click to apply
//   E. Bulk approve at confidence threshold in the sticky command bar

const { useState, useMemo } = React;

// ─── Mock data ──────────────────────────────────────────────────────────────

const SCAN_PROVIDERS = [
  { id: "gemini",    label: "Gemini",    dur: 18, onBg: "bg-blue-950/40",   onText: "text-blue-300",   onBorder: "border-blue-800" },
  { id: "openai",    label: "OpenAI",    dur: 30, onBg: "bg-green-950/40",  onText: "text-green-300",  onBorder: "border-green-800" },
  { id: "anthropic", label: "Anthropic", dur: 25, onBg: "bg-orange-950/40", onText: "text-orange-300", onBorder: "border-orange-800" },
];

// Each scanned image is keyed by id. Variants per provider have verdict + confidence + anomalies.
const INITIAL_SCANS = [
  // 1. Clean unanimous pass — easy approve
  {
    id: "i1",
    filename: "TOYOTA_8FGU25_2019_01_Gemini.jpg",
    hue: "from-amber-700 via-amber-900 to-zinc-900",
    state: "complete",
    providers: {
      gemini:    { verdict: "pass", confidence: 0.94, elapsed: 17, anomalies: [] },
      openai:    { verdict: "pass", confidence: 0.91, elapsed: 28, anomalies: [] },
      anthropic: { verdict: "pass", confidence: 0.93, elapsed: 24, anomalies: [] },
    },
  },
  // 2. Pass with minor anomaly flagged by 2/3
  {
    id: "i2",
    filename: "TOYOTA_8FGU25_2019_02_Gemini.jpg",
    hue: "from-orange-800 via-stone-900 to-zinc-900",
    state: "complete",
    providers: {
      gemini:    { verdict: "pass", confidence: 0.88, elapsed: 19,
        anomalies: [{ type: "paint scuff", location: "left fork tip", severity: "low",
                      description: "minor surface abrasion, cosmetic only" }] },
      openai:    { verdict: "pass", confidence: 0.85, elapsed: 30,
        anomalies: [{ type: "paint scuff", location: "left fork", severity: "low",
                      description: "small chip on fork tip" }] },
      anthropic: { verdict: "pass", confidence: 0.90, elapsed: 26, anomalies: [] },
    },
  },
  // 3. Split verdict — 2 pass 1 fail — needs human review
  {
    id: "i3",
    filename: "TOYOTA_8FGU25_2019_03_OpenAI.jpg",
    hue: "from-yellow-700 via-amber-900 to-stone-900",
    state: "complete",
    providers: {
      gemini:    { verdict: "pass", confidence: 0.72, elapsed: 18,
        anomalies: [{ type: "decal damage", location: "right side", severity: "medium",
                      description: "Toyota decal partially worn" }] },
      openai:    { verdict: "fail", confidence: 0.55, elapsed: 31,
        anomalies: [{ type: "decal damage", location: "right side", severity: "medium",
                      description: "OEM decal degraded" },
                    { type: "rust", location: "mast bottom", severity: "medium",
                      description: "surface oxidation on mast base" }] },
      anthropic: { verdict: "pass", confidence: 0.68, elapsed: 25,
        anomalies: [{ type: "decal damage", location: "right side panel", severity: "medium",
                      description: "decal needs replacement" }] },
    },
  },
  // 4. Unanimous fail — show inline regen panel
  {
    id: "i4",
    filename: "TOYOTA_8FGU25_2019_04_Flux.jpg",
    hue: "from-red-900 via-stone-900 to-zinc-900",
    state: "complete",
    providers: {
      gemini:    { verdict: "fail", confidence: 0.34, elapsed: 17,
        anomalies: [{ type: "rust",     location: "overhead guard", severity: "high",
                      description: "heavy corrosion on overhead protective structure" },
                    { type: "missing decals", location: "side panel", severity: "high",
                      description: "no OEM brand decals visible" }] },
      openai:    { verdict: "fail", confidence: 0.41, elapsed: 32,
        anomalies: [{ type: "rust", location: "overhead guard", severity: "high",
                      description: "rust on guard frame" },
                    { type: "uneven lighting", location: "scene", severity: "low",
                      description: "shadows on right side too dark" }] },
      anthropic: { verdict: "fail", confidence: 0.39, elapsed: 26,
        anomalies: [{ type: "rust", location: "overhead guard", severity: "high",
                      description: "rust patches on protective cage" },
                    { type: "missing decals", location: "side", severity: "high",
                      description: "decals stripped or absent" },
                    { type: "faded paint", location: "counterweight", severity: "medium",
                      description: "paint oxidation on rear weight" }] },
    },
  },
  // 5. Currently scanning — show real progress
  {
    id: "i5",
    filename: "TOYOTA_8FGU25_2019_05_Gemini.jpg",
    hue: "from-stone-700 via-zinc-800 to-zinc-900",
    state: "scanning",
    providers: {
      gemini:    { status: "complete", elapsed: 18, pct: 100 },
      openai:    { status: "scanning", elapsed: 22, pct: 73 },
      anthropic: { status: "scanning", elapsed: 18, pct: 72 },
    },
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeConsensus(providers) {
  const results = Object.values(providers).filter((p) => p.verdict);
  if (results.length === 0) return null;
  const passes = results.filter((r) => r.verdict === "pass").length;
  const avgConf = results.reduce((a, r) => a + r.confidence, 0) / results.length;
  const verdict =
    passes === results.length ? "pass" :
    passes === 0              ? "fail" :
                                "mixed";
  return { verdict, avgConfidence: avgConf, passes, total: results.length };
}

// Dedupe anomalies across providers by (type+location); record which providers flagged each.
function unifyAnomalies(providers) {
  const map = new Map();
  for (const [pid, p] of Object.entries(providers)) {
    if (!p.anomalies) continue;
    for (const a of p.anomalies) {
      // Normalise location ("right side" vs "right side panel" vs "right") roughly
      const norm = `${a.type.toLowerCase()}::${a.location.split(" ")[0].toLowerCase()}`;
      if (!map.has(norm)) {
        map.set(norm, {
          type: a.type, location: a.location, severity: a.severity,
          description: a.description, flaggedBy: new Set(),
        });
      }
      map.get(norm).flaggedBy.add(pid);
      // Upgrade severity if any provider flagged worse
      const order = { low: 0, medium: 1, high: 2 };
      if (order[a.severity] > order[map.get(norm).severity]) {
        map.get(norm).severity = a.severity;
      }
    }
  }
  const sevOrder = { high: 0, medium: 1, low: 2 };
  return Array.from(map.values()).sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
}

function buildRegenPrompt(unified) {
  if (unified.length === 0) {
    return "Improve overall presentation of this USED forklift photograph while keeping it clearly the same machine in the same place — light tonal correction, sharper decals, dressed tires.";
  }
  const lines = unified.map((a) =>
    `• Fix [${a.severity.toUpperCase()}] ${a.type} at ${a.location}: ${a.description}`
  );
  return [
    "You are editing a photograph of a USED forklift to address SPECIFIC issues detected by AI scan. Fix the listed issues while leaving the rest of the image exactly as-is — same machine, same place, same lighting.",
    "",
    "ISSUES TO ADDRESS:",
    ...lines,
  ].join("\n");
}

// ─── Header (matches the Enhance redesign for consistency) ──────────────────

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
        <img src="../assets/discount-forklift-logo.png" alt="Discount Forklift" className="h-7 w-auto block shrink-0" />
        <div className="flex items-baseline gap-3 shrink-0">
          <h1 className="text-sm font-bold tracking-[0.18em] text-white uppercase">CleanShot</h1>
        </div>
        <nav className="flex items-stretch gap-8 ml-2" role="tablist">
          {TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
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
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => onAutoAdvance(!autoAdvance)}
            title={autoAdvance
              ? "Passes auto-flow to Resize; fails stay for review"
              : "Click to let passes auto-flow into Resize as they complete"}
            className={`group flex items-center gap-2.5 px-3 py-1.5 rounded-md border transition-colors ${autoAdvance ? "border-red-900 bg-red-950/30 hover:border-red-700" : "border-zinc-800 bg-zinc-950 hover:border-zinc-700"}`}
          >
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-400 group-hover:text-zinc-200">
              Auto-advance
            </span>
            <span className={`relative w-7 h-4 rounded-full transition-colors ${autoAdvance ? "bg-red-600" : "bg-zinc-700"}`}>
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${autoAdvance ? "translate-x-3" : ""}`} />
            </span>
          </button>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800">
            <span className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white">SC</span>
            <span className="text-xs text-zinc-300 hidden sm:block">stephen@discountforklift.us</span>
          </div>
        </div>
      </div>
    </header>
  );
}

// ─── Batch context strip ────────────────────────────────────────────────────

function BatchContextStrip({ make, model, count }) {
  return (
    <div className="border-b border-zinc-900 bg-zinc-950/40">
      <div className="px-6 py-2 max-w-screen-2xl mx-auto flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-600">Batch</span>
        <span className="font-mono text-xs text-zinc-300">
          {new Date().toISOString().slice(0, 10)}_{make.toUpperCase()}_{model.toUpperCase()}
        </span>
        <span className="text-zinc-700">·</span>
        <span className="text-xs text-zinc-400 tabular-nums">{count} image{count !== 1 ? "s" : ""} scanned</span>
      </div>
    </div>
  );
}

// ─── Filter chip row at the top of the Scan tab ─────────────────────────────

function FilterChips({ counts, active, onChange }) {
  const CHIPS = [
    { id: "all",      label: "All",       n: counts.all },
    { id: "pass",     label: "Pass",      n: counts.pass,    color: "text-green-400 border-green-800 bg-green-950/30" },
    { id: "mixed",    label: "Mixed",     n: counts.mixed,   color: "text-yellow-400 border-yellow-800 bg-yellow-950/30" },
    { id: "fail",     label: "Fail",      n: counts.fail,    color: "text-red-400 border-red-800 bg-red-950/30" },
    { id: "scanning", label: "Scanning",  n: counts.scanning,color: "text-blue-400 border-blue-800 bg-blue-950/30" },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {CHIPS.map((c) => {
        const isActive = active === c.id;
        const inactiveClass = c.color
          ? "text-zinc-500 border-zinc-800 bg-transparent hover:border-zinc-700"
          : "text-zinc-300 border-zinc-700 bg-zinc-900 hover:border-zinc-600";
        return (
          <button
            key={c.id}
            onClick={() => onChange(c.id)}
            disabled={c.n === 0 && c.id !== "all"}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${isActive ? (c.color ?? "border-red-500 bg-red-950/40 text-red-300") : inactiveClass}`}
          >
            <span>{c.label}</span>
            <span className="tabular-nums opacity-70">{c.n}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Verdict pill + confidence ──────────────────────────────────────────────

function ConsensusPill({ consensus }) {
  if (!consensus) return null;
  const { verdict, avgConfidence, passes, total } = consensus;
  const pct = Math.round(avgConfidence * 100);
  const config = {
    pass:  { label: "PASS",  icon: "✓", colorClass: "text-green-400 bg-green-950/60 border-green-800" },
    fail:  { label: "FAIL",  icon: "✗", colorClass: "text-red-400 bg-red-950/60 border-red-800" },
    mixed: { label: "MIXED", icon: "◐", colorClass: "text-yellow-400 bg-yellow-950/60 border-yellow-800" },
  }[verdict];
  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border ${config.colorClass}`}>
      <span className="text-base font-bold">{config.icon}</span>
      <div className="flex flex-col items-start leading-tight">
        <span className="text-[11px] font-bold uppercase tracking-[0.18em]">{config.label}</span>
        <span className="text-[10px] opacity-75 tabular-nums">{passes}/{total} pass · {pct}% avg conf</span>
      </div>
    </div>
  );
}

// ─── Unified anomaly list ───────────────────────────────────────────────────

function UnifiedAnomalies({ unified, totalProviders }) {
  const SEV_STYLE = {
    high:   { dot: "bg-red-500",    text: "text-red-400",    bg: "bg-red-950/20 border-red-900" },
    medium: { dot: "bg-yellow-500", text: "text-yellow-400", bg: "bg-yellow-950/20 border-yellow-900" },
    low:    { dot: "bg-zinc-500",   text: "text-zinc-400",   bg: "bg-zinc-900/40 border-zinc-800" },
  };
  if (unified.length === 0) {
    return (
      <div className="rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-2.5 text-xs text-zinc-500 italic">
        No anomalies detected — all providers agree the image is clean.
      </div>
    );
  }
  return (
    <ul className="space-y-1.5" aria-label="Detected anomalies">
      {unified.map((a, i) => {
        const sev = SEV_STYLE[a.severity];
        const flaggedCount = a.flaggedBy.size;
        return (
          <li key={i} className={`rounded-md border px-3 py-2 ${sev.bg}`}>
            <div className="flex items-start gap-2.5">
              <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${sev.dot}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className={`text-[10px] font-bold uppercase tracking-[0.18em] ${sev.text}`}>
                    {a.severity}
                  </span>
                  <span className="text-xs text-zinc-200 font-medium capitalize">{a.type}</span>
                  <span className="text-xs text-zinc-500">— {a.location}</span>
                </div>
                <p className="text-xs text-zinc-400 mt-0.5 leading-snug">{a.description}</p>
              </div>
              {/* Flagged-by signal bar — 1, 2, or 3 ticks */}
              <div className="shrink-0 flex flex-col items-end gap-0.5">
                <span className="text-[9px] uppercase tracking-[0.16em] text-zinc-600 tabular-nums">
                  {flaggedCount}/{totalProviders}
                </span>
                <div className="flex gap-0.5">
                  {Array.from({ length: totalProviders }).map((_, idx) => (
                    <span
                      key={idx}
                      className={`w-3 h-1 rounded-full ${idx < flaggedCount ? sev.dot : "bg-zinc-800"}`}
                    />
                  ))}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Per-provider summary chips (collapsed by default) ──────────────────────

function ProviderDetail({ providers, expanded, onToggle }) {
  return (
    <div className="space-y-2">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <svg className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Per-provider verdicts
      </button>
      {expanded && (
        <div className="grid grid-cols-3 gap-2">
          {SCAN_PROVIDERS.map((p) => {
            const r = providers[p.id];
            if (!r || !r.verdict) return (
              <div key={p.id} className="rounded-md border border-zinc-800 bg-zinc-900/30 px-2.5 py-1.5 text-[11px] text-zinc-600">
                {p.label} — pending
              </div>
            );
            const pct = Math.round(r.confidence * 100);
            const isPass = r.verdict === "pass";
            return (
              <div key={p.id} className={`rounded-md border px-2.5 py-2 ${isPass ? "border-green-900 bg-green-950/15" : "border-red-900 bg-red-950/15"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] font-bold uppercase tracking-[0.16em] ${p.onText}`}>{p.label}</span>
                  <span className={`text-[10px] font-semibold ${isPass ? "text-green-400" : "text-red-400"}`}>
                    {isPass ? "✓ pass" : "✗ fail"}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-500"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-zinc-400 tabular-nums w-8 text-right">{pct}%</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[9px] text-zinc-600">
                  <span>{r.anomalies?.length ?? 0} flagged</span>
                  <span className="font-mono tabular-nums">{r.elapsed}s</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Per-provider progress (while scanning) — change C ──────────────────────

function ScanProgressStrip({ providers }) {
  return (
    <div className="space-y-2">
      <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500">
        Running 3-provider consensus scan
      </span>
      {SCAN_PROVIDERS.map((p) => {
        const s = providers[p.id];
        if (!s) return null;
        const done = s.status === "complete";
        return (
          <div key={p.id} className="flex items-center gap-3">
            <span className={`text-[11px] font-bold uppercase tracking-[0.16em] w-20 ${p.onText}`}>{p.label}</span>
            <div className="flex-1 h-1.5 bg-zinc-900 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ease-out ${done ? "bg-green-500" : "bg-blue-500"}`}
                style={{ width: `${s.pct}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-zinc-500 tabular-nums w-24 text-right">
              {String(s.elapsed).padStart(2, "0")}s / ~{p.dur}s
            </span>
            <span className={`text-[10px] font-mono tabular-nums w-10 text-right ${done ? "text-green-400" : "text-blue-400"}`}>
              {s.pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Inline regenerate panel — change D ─────────────────────────────────────

function RegenPanel({ unified, providersList, defaultProvider, onApply, onCancel }) {
  const [prompt, setPrompt] = useState(() => buildRegenPrompt(unified));
  const [provider, setProvider] = useState(defaultProvider ?? "gemini");

  return (
    <section className="rounded-lg border border-amber-900 bg-amber-950/15 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2 border-b border-amber-900/50 bg-amber-950/30">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-amber-300">
            ↻ Regenerate
          </span>
          <span className="text-[10px] text-zinc-500 italic">
            Auto-built prompt from anomalies — edit before applying if needed
          </span>
        </div>
        <button
          onClick={onCancel}
          className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 hover:text-zinc-300"
        >
          Cancel
        </button>
      </header>
      <div className="p-4 space-y-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={Math.min(12, prompt.split("\n").length + 1)}
          className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-[12px] font-mono text-zinc-200 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent resize-y leading-relaxed"
          spellCheck={false}
        />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500">
              Provider
            </span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
            >
              {providersList.map((p) => (
                <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
              ))}
            </select>
            <span className="text-[10px] text-zinc-600 italic">
              · re-runs Enhance with this prompt
            </span>
          </div>
          <button
            onClick={() => onApply({ prompt, provider })}
            className="text-xs uppercase tracking-[0.18em] font-semibold text-white bg-amber-600 hover:bg-amber-500 border border-amber-500 px-4 py-2 rounded transition-colors"
          >
            ↻ Regenerate now
          </button>
        </div>
      </div>
    </section>
  );
}

// ─── The card (the big one) — change A + B together ─────────────────────────

function ScanCard({ scan, onApprove, onReject, onApplyRegen, regenOpenId, setRegenOpenId, detailsOpenId, setDetailsOpenId, approved, rejected }) {
  const consensus = useMemo(() => computeConsensus(scan.providers), [scan]);
  const unified = useMemo(() => unifyAnomalies(scan.providers), [scan]);
  const isScanning = scan.state === "scanning";
  const isApproved = approved.has(scan.id);
  const isRejected = rejected.has(scan.id);
  const regenOpen = regenOpenId === scan.id;
  const detailsOpen = detailsOpenId === scan.id;

  // Card outer state styling — approved/rejected get a subtle wash
  const cardOuter = isApproved
    ? "border-green-800/60 bg-green-950/10 opacity-75"
    : isRejected
      ? "border-zinc-800 bg-zinc-950/40 opacity-50"
      : "border-zinc-800 bg-zinc-950/60";

  return (
    <article className={`rounded-xl border overflow-hidden transition-colors ${cardOuter}`}>
      {/* Header — filename + consensus + actions */}
      <header className="flex items-center justify-between gap-4 px-5 py-3 border-b border-zinc-900 flex-wrap">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="font-mono text-sm text-zinc-200 truncate">{scan.filename}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {!isScanning && <ConsensusPill consensus={consensus} />}
          {isScanning && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-blue-800 bg-blue-950/60 text-blue-300">
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              <span className="text-[11px] font-bold uppercase tracking-[0.18em]">Scanning</span>
            </div>
          )}

          {!isScanning && !isApproved && !isRejected && (
            <div className="flex items-center gap-2">
              {(consensus.verdict === "fail" || consensus.verdict === "mixed") && (
                <button
                  onClick={() => setRegenOpenId(regenOpen ? null : scan.id)}
                  className={`text-xs uppercase tracking-[0.18em] font-semibold transition-colors px-3 py-2 rounded border ${regenOpen
                    ? "text-amber-200 bg-amber-800 border-amber-500"
                    : "text-amber-300 hover:text-white bg-amber-950/40 hover:bg-amber-700 border-amber-800 hover:border-amber-600"}`}
                >
                  ↻ Regenerate
                </button>
              )}
              {consensus.verdict !== "fail" && (
                <button
                  onClick={() => onApprove(scan.id)}
                  className="text-xs uppercase tracking-[0.18em] font-semibold text-white bg-red-600 hover:bg-red-500 border border-red-500 px-3 py-2 rounded transition-colors"
                >
                  Approve →
                </button>
              )}
              <button
                onClick={() => onReject(scan.id)}
                title="Reject — don't ship this image"
                className="text-xs uppercase tracking-[0.18em] font-semibold text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-600 px-3 py-2 rounded transition-colors"
              >
                ✕
              </button>
            </div>
          )}

          {isApproved && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-green-400 px-3 py-2">
              ✓ Approved → Resize
            </span>
          )}
          {isRejected && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500 px-3 py-2">
              ✕ Rejected
            </span>
          )}
        </div>
      </header>

      {/* Body — thumb left, anomalies/progress right */}
      <div className="p-5">
        <div className="grid grid-cols-[160px_1fr] gap-5 items-start">
          <figure className={`relative aspect-square rounded-lg overflow-hidden border border-zinc-800 bg-gradient-to-br ${scan.hue}`}>
            {!isScanning && consensus.verdict === "pass" && (
              <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-green-500 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            )}
            {!isScanning && consensus.verdict === "fail" && (
              <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-red-500 flex items-center justify-center text-white text-base font-bold">
                ✗
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/80 to-transparent">
              <span className="text-[9px] font-mono text-zinc-300">enhanced</span>
            </div>
          </figure>

          <div className="space-y-4 min-w-0">
            {isScanning ? (
              <ScanProgressStrip providers={scan.providers} />
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500">
                      Anomalies — unified across providers
                    </span>
                    {unified.length > 0 && (
                      <span className="text-[10px] text-zinc-600 tabular-nums">
                        {unified.length} issue{unified.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <UnifiedAnomalies unified={unified} totalProviders={consensus.total} />
                </div>

                <ProviderDetail
                  providers={scan.providers}
                  expanded={detailsOpen}
                  onToggle={() => setDetailsOpenId(detailsOpen ? null : scan.id)}
                />
              </>
            )}
          </div>
        </div>

        {/* Inline regen panel — change D */}
        {regenOpen && !isScanning && (
          <div className="mt-4">
            <RegenPanel
              unified={unified}
              providersList={["gemini", "openai", "flux", "reve", "grok"]}
              defaultProvider="gemini"
              onApply={(payload) => onApplyRegen(scan.id, payload)}
              onCancel={() => setRegenOpenId(null)}
            />
          </div>
        )}
      </div>
    </article>
  );
}

// ─── Sticky command bar — change E ──────────────────────────────────────────

function CommandBar({ scans, approved, rejected, threshold, onThreshold, onApproveBulk, autoAdvance }) {
  const eligible = scans.filter((s) => {
    if (approved.has(s.id) || rejected.has(s.id) || s.state !== "complete") return false;
    const c = computeConsensus(s.providers);
    return c && c.verdict === "pass" && c.avgConfidence >= threshold;
  });

  const tallies = useMemo(() => {
    let pass = 0, fail = 0, mixed = 0, scanning = 0;
    for (const s of scans) {
      if (approved.has(s.id) || rejected.has(s.id)) continue;
      if (s.state === "scanning") { scanning++; continue; }
      const c = computeConsensus(s.providers);
      if (!c) continue;
      if (c.verdict === "pass") pass++;
      else if (c.verdict === "fail") fail++;
      else mixed++;
    }
    return { pass, fail, mixed, scanning };
  }, [scans, approved, rejected]);

  return (
    <section className="sticky bottom-0 -mx-6 px-6 py-3 bg-black/95 backdrop-blur border-t border-zinc-900">
      <div className="max-w-screen-2xl mx-auto flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-zinc-400 tabular-nums">{tallies.pass} pass</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-yellow-500" />
            <span className="text-zinc-400 tabular-nums">{tallies.mixed} mixed</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-zinc-400 tabular-nums">{tallies.fail} fail</span>
          </span>
          {tallies.scanning > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500" />
              <span className="text-blue-300 tabular-nums">{tallies.scanning} scanning</span>
            </span>
          )}
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-500 tabular-nums">
            {approved.size} approved · {rejected.size} rejected
          </span>
        </div>

        {/* Confidence threshold + bulk approve */}
        <div className="ml-auto flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500">
              Min confidence
            </span>
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              value={threshold * 100}
              onChange={(e) => onThreshold(Number(e.target.value) / 100)}
              className="w-24 accent-red-500"
            />
            <span className="text-xs font-mono tabular-nums text-zinc-300 w-9 text-right">
              {Math.round(threshold * 100)}%
            </span>
          </label>
          {autoAdvance && (
            <span className="text-[11px] text-zinc-500 italic">
              Auto-advance is on — passes auto-send to Resize
            </span>
          )}
          <button
            onClick={() => onApproveBulk(eligible.map((s) => s.id))}
            disabled={eligible.length === 0}
            className={`text-xs uppercase tracking-[0.18em] font-semibold px-4 py-2 rounded border transition-colors ${eligible.length === 0
              ? "border-zinc-800 bg-zinc-950 text-zinc-700 cursor-not-allowed"
              : "border-red-500 bg-red-600 hover:bg-red-500 text-white"}`}
          >
            Approve {eligible.length} → Resize
          </button>
        </div>
      </div>
    </section>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────

function App() {
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [activeTab, setActiveTab] = useState("scan");
  const [scans] = useState(INITIAL_SCANS);
  const [filter, setFilter] = useState("all");
  const [regenOpenId, setRegenOpenId] = useState(null);
  const [detailsOpenId, setDetailsOpenId] = useState(null);
  const [approved, setApproved] = useState(new Set());
  const [rejected, setRejected] = useState(new Set());
  const [threshold, setThreshold] = useState(0.80);

  const filterCounts = useMemo(() => {
    let pass = 0, fail = 0, mixed = 0, scanning = 0;
    for (const s of scans) {
      if (s.state === "scanning") { scanning++; continue; }
      const c = computeConsensus(s.providers);
      if (!c) continue;
      if (c.verdict === "pass") pass++;
      else if (c.verdict === "fail") fail++;
      else mixed++;
    }
    return { all: scans.length, pass, fail, mixed, scanning };
  }, [scans]);

  const filtered = useMemo(() => {
    if (filter === "all") return scans;
    return scans.filter((s) => {
      if (s.state === "scanning") return filter === "scanning";
      const c = computeConsensus(s.providers);
      return c?.verdict === filter;
    });
  }, [scans, filter]);

  const handleApprove = (id) => {
    setApproved((prev) => new Set(prev).add(id));
  };
  const handleReject = (id) => {
    setRejected((prev) => new Set(prev).add(id));
  };
  const handleApproveBulk = (ids) => {
    setApproved((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  };
  const handleApplyRegen = (id, payload) => {
    setRegenOpenId(null);
    alert(`Regenerating ${id} with ${payload.provider}\n\nPrompt preview:\n\n${payload.prompt.slice(0, 200)}…`);
  };

  const counts = useMemo(() => ({
    scan: scans.length - approved.size - rejected.size,
    resize: approved.size,
  }), [scans, approved, rejected]);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <Header
        autoAdvance={autoAdvance}
        onAutoAdvance={setAutoAdvance}
        activeTab={activeTab}
        onTab={setActiveTab}
        counts={counts}
      />
      <BatchContextStrip make="Toyota" model="8FGU25" count={scans.length} />

      <main className="flex-1 px-6 py-6 space-y-4 max-w-screen-2xl w-full mx-auto">
        {activeTab !== "scan" ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-12 text-center text-sm text-zinc-500">
            <span className="uppercase tracking-[0.18em] font-semibold text-zinc-400">{activeTab}</span>
            <p className="mt-2 text-xs text-zinc-600">Tab stub — mockup focuses on the redesigned Scan flow.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-[0.18em]">
                Scan results — {scans.length} image{scans.length !== 1 ? "s" : ""}
              </h2>
              <FilterChips counts={filterCounts} active={filter} onChange={setFilter} />
            </div>

            <div className="space-y-3 pb-4">
              {filtered.map((s) => (
                <ScanCard
                  key={s.id}
                  scan={s}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onApplyRegen={handleApplyRegen}
                  regenOpenId={regenOpenId}
                  setRegenOpenId={setRegenOpenId}
                  detailsOpenId={detailsOpenId}
                  setDetailsOpenId={setDetailsOpenId}
                  approved={approved}
                  rejected={rejected}
                />
              ))}
              {filtered.length === 0 && (
                <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/30 p-12 text-center text-sm text-zinc-500">
                  No images match the <span className="uppercase tracking-[0.18em] text-zinc-400 font-semibold">{filter}</span> filter.
                </div>
              )}
            </div>

            <CommandBar
              scans={scans}
              approved={approved}
              rejected={rejected}
              threshold={threshold}
              onThreshold={setThreshold}
              onApproveBulk={handleApproveBulk}
              autoAdvance={autoAdvance}
            />
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
