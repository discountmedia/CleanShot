// apps/web/lib/inline-scan.ts
//
// Reads the AUTO-ENQUEUED scan for each enhance output so the Enhance tab can
// render scan verdicts inline, next to the variant they belong to.
//
// The key fact this module is built on: the enhance worker ALREADY enqueues a
// differential (before/after) scan for every completed variant — see
// `enqueue_scan` at the end of `_run_enhance` in enhance_worker.py. Nothing
// here starts a scan. Enqueuing our own from the browser would double the AI
// spend on every batch for results the backend is already producing.
//
// Discovery works off the session read, which returns `jobs` (each scan job
// carries `input_asset_id` = the enhance OUTPUT asset) and `scan_results`
// (each row carries `asset_id`, the same id). So a single session GET resolves
// the scan state of every variant in the batch at once, and each variant's
// result surfaces the moment its own scan lands — one slow or failed scan
// never holds up, or fails, the others.

import type { ProviderScanResult, ScanProvider, ScanVerdict } from "./types";

/** Per-variant scan state, keyed in the panel by the variant's output asset id. */
export interface InlineScanState {
  /** "waiting" = the scan job exists and hasn't finished; results may be partial. */
  status: "waiting" | "done" | "failed";
  /** Whatever providers have landed so far. Grows as the fan-out completes. */
  providerResults: ProviderScanResult[];
  /** Set when the scan JOB itself errored (not a per-provider fail verdict). */
  error?: string;
  /**
   * Ms timestamp of the scan job's createdAt, so the Enhance tab can drive the
   * same elapsed-vs-expected progress bars the Scan tab uses. Null when the
   * job row carried no parseable timestamp.
   */
  startedMs: number | null;
}

// The snake_case slices of FastAPI's SessionState we actually consume. Declared
// locally rather than widening ServerSessionState, which is the import-hydration
// contract and has no business growing scan fields.
interface RawJob {
  id: string;
  operation: string;
  status: string;
  input_asset_id: string;
  error?: string | null;
  created_at?: string | null;
}

interface RawScanResult {
  asset_id: string;
  provider: string;
  verdict: string;
  confidence: number;
  anomalies: unknown[];
  summary: string;
  latency_ms: number;
}

interface RawSessionScanState {
  jobs?: RawJob[];
  scan_results?: RawScanResult[];
}

const SCAN_PROVIDERS = new Set<string>(["gemini", "openai", "anthropic"]);
const VERDICTS = new Set<string>(["pass", "fail"]);

/**
 * Fold a raw session payload into { outputAssetId → InlineScanState }, limited
 * to the asset ids the caller cares about (the batch's completed variants).
 *
 * An asset with no scan job yet simply doesn't appear in the map — the caller
 * renders nothing rather than a misleading "waiting" for a scan that may never
 * have been enqueued (standalone / legacy assets).
 */
export function readInlineScans(
  payload: unknown,
  assetIds: Iterable<string>,
): Map<string, InlineScanState> {
  const wanted = new Set(assetIds);
  const out = new Map<string, InlineScanState>();
  if (wanted.size === 0) return out;

  const state = (payload ?? {}) as RawSessionScanState;

  for (const job of state.jobs ?? []) {
    if (job.operation !== "scan") continue;
    if (!wanted.has(job.input_asset_id)) continue;
    // A given asset can accumulate more than one scan job over a session
    // (re-scan, regen). Last one wins — `get_jobs_for_session` returns them in
    // creation order, so the final write is the newest.
    const startedMs = job.created_at ? new Date(job.created_at).getTime() : NaN;
    out.set(job.input_asset_id, {
      status:
        job.status === "failed"
          ? "failed"
          : job.status === "complete"
            ? "done"
            : "waiting",
      providerResults: [],
      error: job.status === "failed" ? (job.error ?? "Scan failed") : undefined,
      startedMs: Number.isFinite(startedMs) ? startedMs : null,
    });
  }

  for (const row of state.scan_results ?? []) {
    const entry = out.get(row.asset_id);
    if (!entry) continue;
    if (!SCAN_PROVIDERS.has(row.provider) || !VERDICTS.has(row.verdict)) continue;
    // De-dupe by provider so a re-scan's rows replace the prior pass rather
    // than showing the same provider twice.
    const next = entry.providerResults.filter((r) => r.provider !== row.provider);
    next.push({
      provider:   row.provider as ScanProvider,
      verdict:    row.verdict as ScanVerdict,
      confidence: row.confidence,
      anomalies:  (row.anomalies ?? []) as ProviderScanResult["anomalies"],
      summary:    row.summary,
      latencyMs:  row.latency_ms,
    });
    entry.providerResults = next;
  }

  return out;
}

/** True while at least one variant is still waiting on its scan. */
export function anyScanPending(scans: Map<string, InlineScanState>): boolean {
  for (const s of scans.values()) {
    if (s.status === "waiting") return true;
  }
  return false;
}
