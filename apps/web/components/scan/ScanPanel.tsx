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
  ForkliftMeta,
  ImageScanState,
  JobRecord,
  ProviderScanResult,
} from "../../lib/types";
import type { EnhanceProvider } from "../../lib/types-enhance";

import { ScanCard } from "./ScanCard";
import { ScanFilterChips, type ScanFilter } from "./ScanFilterChips";
import { ScanCommandBar } from "./ScanCommandBar";
import { TipBanner } from "../workspace/TipBanner";
import { ExportControls } from "../export/ExportControls";
import { MetaCard } from "../enhance/MetaCard";

const MAX_UPLOADS = 150;

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
  /**
   * Original pre-enhance asset id (present for Enhance-tab variants). When
   * set, the scan runs differentially (enhanced vs original). Undefined for
   * standalone uploads → isolated scan.
   */
  originalAssetId?: string;
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
   * Equipment category from the lifted workspace meta. Threaded into
   * RegenPanel so the regen prompt's per-type guardrails match the
   * one Enhance used for the original generation.
   */
  equipmentType:   EquipmentType;
  /** Shared forklift metadata — pre-fills the embedded ExportControls form. */
  meta:            Partial<ForkliftMeta>;
  /**
   * Mutates the shared workspace meta. Lets the Scan tab carry the same
   * equipment-detail fields as Enhance — important for standalone scans
   * (operator never visited Enhance) and so the values feed both the scan
   * prompt and the export filenames.
   */
  onMetaChange:    (meta: Partial<ForkliftMeta>) => void;
  /** Signed-in user's email — threaded into the embedded ExportControls. */
  userEmail:       string;
}

export function ScanPanel({
  sessionId,
  enhancedAssets,
  onClearPipeline,
  equipmentType,
  meta,
  onMetaChange,
  userEmail,
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
  const [metaExpanded, setMetaExpanded]   = useState<boolean>(false);

  // Approved (or skip-scanned) assets queued for the embedded ExportControls
  // below. Replaces the old "Send to Resize" hand-off — Save + export now
  // happen right here in the Scan tab. Append-only + deduped by assetId.
  const [exportAssets, setExportAssets]   = useState<PipelineAsset[]>([]);
  const appendExportAssets = useCallback((items: PipelineAsset[]) => {
    if (items.length === 0) return;
    setExportAssets((prev) => {
      const seen = new Set(prev.map((a) => a.assetId));
      const additions = items.filter((it) => !seen.has(it.assetId));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, []);

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

    // Map each enhanced asset → its original pre-enhance asset so the worker
    // can run a differential (before/after) scan. Standalone uploads have no
    // original, so they're omitted and fall back to the isolated scan.
    const originalAssetIds: Record<string, string> = {};
    for (const a of allAssets) {
      if (a.originalAssetId) originalAssetIds[a.assetId] = a.originalAssetId;
    }

    try {
      const { jobIds } = await enqueueScanBatch({
        sessionId,
        assetIds:        allAssets.map((a) => a.assetId),
        idempotencyKey:  `scan-batch-${uuidv4()}`,
        equipmentType:   meta.equipmentType ?? equipmentType,
        make:            meta.make?.trim() || undefined,
        originalAssetIds: Object.keys(originalAssetIds).length > 0 ? originalAssetIds : undefined,
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
      appendExportAssets([buildResizeItem(scan)]);
      setApproved((prev) => new Set(prev).add(assetId));
    },
    [approved, rejected, scanStates, appendExportAssets, buildResizeItem],
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
    appendExportAssets(eligibleForBulk.map(buildResizeItem));
    setApproved((prev) => {
      const next = new Set(prev);
      for (const s of eligibleForBulk) next.add(s.assetId);
      return next;
    });
  }, [eligibleForBulk, appendExportAssets, buildResizeItem]);

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
    setExportAssets([]);
    onClearPipeline();
  };

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ── Top-of-tab escape hatch ──
          Skip the AI quality check entirely and queue every image straight
          into the Save & Export section at the bottom of this tab. Useful
          when the operator already trusts the Enhance output and just wants
          to crop + export. Sits ABOVE the TipBanner so it's the first thing
          the operator sees on entering the tab; disabled until at least one
          image is queued and any in-flight uploads have settled. */}
      {(() => {
        const canSkip = allAssets.length > 0 && !anyUploadInFlight;
        return (
          <div className="flex">
            <button
              type="button"
              onClick={() => appendExportAssets(allAssets)}
              disabled={!canSkip}
              className={`inline-flex py-3 px-6 rounded-lg font-bold text-base uppercase tracking-[0.12em] border-2 transition-colors ${
                canSkip
                  ? "border-line bg-panel hover:bg-panel-hi text-ink"
                  : "border-line bg-panel-hi text-ink-faint cursor-not-allowed"
              }`}
            >
              Skip scanning — queue all for export ↓
            </button>
          </div>
        );
      })()}

      {/* ── Plain-language explanation of what this tab is for ── */}
      <TipBanner
        title="Scan tab — what this does"
        steps={[
          <>Three AI quality checkers (Gemini, OpenAI, Claude) each look at every image and vote pass or fail.</>,
          <>Each card shows the consensus verdict at the top — <span className="text-accent font-semibold">PASS</span> means all agree, <span className="text-accent font-semibold">MIXED</span> means they disagree, <span className="text-danger-ink font-semibold">FAIL</span> means all flagged a problem.</>,
          <>Click any card to expand it and read the specific issues each AI found.</>,
          <>Use <span className="font-semibold text-ink">↻ Regenerate</span> on a failing image to get a fresh AI version that targets the flagged issues.</>,
          <>When done, click <span className="font-semibold text-ink">Approve N → Export</span> at the bottom to queue all undecided cards into the Save &amp; Export section.</>,
        ]}
      >
        <p>
          Three AI quality checkers vote on every photo so you don&apos;t
          have to inspect each one by hand. Anything they disagree on
          shows up so you can make the call.
        </p>
      </TipBanner>

      {/* ── Equipment details ──
          Same meta fields as the Enhance tab, bound to the shared workspace
          meta. Editing here feeds the scan prompt's equipment context AND
          the export filenames (zip + per-image). Hidden once results are in
          so it doesn't crowd the results view. */}
      {scanStates.length === 0 && (
        <MetaCard
          meta={meta}
          onChange={onMetaChange}
          expanded={metaExpanded}
          onExpand={setMetaExpanded}
        />
      )}

      {/* ── Standalone upload zone ── */}
      {scanStates.length === 0 && (
        <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
          <header className="flex items-start justify-between gap-4 px-5 py-4 bg-panel/50 border-b border-line">
            <div className="flex flex-col gap-1">
              <span className="text-base font-semibold uppercase tracking-[0.14em] text-ink">
                Upload images to scan directly
              </span>
              <span className="text-sm text-ink-soft leading-relaxed">
                Use this when you already have a finished photo and just want
                a quality check on it — no Enhance step required. Three AI
                quality checkers will vote pass / fail and flag any issues
                they spot. Files are auto-converted to JPEG before upload.
              </span>
            </div>
            <span className="text-sm uppercase tracking-[0.18em] font-mono text-ink-soft tabular-nums shrink-0">
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
                ? "border-line bg-panel"
                : uploads.length >= MAX_UPLOADS
                  ? "border-line bg-panel/40 cursor-not-allowed opacity-60"
                  : "border-line bg-panel/40 hover:border-ink-faint"}
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
            <p className="text-base text-ink font-semibold">
              {uploads.length >= MAX_UPLOADS
                ? `Maximum ${MAX_UPLOADS} uploads reached`
                : isDragging
                  ? "Drop to upload"
                  : "Click or drop image files here"}
            </p>
            <p className="text-sm text-ink-soft mt-1">
              JPEG, PNG, WebP · auto-converted to JPEG before upload
            </p>
          </div>

          {uploads.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2 p-4 pt-0">
              {uploads.map((u) => (
                <div
                  key={u.id}
                  className={`
                    relative rounded-lg overflow-hidden border bg-panel
                    ${u.status === "error" ? "border-danger-ink" : "border-line"}
                  `}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={u.previewUrl}
                    alt={u.filename}
                    className="w-full aspect-square object-cover"
                  />
                  {u.status !== "done" && (
                    <div className="absolute inset-0 bg-header-bg/60 flex flex-col items-center justify-center p-2 gap-1">
                      {u.status === "uploading" && (
                        <>
                          <div className="w-full bg-panel-hi rounded-full h-1.5">
                            <div
                              className="bg-panel-hi h-1.5 rounded-full transition-all"
                              style={{ width: `${u.progress}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-ink-soft">{u.progress}%</span>
                        </>
                      )}
                      {u.status === "error" && (
                        <span className="text-[10px] text-danger-ink text-center">{u.error ?? "Upload failed"}</span>
                      )}
                    </div>
                  )}
                  {u.status === "done" && (
                    <div className="absolute top-1 right-1 bg-accent rounded-full p-0.5" aria-label="Uploaded">
                      <svg className="w-3 h-3 text-header-bg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeUpload(u.id); }}
                    className="absolute top-1 left-1 bg-header-bg/70 hover:bg-header-bg/90 rounded-full w-5 h-5 flex items-center justify-center text-ink-soft hover:text-ink text-xs leading-none"
                    aria-label={`Remove ${u.filename}`}
                    title="Remove"
                  >
                    ×
                  </button>
                  <div className="absolute bottom-0 inset-x-0 bg-linear-to-t from-black/80 to-transparent px-2 py-1">
                    <p className="text-[10px] text-ink truncate">{u.filename}</p>
                    <p className="text-[9px] text-ink-faint">{formatBytes(u.size)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Scan trigger ── */}
      {scanStates.length === 0 && (
        <div className="space-y-4 py-8">
          {/* Pre-scan preview — show the images forwarded from the
              Enhance tab as thumbnails BEFORE the operator clicks Scan,
              so they can confirm the batch on tab load instead of having
              to scan first to see what's queued. Standalone uploads
              already render their own thumbnails in the upload zone
              above. */}
          {enhancedAssets.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm uppercase tracking-[0.16em] font-bold text-ink-soft">
                From the Enhance tab — {enhancedAssets.length} image{enhancedAssets.length !== 1 ? "s" : ""}
              </p>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                {enhancedAssets.map((a) => (
                  <div
                    key={a.assetId}
                    className="relative rounded-lg overflow-hidden border border-line bg-panel aspect-square"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={a.thumbnailUrl}
                      alt={a.filename}
                      width={200}
                      height={200}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute bottom-0 inset-x-0 bg-linear-to-t from-black/80 to-transparent px-2 py-1">
                      <p className="text-[10px] text-ink truncate">{a.filename}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-center space-y-4">
          <div className="text-ink-faint space-y-1">
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
            <p className="text-xs text-muted">
              Scans with{" "}
              <code className="font-mono">gemini-2.5-flash</code>
              {" "}· OpenAI{" "}
              <code className="font-mono">gpt-5.4</code>
              {" "}· Anthropic{" "}
              <code className="font-mono">claude-sonnet-4-6</code>
            </p>
          </div>

          {scanError && (
            <p className="text-sm text-danger-ink bg-panel border border-danger-ink rounded-lg px-4 py-3" role="alert">
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
                ? "bg-panel hover:bg-panel-hi text-ink shadow-lg"
                : "bg-panel-hi text-ink-faint cursor-not-allowed"}
            `}
          >
            {anyUploadInFlight
              ? "Wait for uploads…"
              : `Scan ${allAssets.length} Image${allAssets.length !== 1 ? "s" : ""}`}
          </button>
          </div>
        </div>
      )}

      {/* ── Results header — filter chips + total + reset ── */}
      {scanStates.length > 0 && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap">
            <h2 className="font-display text-xl text-ink uppercase tracking-[0.14em]">
              Scan results — {scanStates.length} image{scanStates.length !== 1 ? "s" : ""}
            </h2>
            <ScanFilterChips counts={filterCounts} active={filter} onChange={setFilter} />
          </div>
          <button
            type="button"
            onClick={handleResetScan}
            className="text-sm font-bold text-ink hover:text-ink transition-colors border border-line hover:border-ink-faint rounded px-3 py-1.5"
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
            <div className="rounded-xl border border-dashed border-line bg-well/30 p-12 text-center text-sm text-ink-faint">
              No images match the{" "}
              <span className="uppercase tracking-[0.18em] text-ink-soft font-semibold">{filter}</span>{" "}
              filter.
            </div>
          )}
        </div>
      )}

      {/* ── Model attribution ── */}
      {scanStates.length > 0 && (
        <p className="text-[11px] text-muted text-center">
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
        />
      )}

      {/* ── Save & export ──
          Moved here from the removed Resize tab. Shows once at least one
          card has been approved (or the operator hit "Skip scanning —
          queue all for export"). Save Project unlocks the PRO export,
          then download right here. */}
      {exportAssets.length > 0 && (
        <ExportControls
          sessionId={sessionId}
          assets={exportAssets}
          meta={meta}
          userEmail={userEmail}
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
