// apps/web/components/workspace/BatchContextStrip.tsx
// One-line "what am I working on" strip rendered between the Header/TabBar
// and the active panel's body. Shown on the Enhance tab only; the Scan and
// Resize tabs have their own contextual cues.
//
// Reads from the lifted forklift metadata + the current batch size so the
// operator can verify at a glance which set of images they're about to
// process — the batch ID format matches the filename convention used by
// `buildEnhanceFilename` in `lib/compress.ts`.

interface BatchContextStripProps {
  /** Forklift make from the lifted Workspace state. */
  make?: string;
  /** Forklift model from the lifted Workspace state. */
  model?: string;
  /** Number of source images currently loaded into the Enhance tab. */
  count: number;
}

export function BatchContextStrip({ make, model, count }: BatchContextStripProps) {
  const today = new Date().toISOString().slice(0, 10);
  const makePart  = (make  ?? "").trim().toUpperCase()  || "—";
  const modelPart = (model ?? "").trim().toUpperCase() || "—";

  return (
    <div className="border-b border-zinc-900 bg-zinc-950/40">
      <div className="px-6 py-2 max-w-screen-2xl mx-auto flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-600">
          Batch
        </span>
        <span className="font-mono text-xs text-zinc-300">
          {today}_{makePart}_{modelPart}
        </span>
        <span className="text-zinc-700">·</span>
        <span className="text-xs text-zinc-400 tabular-nums">
          {count} image{count !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}
