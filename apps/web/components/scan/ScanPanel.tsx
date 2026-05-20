"use client";
// apps/web/components/scan/ScanPanel.tsx
//
// Scan tab — Phase 2 v2.5
//
// Displays per-image scan results from up to 3 AI providers:
//   • gemini-2.5-flash  — primary, always active
//   • gpt-5.4 (OpenAI Responses API)  — optional, SCAN_PROVIDER_OPENAI=true
//   • claude-sonnet-4-6 / opus-4.7   — optional, SCAN_PROVIDER_ANTHROPIC=true
//
// ─── CRITICAL API FORMAT DIFFERENCES (DO NOT MIX UP) ───────────────────────
//
//  Gemini (backend):
//    client.aio.models.generate_content(
//      model='gemini-2.5-flash',
//      contents=[{'role':'user','parts':[
//        {'inline_data': {'mime_type': media_type, 'data': image_b64}},  ← raw base64
//        {'text': SCAN_SYSTEM_PROMPT}
//      ]}],
//      config=types.GenerateContentConfig(
//        response_mime_type='application/json',
//        response_schema=ScanResult,
//      ),
//    )
//
//  OpenAI gpt-5.4 (backend):
//    client.responses.parse(                        ← Responses API, NOT chat.completions
//      model='gpt-5.4',
//      input=[{'role':'user','content':[
//        {'type':'input_image',
//         'image_url': f'data:{media_type};base64,{b64}',  ← WITH "data:…;base64," PREFIX
//         'detail': 'high'},
//        {'type':'input_text', 'text': SCAN_SYSTEM_PROMPT}
//      ]}],
//      text={'format': {'type':'json_schema', 'name':'ScanResult',
//                       'schema': ScanResult.model_json_schema(), 'strict': True}},
//    )
//
//  Anthropic claude-sonnet-4-6 (backend):
//    client.messages.create(
//      model='claude-sonnet-4-6',    ← or 'claude-opus-4-7' for hard scans
//      messages=[{'role':'user','content':[
//        {'type':'image','source':{
//          'type':'base64',
//          'media_type': media_type,
//          'data': image_b64,         ← raw base64, NO "data:…;base64," PREFIX
//        }},
//        {'type':'text','text': SCAN_SYSTEM_PROMPT}
//      ]}],
//      output_config={'format': {'type':'json_schema',   ← GA structured output (NOT legacy messages.parse)
//                                'schema': ScanResult.model_json_schema()}},
//    )
//
// These format differences are handled entirely on the FastAPI side.
// This component only reads the results from the BFF polling endpoint.
// ──────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import {
  getAssetUrl,
  enqueueScanBatch,
  enqueueRegen,
} from "../../lib/api";
import { useJobPoller } from "../../lib/polling";
import type {
  AnomalyItem,
  ImageScanState,
  JobRecord,
  ProviderScanResult,
  ScanProvider,
  ScanVerdict,
} from "../../lib/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<ScanProvider, string> = {
  gemini:    "Gemini",
  openai:    "OpenAI",
  anthropic: "Anthropic",
};

const PROVIDER_COLORS: Record<ScanProvider, string> = {
  gemini:    "text-blue-400 bg-blue-950/60 border-blue-800",
  openai:    "text-green-400 bg-green-950/60 border-green-800",
  anthropic: "text-orange-400 bg-orange-950/60 border-orange-800",
};

// The three providers we render placeholder progress cards for while a scan
// is in flight. Matches the worker's fan-out (gemini + openai + anthropic),
// which is gated server-side by SCAN_PROVIDER_OPENAI / SCAN_PROVIDER_ANTHROPIC
// env flags — if one is disabled there it just won't produce a result and
// the placeholder will sit until job completion. Considered acceptable since
// production has both flags enabled (see deploy-api.yml).
const EXPECTED_SCAN_PROVIDERS: readonly ScanProvider[] = ["gemini", "openai", "anthropic"] as const;

const SEVERITY_COLORS: Record<string, string> = {
  high:   "text-red-400 bg-red-950/60 border-red-800",
  medium: "text-yellow-400 bg-yellow-950/60 border-yellow-800",
  low:    "text-zinc-400 bg-zinc-900/60 border-zinc-700",
};

// ─── Auto-prompt builder ─────────────────────────────────────────────────────

function buildRegenPrompt(results: ProviderScanResult[]): string {
  // Collect all anomalies across providers, deduplicated by type+location
  const seen = new Set<string>();
  const anomalies: AnomalyItem[] = [];

  for (const r of results) {
    for (const a of r.anomalies) {
      const key = `${a.type}:${a.location}`;
      if (!seen.has(key)) {
        seen.add(key);
        anomalies.push(a);
      }
    }
  }

  // Scene-preservation guardrails are duplicated here (loose mirror of the
  // backend's _build_enhance_prompt block) because the regen path sends a
  // verbatim custom_prompt that bypasses the worker's wrapper. Without
  // these lines Gemini strips the scene to a blank studio backdrop —
  // user-reported failure mode 2026-05-19.
  const GUARDRAILS = [
    "GUARDRAILS — keep identical to the source:",
    "• Background, location, floor, walls, surroundings — keep the exact same scene. Do NOT isolate the forklift on a white / studio / gradient backdrop.",
    "• Lighting direction, ambient colour, and shadow placement — keep the scene's original lighting character (do NOT replace with studio lighting).",
    "• Camera angle, framing, distance, and proportions — no zoom, crop, rotate, or re-pose.",
    "• Make, model, year, mast configuration, fork count, fork length, overhead guard, counterweight, and tire type.",
    "• Same tires — same tread, sidewall, wear profile. Refresh appearance only; do not swap for new tires.",
    "• Do NOT add lamps, beacons, mirrors, antennas, attachments, or any bolt-on hardware that is not in the source.",
    "• All OEM decals, capacity plates, VIN / serial numbers, model badges, and data tags remain present, legible, and unchanged.",
    "• Do not introduce damage, rust, dents, or wear that was not in the source.",
  ];

  if (anomalies.length === 0) {
    return [
      "Improve the overall presentation of this USED forklift photograph while keeping it clearly the same used machine in the same place — light tonal correction, sharper decals, dressed tires.",
      "",
      ...GUARDRAILS,
    ].join("\n");
  }

  const lines = anomalies
    .sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.severity] ?? 2) - (order[b.severity] ?? 2);
    })
    .map((a) => `• Fix [${a.severity.toUpperCase()}] ${a.type} at ${a.location}: ${a.description}`);

  return [
    "You are editing a photograph of a USED forklift to address SPECIFIC issues detected by AI scan. Fix the listed issues while leaving the rest of the image exactly as-is — same machine, same place, same lighting.",
    "",
    "ISSUES TO ADDRESS:",
    ...lines,
    "",
    ...GUARDRAILS,
  ].join("\n");
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function VerdictBadge({ verdict, confidence }: { verdict: ScanVerdict; confidence: number }) {
  const isPassed = verdict === "pass";
  return (
    <span
      className={`
        inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border
        ${isPassed
          ? "text-green-400 bg-green-950/60 border-green-800"
          : "text-red-400 bg-red-950/60 border-red-800"}
      `}
      aria-label={`${isPassed ? "Pass" : "Fail"} — ${Math.round(confidence * 100)}% confidence`}
    >
      {isPassed ? "✓ PASS" : "✗ FAIL"}
      <span className="text-[10px] opacity-75">{Math.round(confidence * 100)}%</span>
    </span>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 80 ? "bg-green-500" :
    pct >= 50 ? "bg-yellow-500" :
                "bg-red-500";
  return (
    <div className="flex items-center gap-2" aria-label={`Confidence: ${pct}%`}>
      <div className="flex-1 bg-zinc-800 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-zinc-500 w-7 text-right">{pct}%</span>
    </div>
  );
}

function AnomalyList({ anomalies }: { anomalies: AnomalyItem[] }) {
  if (anomalies.length === 0) {
    return <p className="text-xs text-zinc-600 italic">No anomalies detected</p>;
  }
  return (
    <ul className="space-y-1.5" role="list" aria-label="Detected anomalies">
      {anomalies.map((a, i) => (
        <li
          key={i}
          className={`text-xs px-2.5 py-1.5 rounded border ${SEVERITY_COLORS[a.severity] ?? SEVERITY_COLORS.low}`}
        >
          <span className="font-medium capitalize">{a.type}</span>
          {" — "}
          <span className="opacity-75">{a.location}</span>
          {": "}
          {a.description}
        </li>
      ))}
    </ul>
  );
}

/**
 * Placeholder card rendered while the scan job is still in flight.
 * One per expected provider, with an indeterminate progress bar so the user
 * can see all three are running in parallel. Replaced by a ProviderResultCard
 * once the real verdict arrives.
 *
 * The bar is purely indeterminate (CSS keyframes) — the worker fans out to
 * all three providers concurrently and only writes results when the whole
 * job is done, so we have no per-provider milestone to report. The visual
 * still tells the operator "all three are working."
 */
function ProviderProgressCard({ provider }: { provider: ScanProvider }) {
  return (
    <div className={`rounded-lg border overflow-hidden ${PROVIDER_COLORS[provider]}`}>
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <svg
            className="animate-spin w-3.5 h-3.5 opacity-80"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          <span className="text-xs font-semibold">{PROVIDER_LABELS[provider]}</span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.16em] opacity-60">
          Scanning…
        </span>
      </div>
      <div
        className="h-1 bg-current bg-opacity-10 overflow-hidden"
        role="progressbar"
        aria-label={`${PROVIDER_LABELS[provider]} scan in progress`}
      >
        <div className="h-full w-1/3 bg-current opacity-70 animate-[scanbar_1.2s_ease-in-out_infinite]" />
      </div>
    </div>
  );
}

function ProviderResultCard({
  result,
  provider,
}: {
  result: ProviderScanResult;
  provider: ScanProvider;
}) {
  const [expanded, setExpanded] = useState(result.verdict === "fail");

  return (
    <div className={`rounded-lg border overflow-hidden ${PROVIDER_COLORS[provider]}`}>
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:opacity-80 transition-opacity"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">{PROVIDER_LABELS[provider]}</span>
          <VerdictBadge verdict={result.verdict} confidence={result.confidence} />
        </div>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-current border-opacity-20">
          <ConfidenceMeter value={result.confidence} />
          <p className="text-xs opacity-80 italic">{result.summary}</p>
          <AnomalyList anomalies={result.anomalies} />
          <p className="text-[10px] opacity-40 text-right">{result.latencyMs}ms</p>
        </div>
      )}
    </div>
  );
}

// ─── Per-image card with regen ────────────────────────────────────────────────

function ImageScanCard({
  scan,
  sessionId,
  sent,
  onRegenComplete,
  onSend,
}: {
  scan: ImageScanState;
  sessionId: string;
  /** True once the user has already sent this scan to the Resize tab. */
  sent: boolean;
  onRegenComplete: (scan: ImageScanState, outputAssetId: string) => void;
  /**
   * Per-card "Send to Resize" handler. The card supplies the most-recent
   * asset id + URL — the regen output when one exists, otherwise the
   * enhanced original that came from the Enhance tab.
   */
  onSend: (item: {
    assetId: string;
    filename: string;
    thumbnailUrl: string;
    outputUrl?: string;
  }) => void;
}) {
  const [regenJobId, setRegenJobId]   = useState<string | null>(scan.regenJobId ?? null);
  const [regenStatus, setRegenStatus] = useState<string>(scan.regenStatus ?? "idle");
  const [regenUrl, setRegenUrl]       = useState<string | null>(null);
  // Track the regen output asset id locally so "Send to Resize" can hand
  // it up instead of the original enhanced asset when a regen has run.
  const [regenAssetId, setRegenAssetId] = useState<string | null>(null);
  const [promptText, setPromptText]   = useState<string>(
    scan.regenPrompt ?? buildRegenPrompt(scan.providerResults)
  );
  const [showPrompt, setShowPrompt]   = useState(false);
  const [regenError, setRegenError]   = useState<string | null>(null);

  // Poll regen job
  useJobPoller(
    regenJobId,
    (job) => setRegenStatus(job.status),
    async (job) => {
      setRegenStatus("complete");
      if (job.outputAssetId) {
        try {
          const { url } = await getAssetUrl(job.outputAssetId);
          setRegenUrl(url);
          setRegenAssetId(job.outputAssetId);
          onRegenComplete(scan, job.outputAssetId);
        } catch {
          setRegenError("Could not fetch regenerated image URL");
        }
      }
    },
    (job) => {
      setRegenStatus("failed");
      setRegenError(job.error ?? "Regeneration failed");
    }
  );

  const handleRegen = async () => {
    setRegenError(null);
    setRegenStatus("enqueuing");
    try {
      const { jobId } = await enqueueRegen({
        sessionId,
        assetId: scan.assetId,
        regenPrompt: promptText,
        idempotencyKey: `regen-${scan.assetId}-${uuidv4()}`,
      });
      setRegenJobId(jobId);
      setRegenStatus("queued");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to start regeneration";
      setRegenError(msg);
      setRegenStatus("idle");
    }
  };

  const hasFailedProvider = scan.providerResults.some((r) => r.verdict === "fail");
  const isRegening = ["enqueuing", "queued", "processing"].includes(regenStatus);

  // Consensus display
  const consensus = scan.consensusVerdict;
  const consensusColor =
    consensus === "pass"  ? "text-green-400 border-green-800 bg-green-950/30" :
    consensus === "fail"  ? "text-red-400 border-red-800 bg-red-950/30" :
    consensus === "split" ? "text-yellow-400 border-yellow-800 bg-yellow-950/30" :
                            "text-zinc-400 border-zinc-700 bg-zinc-900/30";

  return (
    <article
      className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden"
      aria-label={`Scan result for ${scan.filename}`}
    >
      {/* Header row — filename + consensus pill */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-900 gap-3">
        <p className="text-sm font-mono text-zinc-200 truncate flex-1" title={scan.filename}>
          {scan.filename}
        </p>
        {consensus && (
          <div className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold ${consensusColor}`}>
            {consensus === "pass"  ? "✓ PASS" :
             consensus === "fail"  ? "✗ FAIL" :
                                     "⚡ SPLIT"}
            {scan.consensusConfidence !== undefined && (
              <span className="opacity-60 text-[10px]">
                {Math.round(scan.consensusConfidence * 100)}%
              </span>
            )}
          </div>
        )}
      </div>

      {/* Single large image — the thing being scanned. scan.thumbnailUrl
          is already the enhanced version (sent from the Enhance tab); when
          a regen runs, regenUrl supersedes it. No "original" pair — the
          user just wants to see the image the AI is actually judging. */}
      {(() => {
        const displayUrl = regenUrl ?? scan.thumbnailUrl;
        const isRegen   = !!regenUrl;
        return (
          <figure className="flex flex-col gap-2 p-5 pb-3">
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500">
              {isRegen ? "Regenerated" : "Enhanced"}
            </span>
            <a href={displayUrl} target="_blank" rel="noopener noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={displayUrl}
                alt={`${isRegen ? "Regenerated" : "Enhanced"}: ${scan.filename}`}
                className={`w-full aspect-square object-contain bg-black rounded-lg border transition-colors ${
                  isRegen
                    ? "border-amber-900 hover:border-amber-700"
                    : "border-zinc-800 hover:border-zinc-600"
                }`}
              />
            </a>
          </figure>
        );
      })()}

      {/* Provider verdicts */}
      <div className="px-5 pb-4">
        <div className="space-y-1.5">
          {scan.providerResults.length === 0 ? (
            EXPECTED_SCAN_PROVIDERS.map((p) => (
              <ProviderProgressCard key={p} provider={p} />
            ))
          ) : (
            scan.providerResults.map((r) => (
              <ProviderResultCard key={r.provider} result={r} provider={r.provider} />
            ))
          )}
        </div>
      </div>

      {/* Regenerate section — shown when at least one provider failed */}
      {hasFailedProvider && (
        <div className="border-t border-zinc-800 bg-zinc-900/50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Regenerate this image</span>
            <button
              onClick={() => setShowPrompt((v) => !v)}
              className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              {showPrompt ? "Hide prompt" : "Edit prompt"}
            </button>
          </div>

          {/* Auto-generated prompt (editable) */}
          {showPrompt && (
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              rows={4}
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-300 font-mono resize-y focus:outline-none focus:ring-1 focus:ring-blue-500"
              aria-label="Regeneration prompt"
            />
          )}

          {regenError && (
            <p className="text-xs text-red-400" role="alert">{regenError}</p>
          )}

          {regenStatus === "complete" && (
            <p className="text-xs text-green-400">✓ Regeneration complete — see updated preview above</p>
          )}

          <button
            onClick={handleRegen}
            disabled={isRegening}
            className={`
              w-full py-2 px-4 rounded-lg text-xs font-semibold transition-all
              ${isRegening
                ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                : "bg-amber-600 hover:bg-amber-500 text-white"}
            `}
            aria-busy={isRegening}
          >
            {isRegening ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                {regenStatus === "enqueuing" ? "Enqueuing…" : "Regenerating…"}
              </span>
            ) : (
              "↻ Regenerate Image"
            )}
          </button>
        </div>
      )}

      {/* Send-to-Resize footer — always shown so the operator can hand
          off whichever scans they want to size, regardless of pass/fail
          verdict. Sends the regen output when one exists, otherwise the
          original enhanced asset from the Enhance tab. */}
      <div className="border-t border-zinc-800 bg-zinc-900/50 p-3 flex items-center justify-end gap-2">
        {sent ? (
          <span className="text-xs uppercase tracking-[0.18em] font-semibold text-zinc-500 px-3 py-2">
            ✓ Sent to Resize
          </span>
        ) : (
          <button
            onClick={() =>
              onSend({
                assetId:      regenAssetId ?? scan.assetId,
                filename:     scan.filename,
                thumbnailUrl: regenUrl ?? scan.thumbnailUrl,
                outputUrl:    regenUrl ?? scan.outputUrl,
              })
            }
            className="text-xs uppercase tracking-[0.18em] font-semibold text-white bg-red-600 hover:bg-red-500 border border-red-500 transition-colors px-3 py-2 rounded"
          >
            Send to Resize →
          </button>
        )}
      </div>
    </article>
  );
}

// ─── Main Scan Panel ─────────────────────────────────────────────────────────

export interface ScanPanelProps {
  sessionId: string;
  enhancedAssets: Array<{ assetId: string; filename: string; thumbnailUrl: string; outputUrl?: string }>;
  onScanComplete?: (scans: ImageScanState[]) => void;
  /**
   * Called by "Reset scan" — wipes the workspace's enhancedAssets pipeline
   * so the next "Scan all" doesn't include images the user already
   * dismissed. The local scanStates / batchJobIds reset happens inline.
   */
  onClearPipeline: () => void;
  /**
   * Called when the user explicitly clicks "Send to Resize" (per-card) or
   * "Send all to Resize" (batch). The workspace appends to its
   * resizeAssets pipeline and switches to the Resize tab. Sends the
   * latest version of the image (regen output if a regen has run,
   * otherwise the enhanced thumbnail URL).
   */
  onSendToResize: (items: Array<{ assetId: string; filename: string; thumbnailUrl: string; outputUrl?: string }>) => void;
}

export function ScanPanel({
  sessionId,
  enhancedAssets,
  onScanComplete,
  onClearPipeline,
  onSendToResize,
}: ScanPanelProps) {
  const [scanStates, setScanStates] = useState<ImageScanState[]>([]);
  const [batchJobIds, setBatchJobIds] = useState<string[]>([]);
  const [scanError, setScanError]     = useState<string | null>(null);

  // Track which scan asset IDs the user has already pushed to the Resize
  // tab so the per-card button shows "✓ Sent" and the batch button knows
  // who's left. Keyed by scan.assetId (the original enhanced asset id) —
  // the card itself decides whether to send regen or original payload.
  const [sentToResizeAssetIds, setSentToResizeAssetIds] = useState<Set<string>>(new Set());

  const sendOneToResize = useCallback(
    (item: { assetId: string; filename: string; thumbnailUrl: string; outputUrl?: string }, scanAssetId: string) => {
      if (sentToResizeAssetIds.has(scanAssetId)) return;
      onSendToResize([item]);
      setSentToResizeAssetIds((prev) => new Set(prev).add(scanAssetId));
    },
    [onSendToResize, sentToResizeAssetIds]
  );

  const unsentScans = scanStates.filter(
    (s) => s.providerResults.length > 0 && !sentToResizeAssetIds.has(s.assetId)
  );

  const sendAllToResize = useCallback(() => {
    if (unsentScans.length === 0) return;
    onSendToResize(
      unsentScans.map((s) => ({
        assetId:      s.assetId,
        filename:     s.filename,
        thumbnailUrl: s.thumbnailUrl,
        outputUrl:    s.outputUrl,
      }))
    );
    setSentToResizeAssetIds((prev) => {
      const next = new Set(prev);
      for (const s of unsentScans) next.add(s.assetId);
      return next;
    });
  }, [onSendToResize, unsentScans]);

  // isScanning is derived: a scan is active iff we have states and at least
  // one of them hasn't received any provider results yet (and we haven't
  // errored out trying to start the batch).
  const isScanning =
    !scanError &&
    scanStates.length > 0 &&
    scanStates.some((s) => s.providerResults.length === 0);

  // ─── Poll each scan job and merge results ─────────────────────────────────

  const updateScanState = useCallback((assetId: string, patch: Partial<ImageScanState>) => {
    setScanStates((prev) =>
      prev.map((s) => (s.assetId === assetId ? { ...s, ...patch } : s))
    );
  }, []);

  // ─── Fetch scan results for a completed job ───────────────────────────────

  const fetchScanResults = useCallback(async (job: JobRecord) => {
    // The BFF /api/jobs/:id returns the job record.
    // Scan results are fetched from /api/sessions/:id (full state)
    // or from a dedicated /api/scan-results/:jobId endpoint.
    // For now we pull them via the session state which includes all scan_results.
    // A dedicated endpoint is cleaner — wire up when backend route is confirmed.
    // TODO: replace with /api/scan/results/:jobId once backend route is added.
    try {
      const res = await fetch(`/api/scan/results/${job.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json() as {
        providerResults: ProviderScanResult[];
        consensusVerdict?: string;
        consensusConfidence?: number;
      };
      const assetId = job.inputAssetId;
      updateScanState(assetId, {
        providerResults: data.providerResults,
        consensusVerdict: data.consensusVerdict as ImageScanState["consensusVerdict"],
        consensusConfidence: data.consensusConfidence,
        regenPrompt: buildRegenPrompt(data.providerResults),
      });
    } catch {
      // Non-fatal: state stays with empty providerResults
    }
  }, [updateScanState]);

  // ─── Start scan batch ─────────────────────────────────────────────────────

  const handleStartScan = async () => {
    if (enhancedAssets.length === 0) return;
    setScanError(null);

    // Initialise scan states
    const initial: ImageScanState[] = enhancedAssets.map((a) => ({
      assetId: a.assetId,
      inputJobId: "",
      filename: a.filename,
      thumbnailUrl: a.thumbnailUrl,
      outputUrl: a.outputUrl,
      providerResults: [],
    }));
    setScanStates(initial);

    try {
      const { jobIds } = await enqueueScanBatch({
        sessionId,
        assetIds: enhancedAssets.map((a) => a.assetId),
        idempotencyKey: `scan-batch-${uuidv4()}`,
      });
      setBatchJobIds(jobIds);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to start scan";
      setScanError(msg);
    }
  };

  // ─── One poller per job ───────────────────────────────────────────────────
  // We spawn individual pollers via a child component to keep hook rules clean.

  const handleJobComplete = useCallback(
    (job: JobRecord) => fetchScanResults(job),
    [fetchScanResults]
  );

  const handleJobError = useCallback((job: JobRecord) => {
    const assetId = job.inputAssetId;
    updateScanState(assetId, {
      providerResults: [
        {
          provider: "gemini",
          verdict: "fail",
          confidence: 0,
          anomalies: [],
          summary: job.error ?? "Scan failed",
          latencyMs: 0,
        },
      ],
    });
  }, [updateScanState]);

  // ─── Regen complete ───────────────────────────────────────────────────────

  const handleRegenComplete = useCallback(
    (_scan: ImageScanState, outputAssetId: string) => {
      // Caller can re-scan the new asset; for now just note it
      console.info("Regen complete for", outputAssetId);
    },
    []
  );

  // ─── Notify parent when all scans have results (once per batch) ───────────

  const completedRef = useRef(false);
  const allDone =
    scanStates.length > 0 &&
    scanStates.every((s) => s.providerResults.length > 0);

  useEffect(() => {
    if (allDone && !completedRef.current) {
      completedRef.current = true;
      onScanComplete?.(scanStates);
    } else if (!allDone) {
      completedRef.current = false;
    }
  }, [allDone, scanStates, onScanComplete]);

  const passCount = scanStates.filter((s) =>
    s.providerResults.some((r) => r.verdict === "pass") &&
    s.providerResults.every((r) => r.verdict === "pass")
  ).length;
  const failCount = scanStates.filter((s) =>
    s.providerResults.some((r) => r.verdict === "fail")
  ).length;

  return (
    <div className="space-y-6">

      {/* ── Scan trigger ── */}
      {scanStates.length === 0 && (
        <div className="text-center space-y-4 py-8">
          <div className="text-zinc-500 space-y-1">
            <p className="text-sm">
              {enhancedAssets.length > 0
                ? `${enhancedAssets.length} enhanced image${enhancedAssets.length !== 1 ? "s" : ""} ready to scan`
                : "No enhanced images yet — complete the Enhance step first"}
            </p>
            <p className="text-xs text-zinc-700">
              Scans with{" "}
              <code className="font-mono">gemini-2.5-flash</code>
              {" "}· OpenAI{" "}
              <code className="font-mono">gpt-5.4</code>
              {" "}· Anthropic{" "}
              <code className="font-mono">claude-sonnet-4-6</code>
            </p>
          </div>

          {scanError && (
            <p className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3" role="alert">
              {scanError}
            </p>
          )}

          <button
            onClick={handleStartScan}
            disabled={enhancedAssets.length === 0 || isScanning}
            className={`
              px-8 py-3 rounded-xl font-semibold text-sm transition-all
              ${enhancedAssets.length > 0 && !isScanning
                ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40"
                : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}
            `}
          >
            {isScanning ? "Scanning…" : `Scan ${enhancedAssets.length} Image${enhancedAssets.length !== 1 ? "s" : ""}`}
          </button>
        </div>
      )}

      {/* ── Results header ── */}
      {scanStates.length > 0 && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h3 className="text-sm font-semibold text-zinc-200">
              {scanStates.length} image{scanStates.length !== 1 ? "s" : ""} scanned
            </h3>
            {passCount > 0 && (
              <span className="text-xs text-green-400 font-medium">✓ {passCount} passed</span>
            )}
            {failCount > 0 && (
              <span className="text-xs text-red-400 font-medium">✗ {failCount} failed</span>
            )}
          </div>
          <button
            onClick={() => {
              // Wipe local scan state AND tell the workspace to drop the
              // enhancedAssets pipeline — otherwise a fresh "Scan all"
              // would re-scan the same images the user just dismissed.
              setScanStates([]);
              setBatchJobIds([]);
              setScanError(null);
              setSentToResizeAssetIds(new Set());
              onClearPipeline();
            }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Reset scan
          </button>
        </div>
      )}

      {/* ── Per-image cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {scanStates.map((scan, i) => (
          <div key={scan.assetId}>
            {/* Mount a hidden poller for each job */}
            {batchJobIds[i] && (
              <ScanJobPoller
                jobId={batchJobIds[i]}
                onComplete={handleJobComplete}
                onError={handleJobError}
              />
            )}
            <ImageScanCard
              scan={scan}
              sessionId={sessionId}
              sent={sentToResizeAssetIds.has(scan.assetId)}
              onRegenComplete={handleRegenComplete}
              onSend={(item) => sendOneToResize(item, scan.assetId)}
            />
          </div>
        ))}
      </div>

      {/* ── Send-all-to-Resize batch button ── */}
      {scanStates.some((s) => s.providerResults.length > 0) && (
        <button
          onClick={sendAllToResize}
          disabled={unsentScans.length === 0}
          className={`
            w-full py-4 px-6 rounded-xl font-bold text-sm uppercase tracking-[0.18em] transition-all border-2
            ${unsentScans.length > 0
              ? "bg-red-600 hover:bg-red-500 border-red-500 text-white shadow-lg shadow-red-900/40"
              : "bg-zinc-900 border-zinc-800 text-zinc-600 cursor-not-allowed"}
          `}
        >
          {unsentScans.length > 0
            ? <>Send {unsentScans.length} image{unsentScans.length !== 1 ? "s" : ""} to Resize tab →</>
            : <>✓ All sent to Resize</>}
        </button>
      )}

      {/* ── Model attribution ── */}
      {scanStates.length > 0 && (
        <p className="text-[11px] text-zinc-700 text-center">
          Primary scan:{" "}
          <code className="font-mono">gemini-2.5-flash</code>
          {" "}· Additional providers active when enabled on backend
        </p>
      )}
    </div>
  );
}

// ─── Headless poller component ────────────────────────────────────────────────
// Mounts a useJobPoller per scan job without violating hook rules.

function ScanJobPoller({
  jobId,
  onComplete,
  onError,
}: {
  jobId: string;
  onComplete: (job: JobRecord) => void;
  onError: (job: JobRecord) => void;
}) {
  useJobPoller(jobId, () => {}, onComplete, onError);
  return null;
}
