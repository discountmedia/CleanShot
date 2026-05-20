"use client";
// apps/web/components/scan/ScanPanel.tsx
// Scan tab — Phase 3 redesign.
//
// Layout (top to bottom):
//   1. Standalone upload zone (unchanged — Scan as a stand-alone QC tool)
//   2. "Scan N Images" trigger (unchanged)
//   3. Results header — filter chips + total count
//   4. ScanCard stack — one card per scanned image, consensus-first
//   5. ScanCommandBar — sticky bottom with verdict tallies, threshold
//      slider, and a single "Approve N → Resize" CTA
//
// Per-image regen is now an inline `RegenPanel` that opens under a card
// when the operator clicks ↻ Regenerate. Only one regen panel is open at
// a time, owned by `regenOpenId` here.
//
// ─── CRITICAL API FORMAT DIFFERENCES (BACKEND, FOR REFERENCE) ─────────────
//
//  Gemini:    client.aio.models.generate_content(model='gemini-2.5-flash',
//             contents=[image, system_prompt], config=GenerateContentConfig(
//               response_mime_type='application/json', response_schema=ScanResult))
//
//  OpenAI:    client.responses.parse(model='gpt-5.4', input=[image, system_prompt],
//             text_format=ScanResult)
//
//  Anthropic: client.messages.create(model='claude-sonnet-4-6',
//             system=SCAN_SYSTEM_PROMPT, tools=[{name, input_schema}],
//             tool_choice={'type':'tool', 'name':...}, messages=[image only])
//             # result lands in content[0].input as a dict
//
// Format diffs handled entirely on the FastAPI side. This component
// only reads results from /api/scan/results/[id].
// ──────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import {
  enqueueScanBatch,
  enqueueRegen,
  getSignedUploadUrl,
  uploadToGcs,
} from "../../lib/api";
import { convertToJpeg, formatBytes } from "../../lib/compress";
import { useJobPoller } from "../../lib/polling";
import { computeConsensus } from "../../lib/scan-helpers";
import type {
  EquipmentType,
  ImageScanState,
  JobRecord,
  ProviderScanResult,
} from "../../lib/types";
import type { EnhanceProvider } from "../../lib/types-enhance";

import { ScanCard } from "./ScanCard";
import { ScanFilterChips, type ScanFilter } from "./ScanFilterChips";
import { ScanCommandBar } from "./ScanCommandBar";

const MAX_UPLOADS = 10;

/**
 * Local state for a file the operator dropped directly onto the Scan tab
 * (standalone mode — bypasses Enhance). Each file is JPEG-converted
 * client-side, uploaded to GCS via signed PUT, then merged into the
 * scan batch input list.
 */
interface StandaloneUpload {
  id:         string;
  filename:   string;
  previewUrl: string;
  size:       number;
  status:     "uploading" | "done" | "error";
  progress:   number;
  assetId?:   string;
  error?:     string;
}

// ─── Pipeline asset shape ─────────────────────────────────────────────────

interface PipelineAsset {
  assetId:      string;
  filename:     string;
  thumbnailUrl: string;
  outputUrl?:   string;
  provider?:    string;
}

export interface ScanPanelProps {
  sessionId:      string;
  enhancedAssets: PipelineAsset[];
  /**
   * Called by "Reset scan" — wipes the workspace's enhancedAssets pipeline
   * so the next "Scan all" doesn't include images the user already dismissed.
   */
  onClearPipeline: () => void;
  /**
   * Called when the operator approves a scan (per-card or bulk). Workspace
   * appends to its resizeAssets pipeline + switches to the Resize tab.
   */
  onSendToResize:  (items: PipelineAsset[]) => void;
  /**
   * Workspace-scoped auto-advance toggle. When ON, any newly-complete
   * scan with `verdict === "pass" && avgConfidence >= threshold` is
   * auto-approved + auto-forwarded to Resize. Mixed and fail verdicts
   * never auto-advance regardless of threshold.
   */
  autoAdvance:     boolean;
  /**
   * Equipment category from the lifted workspace meta. Threaded into
   * RegenPanel so the regen prompt's per-type guardrails match the
   * one Enhance used for the original generation.
   */
  equipmentType:   EquipmentType;
  /**
   * OEM make from the operator's meta form (e.g. "Toyota"). Threaded
   * into RegenPanel so the regen prompt's RENTAL-FLEET BRANDING block
   * can request OEM-style brand restoration where rental wraps were
   * stripped. Null when the operator hasn't filled in Make yet.
   */
  //make:            string | null;
}

export function ScanPanel({
  sessionId,
  enhancedAssets,
  onClearPipeline,
  onSendToResize,
  autoAdvance,
  equipmentType,
  //make,
}: ScanPanelProps) {
  // ─── Core scan state ────────────────────────────────────────────────────

  const [scanStates, setScanStates]     = useState<ImageScanState[]>([]);
  const [batchJobIds, setBatchJobIds]   = useState<string[]>([]);
  const [scanError, setScanError]       = useState<string | null>(null);

  /** Per-asset ms timestamp captured from the first poll's job.createdAt. */
  const [jobStartedMs, setJobStartedMs] = useState<Map<string, number>>(new Map());

  // ─── Redesign-specific UI state ─────────────────────────────────────────

  const [filter, setFilter]               = useState<ScanFilter>("all");
  const [approved, setApproved]           = useState<Set<string>>(new Set());
  const [rejected, setRejected]           = useState<Set<string>>(new Set());
  const [regenOpenId, setRegenOpenId]     = useState<string | null>(null);
  const [detailsOpenId, setDetailsOpenId] = useState<string | null>(null);

  // ─── Standalone-upload state ────────────────────────────────────────────

  const [uploads, setUploads]   = useState<StandaloneUpload[]>([]);
  const fileInputRef            = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const patchUpload = useCallback((id: string, patch: Partial<StandaloneUpload>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads((prev) => {
      const target = prev.find((u) => u.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((u) => u.id !== id);
    });
  }, []);

  const runUpload = useCallback(
    async (id: string, file: File) => {
      const targetFilename = file.name.replace(/\.[^./\\]+$/, "") + ".jpg";
      let jpegFile: File;
      try {
        jpegFile = await convertToJpeg(file, targetFilename);
        patchUpload(id, { filename: jpegFile.name, size: jpegFile.size });
      } catch (err) {
        patchUpload(id, {
          status: "error",
          error: err instanceof Error ? err.message : "JPEG conversion failed",
        });
        return;
      }

      let signed: Awaited<ReturnType<typeof getSignedUploadUrl>>;
      try {
        signed = await getSignedUploadUrl({
          sessionId,
          filename:    jpegFile.name,
          contentType: "image/jpeg",
        });
      } catch (err) {
        patchUpload(id, {
          status: "error",
          error: err instanceof Error ? `Upload URL: ${err.message}` : "Upload URL failed",
        });
        return;
      }

      try {
        await uploadToGcs(signed.uploadUrl, jpegFile, (pct) =>
          patchUpload(id, { progress: pct }),
        );
        patchUpload(id, { status: "done", progress: 100, assetId: signed.assetId });
      } catch (err) {
        patchUpload(id, {
          status: "error",
          error: err instanceof Error ? `GCS PUT: ${err.message}` : "GCS PUT failed",
        });
      }
    },
    [sessionId, patchUpload],
  );

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming).filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) return;
      const allowed = Math.max(0, MAX_UPLOADS - uploads.length);
      const accepted = list.slice(0, allowed);
      const next: StandaloneUpload[] = accepted.map((file) => ({
        id:         uuidv4(),
        filename:   file.name,
        previewUrl: URL.createObjectURL(file),
        size:       file.size,
        status:     "uploading",
        progress:   0,
      }));
      setUploads((prev) => [...prev, ...next]);
      next.forEach((u, i) => {
        void runUpload(u.id, accepted[i]);
      });
    },
    [uploads.length, runUpload],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) addFiles(e.target.files);
      e.target.value = "";
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  // ─── Merged input set ───────────────────────────────────────────────────

  const standaloneAssets: PipelineAsset[] = useMemo(
    () => uploads
      .filter((u) => u.status === "done" && u.assetId)
      .map((u) => ({
        assetId:      u.assetId as string,
        filename:     u.filename,
        thumbnailUrl: u.previewUrl,
        outputUrl:    undefined,
        provider:     undefined,
      })),
    [uploads],
  );
  const allAssets = useMemo(
    () => [...enhancedAssets, ...standaloneAssets],
    [enhancedAssets, standaloneAssets],
  );
  const anyUploadInFlight = uploads.some((u) => u.status === "uploading");

  const providerByAssetId = useMemo(
    () => new Map(allAssets.map((a) => [a.assetId, a.provider])),
    [allAssets],
  );

  // ─── Now-ticker for ScanProgressStrip ───────────────────────────────────

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const anyScanning = useMemo(
    () => scanStates.some((s) => s.providerResults.length === 0),
    [scanStates],
  );

  useEffect(() => {
    if (!anyScanning) return;
    const handle = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [anyScanning]);

  // ─── Polling callbacks ──────────────────────────────────────────────────

  const updateScanState = useCallback((assetId: string, patch: Partial<ImageScanState>) => {
    setScanStates((prev) => prev.map((s) => (s.assetId === assetId ? { ...s, ...patch } : s)));
  }, []);

  const handleJobUpdate = useCallback((job: JobRecord) => {
    // Capture the first observed createdAt so ScanProgressStrip's elapsed
    // counter is anchored to the actual job start time (vs. when the user
    // clicked the Scan button — which can lag if Cloud Tasks queues fan
    // out slowly on big batches).
    const ms = new Date(job.createdAt).getTime();
    setJobStartedMs((prev) => {
      if (prev.get(job.inputAssetId) === ms) return prev;
      const next = new Map(prev);
      next.set(job.inputAssetId, ms);
      return next;
    });
  }, []);

  const fetchScanResults = useCallback(async (job: JobRecord) => {
    try {
      const res = await fetch(`/api/scan/results/${job.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        providerResults:      ProviderScanResult[];
        consensusVerdict?:    string;
        consensusConfidence?: number;
      };
      updateScanState(job.inputAssetId, {
        providerResults:     data.providerResults,
        consensusVerdict:    data.consensusVerdict as ImageScanState["consensusVerdict"],
        consensusConfidence: data.consensusConfidence,
      });
    } catch {
      // Non-fatal: state stays with empty providerResults
    }
  }, [updateScanState]);

  const handleJobComplete = useCallback(
    (job: JobRecord) => fetchScanResults(job),
    [fetchScanResults],
  );

  const handleJobError = useCallback((job: JobRecord) => {
    updateScanState(job.inputAssetId, {
      providerResults: [
        {
          provider:  "gemini",
          verdict:   "fail",
          confidence: 0,
          anomalies: [],
          summary:   job.error ?? "Scan failed",
          latencyMs: 0,
        },
      ],
    });
  }, [updateScanState]);

  // ─── Scan trigger ───────────────────────────────────────────────────────

  const handleStartScan = async () => {
    if (allAssets.length === 0) return;
    setScanError(null);

    const initial: ImageScanState[] = allAssets.map((a) => ({
      assetId:         a.assetId,
      inputJobId:      "",
      filename:        a.filename,
      thumbnailUrl:    a.thumbnailUrl,
      outputUrl:       a.outputUrl,
      providerResults: [],
    }));
    setScanStates(initial);
    setJobStartedMs(new Map());

    try {
      const { jobIds } = await enqueueScanBatch({
        sessionId,
        assetIds:        allAssets.map((a) => a.assetId),
        idempotencyKey:  `scan-batch-${uuidv4()}`,
      });
      setBatchJobIds(jobIds);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to start scan";
      setScanError(msg);
    }
  };

  // ─── Filter + tallies ───────────────────────────────────────────────────

  const filterCounts = useMemo(() => {
    let pass = 0, mixed = 0, fail = 0, scanning = 0;
    for (const s of scanStates) {
      if (s.providerResults.length === 0) {
        scanning++;
        continue;
      }
      const c = computeConsensus(s.providerResults);
      if (!c) continue;
      if (c.verdict === "pass") pass++;
      else if (c.verdict === "mixed") mixed++;
      else fail++;
    }
    return {
      all:      scanStates.length,
      pass,
      mixed,
      fail,
      scanning,
    };
  }, [scanStates]);

  const filteredScans = useMemo(() => {
    if (filter === "all") return scanStates;
    return scanStates.filter((s) => {
      const isScanning = s.providerResults.length === 0;
      if (filter === "scanning") return isScanning;
      if (isScanning) return false;
      const c = computeConsensus(s.providerResults);
      return c?.verdict === filter;
    });
  }, [scanStates, filter]);

  // Eligible-for-bulk-approve: ANY verdict, as long as the scan has
  // results and isn't already approved/rejected. Operators wanted a
  // single one-click "send everything I haven't rejected to Resize"
  // CTA — the confidence-gate friction is gone. Per-card Reject (✕) is
  // the escape hatch to keep a card out of the bulk run.
  const eligibleForBulk = useMemo(() => {
    return scanStates.filter((s) => {
      if (approved.has(s.assetId) || rejected.has(s.assetId)) return false;
      if (s.providerResults.length === 0) return false;
      return true;
    });
  }, [scanStates, approved, rejected]);

  // Pass-only subset for auto-advance. Even with threshold gone, silent
  // background auto-approval should never ship a fail or mixed verdict
  // — operators need to see those before they go.
  const autoAdvanceEligible = useMemo(() => {
    return scanStates.filter((s) => {
      if (approved.has(s.assetId) || rejected.has(s.assetId)) return false;
      if (s.providerResults.length === 0) return false;
      const c = computeConsensus(s.providerResults);
      return c !== null && c.verdict === "pass";
    });
  }, [scanStates, approved, rejected]);

  // Command-bar verdict tallies — exclude already-decided cards so the
  // numbers always reflect work remaining.
  const verdictTallies = useMemo(() => {
    let pass = 0, mixed = 0, fail = 0, scanning = 0;
    for (const s of scanStates) {
      if (approved.has(s.assetId) || rejected.has(s.assetId)) continue;
      if (s.providerResults.length === 0) { scanning++; continue; }
      const c = computeConsensus(s.providerResults);
      if (!c) continue;
      if (c.verdict === "pass") pass++;
      else if (c.verdict === "mixed") mixed++;
      else fail++;
    }
    return { pass, mixed, fail, scanning };
  }, [scanStates, approved, rejected]);

  // ─── Approve / Reject / Bulk approve / Regen handlers ──────────────────

  const buildResizeItem = useCallback(
    (scan: ImageScanState): PipelineAsset => ({
      assetId:      scan.assetId,
      filename:     scan.filename,
      thumbnailUrl: scan.thumbnailUrl,
      outputUrl:    scan.outputUrl,
      provider:     providerByAssetId.get(scan.assetId),
    }),
    [providerByAssetId],
  );

  const handleApprove = useCallback(
    (assetId: string) => {
      if (approved.has(assetId) || rejected.has(assetId)) return;
      const scan = scanStates.find((s) => s.assetId === assetId);
      if (!scan || scan.providerResults.length === 0) return;
      onSendToResize([buildResizeItem(scan)]);
      setApproved((prev) => new Set(prev).add(assetId));
    },
    [approved, rejected, scanStates, onSendToResize, buildResizeItem],
  );

  const handleReject = useCallback(
    (assetId: string) => {
      if (approved.has(assetId) || rejected.has(assetId)) return;
      setRejected((prev) => new Set(prev).add(assetId));
      // Close any regen panel/detail open for this card.
      setRegenOpenId((cur) => (cur === assetId ? null : cur));
      setDetailsOpenId((cur) => (cur === assetId ? null : cur));
    },
    [approved, rejected],
  );

  const handleApproveBulk = useCallback(() => {
    if (eligibleForBulk.length === 0) return;
    onSendToResize(eligibleForBulk.map(buildResizeItem));
    setApproved((prev) => {
      const next = new Set(prev);
      for (const s of eligibleForBulk) next.add(s.assetId);
      return next;
    });
  }, [eligibleForBulk, onSendToResize, buildResizeItem]);

  const handleApplyRegen = useCallback(
    async (assetId: string, payload: { prompt: string; provider: EnhanceProvider }) => {
      try {
        await enqueueRegen({
          sessionId,
          assetId,
          regenPrompt:    payload.prompt,
          provider:       payload.provider,
          idempotencyKey: `regen-${assetId}-${uuidv4()}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to enqueue regen";
        setScanError(msg);
      } finally {
        setRegenOpenId(null);
      }
    },
    [sessionId],
  );

  // ─── Auto-advance — auto-approve eligible passes ────────────────────────
  // Forwarding to Resize + marking approved in lock-step IS the side-effect
  // here; marking approved is what prevents the re-derive loop because the
  // autoAdvanceEligible memo filters by approved. Note auto-advance uses
  // the pass-only set, NOT the broader eligibleForBulk that the manual CTA
  // ships — silent background approval should never auto-ship a fail.
  useEffect(() => {
    if (!autoAdvance || autoAdvanceEligible.length === 0) return;
    onSendToResize(autoAdvanceEligible.map(buildResizeItem));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional, see comment above.
    setApproved((prev) => {
      const next = new Set(prev);
      for (const s of autoAdvanceEligible) next.add(s.assetId);
      return next;
    });
  }, [autoAdvance, autoAdvanceEligible, onSendToResize, buildResizeItem]);

  // ─── Reset scan ─────────────────────────────────────────────────────────

  const handleResetScan = () => {
    uploads.forEach((u) => URL.revokeObjectURL(u.previewUrl));
    setUploads([]);
    setScanStates([]);
    setBatchJobIds([]);
    setScanError(null);
    setApproved(new Set());
    setRejected(new Set());
    setRegenOpenId(null);
    setDetailsOpenId(null);
    setJobStartedMs(new Map());
    setFilter("all");
    onClearPipeline();
  };

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ── Standalone upload zone ── */}
      {scanStates.length === 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
          <header className="flex items-center justify-between px-4 py-3 bg-zinc-900/50 border-b border-zinc-800">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">
                Upload images
              </span>
              <span className="text-[10px] text-zinc-500">
                Drop images here to scan directly — no Enhance step required. Auto-converted to JPEG before upload.
              </span>
            </div>
            <span className="text-[10px] uppercase tracking-[0.18em] font-mono text-zinc-500">
              {uploads.length} / {MAX_UPLOADS}
            </span>
          </header>

          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={`
              m-4 p-6 rounded-lg border-2 border-dashed cursor-pointer transition-colors text-center
              ${isDragging
                ? "border-blue-500 bg-blue-950/30"
                : uploads.length >= MAX_UPLOADS
                  ? "border-zinc-800 bg-zinc-900/40 cursor-not-allowed opacity-60"
                  : "border-zinc-700 bg-zinc-900/40 hover:border-zinc-500"}
            `}
            aria-disabled={uploads.length >= MAX_UPLOADS}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileInputChange}
              className="sr-only"
              disabled={uploads.length >= MAX_UPLOADS}
            />
            <p className="text-sm text-zinc-300">
              {uploads.length >= MAX_UPLOADS
                ? `Maximum ${MAX_UPLOADS} uploads reached`
                : isDragging
                  ? "Drop to upload"
                  : "Click or drop image files here"}
            </p>
            <p className="text-[11px] text-zinc-500 mt-1">
              JPEG, PNG, WebP · auto-converted to JPEG before upload
            </p>
          </div>

          {uploads.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2 p-4 pt-0">
              {uploads.map((u) => (
                <div
                  key={u.id}
                  className={`
                    relative rounded-lg overflow-hidden border bg-zinc-900
                    ${u.status === "error" ? "border-red-700" : "border-zinc-800"}
                  `}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={u.previewUrl}
                    alt={u.filename}
                    className="w-full aspect-square object-cover"
                  />
                  {u.status !== "done" && (
                    <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center p-2 gap-1">
                      {u.status === "uploading" && (
                        <>
                          <div className="w-full bg-zinc-700 rounded-full h-1.5">
                            <div
                              className="bg-blue-500 h-1.5 rounded-full transition-all"
                              style={{ width: `${u.progress}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-blue-300">{u.progress}%</span>
                        </>
                      )}
                      {u.status === "error" && (
                        <span className="text-[10px] text-red-400 text-center">{u.error ?? "Upload failed"}</span>
                      )}
                    </div>
                  )}
                  {u.status === "done" && (
                    <div className="absolute top-1 right-1 bg-green-500 rounded-full p-0.5" aria-label="Uploaded">
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeUpload(u.id); }}
                    className="absolute top-1 left-1 bg-black/70 hover:bg-black/90 rounded-full w-5 h-5 flex items-center justify-center text-zinc-300 hover:text-white text-xs leading-none"
                    aria-label={`Remove ${u.filename}`}
                    title="Remove"
                  >
                    ×
                  </button>
                  <div className="absolute bottom-0 inset-x-0 bg-linear-to-t from-black/80 to-transparent px-2 py-1">
                    <p className="text-[10px] text-zinc-200 truncate">{u.filename}</p>
                    <p className="text-[9px] text-zinc-500">{formatBytes(u.size)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Scan trigger ── */}
      {scanStates.length === 0 && (
        <div className="text-center space-y-4 py-8">
          <div className="text-zinc-500 space-y-1">
            <p className="text-sm">
              {allAssets.length > 0
                ? `${allAssets.length} image${allAssets.length !== 1 ? "s" : ""} ready to scan` +
                  (enhancedAssets.length > 0 && standaloneAssets.length > 0
                    ? ` (${enhancedAssets.length} from Enhance + ${standaloneAssets.length} uploaded)`
                    : "")
                : anyUploadInFlight
                  ? "Waiting for uploads to finish…"
                  : "Drop images above, or send some from the Enhance tab first"}
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
            type="button"
            onClick={handleStartScan}
            disabled={allAssets.length === 0 || anyUploadInFlight}
            className={`
              px-8 py-3 rounded-xl font-semibold text-sm transition-all
              ${allAssets.length > 0 && !anyUploadInFlight
                ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40"
                : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}
            `}
          >
            {anyUploadInFlight
              ? "Wait for uploads…"
              : `Scan ${allAssets.length} Image${allAssets.length !== 1 ? "s" : ""}`}
          </button>
        </div>
      )}

      {/* ── Results header — filter chips + total + reset ── */}
      {scanStates.length > 0 && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-[0.18em]">
              Scan results — {scanStates.length} image{scanStates.length !== 1 ? "s" : ""}
            </h2>
            <ScanFilterChips counts={filterCounts} active={filter} onChange={setFilter} />
          </div>
          <button
            type="button"
            onClick={handleResetScan}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Reset scan
          </button>
        </div>
      )}

      {/* ── ScanCard list ── */}
      {scanStates.length > 0 && (
        <div className="space-y-3 pb-4">
          {filteredScans.map((scan) => {
            // Find the original index so we can mount the matching headless
            // poller. Newly-arriving scans keep their batchJobIds slot.
            const originalIndex = scanStates.findIndex((s) => s.assetId === scan.assetId);
            const jobId = originalIndex >= 0 ? batchJobIds[originalIndex] : undefined;
            return (
              <div key={scan.assetId}>
                {jobId && (
                  <ScanJobPoller
                    jobId={jobId}
                    onUpdate={handleJobUpdate}
                    onComplete={handleJobComplete}
                    onError={handleJobError}
                  />
                )}
                <ScanCard
                  scan={scan}
                  approved={approved.has(scan.assetId)}
                  rejected={rejected.has(scan.assetId)}
                  regenOpen={regenOpenId === scan.assetId}
                  detailsOpen={detailsOpenId === scan.assetId}
                  scanStartedMs={jobStartedMs.get(scan.assetId) ?? null}
                  nowMs={nowMs}
                  equipmentType={equipmentType}
                  //make={make}
                  onToggleRegen={() =>
                    setRegenOpenId((cur) => (cur === scan.assetId ? null : scan.assetId))
                  }
                  onToggleDetails={() =>
                    setDetailsOpenId((cur) => (cur === scan.assetId ? null : scan.assetId))
                  }
                  onApprove={() => handleApprove(scan.assetId)}
                  onReject={() => handleReject(scan.assetId)}
                  onApplyRegen={(payload) => handleApplyRegen(scan.assetId, payload)}
                />
              </div>
            );
          })}

          {filteredScans.length === 0 && (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/30 p-12 text-center text-sm text-zinc-500">
              No images match the{" "}
              <span className="uppercase tracking-[0.18em] text-zinc-400 font-semibold">{filter}</span>{" "}
              filter.
            </div>
          )}
        </div>
      )}

      {/* ── Model attribution ── */}
      {scanStates.length > 0 && (
        <p className="text-[11px] text-zinc-700 text-center">
          Scanned by{" "}
          <code className="font-mono">gemini-2.5-flash</code>
          {" · "}
          <code className="font-mono">gpt-5.4</code>
          {" · "}
          <code className="font-mono">claude-sonnet-4-6</code>
          {" "}(plus{" "}
          <code className="font-mono">claude-opus-4-7</code>
          {" "}on hard cases)
        </p>
      )}

      {/* ── Sticky command bar ── */}
      {scanStates.length > 0 && (
        <ScanCommandBar
          passCount={verdictTallies.pass}
          mixedCount={verdictTallies.mixed}
          failCount={verdictTallies.fail}
          scanningCount={verdictTallies.scanning}
          approvedCount={approved.size}
          rejectedCount={rejected.size}
          eligibleCount={eligibleForBulk.length}
          onApproveBulk={handleApproveBulk}
          autoAdvance={autoAdvance}
        />
      )}
    </div>
  );
}

// ─── Headless poller component ──────────────────────────────────────────────
// Mounts a useJobPoller per scan job without violating hook rules. onUpdate
// fires on every poll tick — used to capture job.createdAt for the
// ScanProgressStrip's elapsed counter.

function ScanJobPoller({
  jobId,
  onUpdate,
  onComplete,
  onError,
}: {
  jobId:      string;
  onUpdate:   (job: JobRecord) => void;
  onComplete: (job: JobRecord) => void;
  onError:    (job: JobRecord) => void;
}) {
  useJobPoller(jobId, onUpdate, onComplete, onError);
  return null;
}
