"use client";
// apps/web/components/enhance/EnhancePanel.tsx
// Enhance tab — Phase 3 redesign.
//
// Layout (top to bottom):
//   1. Drop zone + pending-thumbnail grid (unchanged behavior)
//   2. MetaCard — Make required up front, the rest behind "+ More details"
//   3. ProviderRow — compact provider chip multi-select
//   4. Advanced collapsible — toggles + custom prompt (preserved verbatim)
//   5. Enhance N Images button
//   6. SourceCompareCards — one per uploaded file, 5-up variant grid
//   7. CommandBar — sticky footer with ready/working/undecided/held tally
//      + primary "Send N to Scan →" CTA
//
// State changes vs. previous version:
//   • selectedJobIds is gone — replaced by derivation from chosenByFile
//   • chosenByFile: Map<fileId, Provider> (operator's winner picks)
//   • heldFiles:    Set<fileId> (per-card opt-out from auto-advance)
//   • jobStateMap:  Map<jobId, JobRecord> (hoisted from JobStatusRow so
//                   variant thumbs share polling state)
//
// useJobPoller lives in a headless poller component (one per active jobId)
// so the existing 3s/10s/15s adaptive cadence stays intact — same pattern
// ScanPanel uses for per-image scan jobs.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import { buildEnhanceFilename, convertToJpeg, formatBytes } from "../../lib/compress";
import {
  DEFAULT_TOGGLES,
  TOGGLE_LABELS,
  TOGGLE_DESCRIPTIONS,
  type EnhanceToggles,
  type ForkliftMeta,
  type JobRecord,
  type UploadFile,
} from "../../lib/types";
import {
  enqueueEnhance,
  getAssetUrl,
  getSignedUploadUrl,
  uploadToGcs,
} from "../../lib/api";
import { useJobPoller } from "../../lib/polling";
import {
  ENHANCE_PROVIDERS,
  ENHANCE_PROVIDER_LABELS,
  type EnhanceProvider,
} from "../../lib/types-enhance";

import { MetaCard } from "./MetaCard";
import { ProviderRow } from "./ProviderRow";
import { CommandBar } from "./CommandBar";
import {
  SourceCompareCard,
  type SourceVariant,
} from "./SourceCompareCard";
import { EraseDialog, type EraseDialogResult } from "./EraseDialog";
import { TweakDialog, type TweakDialogResult } from "./TweakDialog";
import { TipBanner } from "../workspace/TipBanner";

const MAX_UPLOADS = 10;

// ─── Pending-upload thumbnail (used in the drop-zone grid) ─────────────────

function ThumbnailCard({ file }: { file: UploadFile }) {
  return (
    <div className="relative group rounded-lg overflow-hidden bg-zinc-900 border border-zinc-800">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={file.previewUrl}
        alt={file.file.name}
        className="w-full aspect-square object-cover"
      />

      {file.status !== "done" && (
        <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2 p-2">
          {file.status === "compressing" && (
            <>
              <svg className="animate-spin w-6 h-6 text-yellow-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              <span className="text-xs text-yellow-400 text-center">Compressing…</span>
            </>
          )}
          {file.status === "uploading" && (
            <>
              <div className="w-full bg-zinc-700 rounded-full h-1.5">
                <div
                  className="bg-blue-500 h-1.5 rounded-full transition-all"
                  style={{ width: `${file.progress}%` }}
                />
              </div>
              <span className="text-xs text-blue-300">{file.progress}%</span>
            </>
          )}
          {file.status === "error" && (
            <span className="text-xs text-red-400 text-center">{file.error ?? "Upload failed"}</span>
          )}
          {file.status === "pending" && (
            <span className="text-xs text-zinc-400">Queued</span>
          )}
        </div>
      )}

      {file.status === "done" && (
        <div className="absolute top-1.5 right-1.5 bg-green-500 rounded-full p-0.5">
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}

      {file.compressedSize !== undefined && (
        <div className="absolute bottom-1.5 left-1.5 bg-black/70 rounded px-1.5 py-0.5 text-[10px] text-yellow-300">
          {formatBytes(file.compressedSize)}
        </div>
      )}

      <div className="absolute bottom-0 inset-x-0 bg-linear-to-t from-black/80 to-transparent px-2 py-1.5 translate-y-full group-hover:translate-y-0 transition-transform">
        <p className="text-xs text-white truncate">{file.file.name}</p>
      </div>
    </div>
  );
}

// ─── ToggleSwitch (used in the Advanced section) ───────────────────────────

function ToggleSwitch({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`
        flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors
        ${checked
          ? "bg-blue-950 border-blue-500 text-white"
          : "bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-500"}
      `}
    >
      <div className="relative mt-0.5 shrink-0">
        <input
          id={id}
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <div
          className={`w-10 h-6 rounded-full transition-colors ${
            checked ? "bg-blue-500" : "bg-zinc-600"
          }`}
        />
        <div
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </div>
      <div className="min-w-0">
        <span className="block text-base font-semibold">{label}</span>
        <span className={`block text-sm mt-1 leading-snug ${checked ? "text-blue-100" : "text-zinc-300"}`}>
          {description}
        </span>
      </div>
    </label>
  );
}

// ─── Headless poller (one per active jobId) ────────────────────────────────
// Routes job updates into the parent's jobStateMap without breaking hook
// rules. Same pattern ScanPanel uses for scan jobs.

function JobPollerHeadless({
  jobId,
  onUpdate,
  onComplete,
  onError,
}: {
  jobId: string;
  onUpdate: (job: JobRecord) => void;
  onComplete: (job: JobRecord) => void;
  onError: (job: JobRecord) => void;
}) {
  useJobPoller(jobId, onUpdate, onComplete, onError);
  return null;
}

// ─── CompletedEnhanceItem (exported for Workspace handlers) ────────────────

export interface CompletedEnhanceItem {
  fileId: string;
  jobId: string;
  provider: EnhanceProvider;
  outputAssetId: string;
  filename: string;
  outputUrl: string;
}

export interface EnhancePanelProps {
  sessionId: string;
  meta: Partial<ForkliftMeta>;
  onMetaChange: (meta: Partial<ForkliftMeta>) => void;
  onSendToScan: (items: CompletedEnhanceItem[]) => void;
  onSendToResize: (items: CompletedEnhanceItem[]) => void;
  onClearPipeline: () => void;
  /** Workspace-scoped auto-advance toggle. */
  autoAdvance: boolean;
  /** Lets Workspace render the BatchContextStrip image count. */
  onFileCountChange: (count: number) => void;
}

export function EnhancePanel({
  sessionId,
  meta,
  onMetaChange,
  onSendToScan,
  onSendToResize,
  onClearPipeline,
  autoAdvance,
  onFileCountChange,
}: EnhancePanelProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jobsSectionRef = useRef<HTMLDivElement>(null);

  // ─── Core state ─────────────────────────────────────────────────────────

  const [files, setFiles] = useState<UploadFile[]>([]);
  const [toggles, setToggles] = useState<EnhanceToggles>(DEFAULT_TOGGLES);
  const setMeta = onMetaChange;

  // True when the operator has changed a toggle since the most recent batch
  // reached a terminal state. Drives the "re-enhance with new toggles"
  // path on the Enhance button — without this we'd lock them into the
  // previous batch's settings until they cleared the workspace.
  const [togglesDirty, setTogglesDirty] = useState(false);
  // One-shot guard so the auto-reset effect fires exactly once per batch
  // transition into terminal state. Reset back to false the moment the
  // batch is no longer terminal (new run started, items cleared, etc.).
  const resetDoneForBatchRef = useRef(false);

  /** Map<fileId, Map<Provider, jobId>>. Each source can have up to 5 concurrent enhance jobs. */
  const [enhanceJobs, setEnhanceJobs] = useState<
    Map<string, Map<EnhanceProvider, string>>
  >(new Map());
  const [isRunning, setIsRunning] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const [selectedProviders, setSelectedProviders] = useState<Set<EnhanceProvider>>(
    () => new Set<EnhanceProvider>(["gemini"]),
  );

  const [customPromptOpen, setCustomPromptOpen] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");

  // Both default OPEN: operators wanted the full Make/Model/Year row and
  // the toggle/custom-prompt advanced section in view from the first
  // render rather than hidden behind disclosure clicks. They can still
  // collapse either if they want a cleaner workspace.
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [metaExpanded, setMetaExpanded] = useState(true);

  const regenSeqRef = useRef(0);

  const makeValid = Boolean(meta.make?.trim());
  const customPromptActive = customPrompt.trim().length > 0;

  // Completed-jobs map and "have we already sent this to Scan?" set —
  // preserved from the prior implementation. Keyed by jobId so each
  // (file × provider) pair has its own entry.
  const [completed, setCompleted] = useState<Map<string, CompletedEnhanceItem>>(new Map());
  const [sentJobIds, setSentJobIds] = useState<Set<string>>(new Set());

  // Hoisted from the old JobStatusRow internal state so the variant
  // thumbnails can share poll updates. Keyed by jobId.
  const [jobStateMap, setJobStateMap] = useState<Map<string, JobRecord>>(new Map());

  // Operator's winner pick per source file, and the per-file Hold opt-out
  // from auto-advance. These replace the old `selectedJobIds`.
  const [chosenByFile, setChosenByFile] = useState<Map<string, EnhanceProvider>>(new Map());
  const [heldFiles, setHeldFiles] = useState<Set<string>>(new Set());

  // Per-variant Flux erase dialog state. When a target is set, the
  // EraseDialog opens with that variant's source asset. Single dialog
  // instance shared across all SourceCompareCards — only one erase
  // can be in flight at a time, which matches operator expectation
  // (focused detail work, not a batch operation).
  const [eraseTarget, setEraseTarget] = useState<{
    fileId:        string;
    provider:      EnhanceProvider;
    jobId:         string;
    sourceAssetId: string;
    sourceUrl:     string;
  } | null>(null);

  // Per-variant Gemini tweak dialog state — sister to eraseTarget,
  // same single-instance pattern. Text-only conversational sibling to
  // the mask-based Erase tool. Operator types one targeted instruction
  // and Gemini Flash Image applies just that change.
  const [tweakTarget, setTweakTarget] = useState<{
    fileId:        string;
    provider:      EnhanceProvider;
    jobId:         string;
    sourceAssetId: string;
    sourceUrl:     string;
  } | null>(null);

  // Per-variant Ideogram edit dialog state — same shape as tweakTarget
  // but routes the request through Ideogram /v1/edit instead of Gemini.
  // The dialog component is the TweakDialog with tool="ideogram".
  const [ideogramEditTarget, setIdeogramEditTarget] = useState<{
    fileId:        string;
    provider:      EnhanceProvider;
    jobId:         string;
    sourceAssetId: string;
    sourceUrl:     string;
  } | null>(null);

  // Per-variant Ideogram inpaint dialog state — mask-based sibling to
  // eraseTarget but routed through Ideogram 3.0 inpaint. Shares the
  // EraseDialog component with tool="ideogram".
  const [ideogramInpaintTarget, setIdeogramInpaintTarget] = useState<{
    fileId:        string;
    provider:      EnhanceProvider;
    jobId:         string;
    sourceAssetId: string;
    sourceUrl:     string;
  } | null>(null);

  // 1s tick used by VariantThumb to render the elapsed-vs-expected
  // progress estimate. Off when nothing is in flight to avoid burning
  // a wakeup every second on an idle tab.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const anyActiveJob = useMemo(() => {
    for (const job of jobStateMap.values()) {
      if (job.status === "queued" || job.status === "processing") return true;
    }
    return false;
  }, [jobStateMap]);

  useEffect(() => {
    if (!anyActiveJob) return;
    const handle = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [anyActiveJob]);

  // True when there's at least one batch in flight AND every job in every
  // file's provider map has reached a terminal state. Drives both the
  // post-batch toggle auto-reset and the re-enhance-button gate below.
  const batchTerminal = useMemo(() => {
    if (enhanceJobs.size === 0) return false;
    for (const providerMap of enhanceJobs.values()) {
      for (const jobId of providerMap.values()) {
        const job = jobStateMap.get(jobId);
        if (!job) return false;
        if (job.status !== "complete" && job.status !== "failed" && job.status !== "cancelled") {
          return false;
        }
      }
    }
    return true;
  }, [enhanceJobs, jobStateMap]);

  // Auto-reset toggles → all-off once the batch becomes fully terminal.
  // resetDoneForBatchRef keeps this idempotent: each batch transition into
  // terminal flips it on once, and any return to non-terminal (new run,
  // clear, etc.) flips it back so the next batch gets its own reset.
  useEffect(() => {
    if (batchTerminal && !resetDoneForBatchRef.current) {
      resetDoneForBatchRef.current = true;
      setToggles(DEFAULT_TOGGLES);
      // We're the ones moving toggles here — don't count it as a
      // user-initiated dirty change.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: the auto-reset IS the side-effect; gated by the one-shot ref so no loop.
      setTogglesDirty(false);
    } else if (!batchTerminal && resetDoneForBatchRef.current) {
      resetDoneForBatchRef.current = false;
    }
  }, [batchTerminal]);

  // Report file count up to Workspace so the BatchContextStrip can show it.
  useEffect(() => {
    onFileCountChange(files.length);
  }, [files.length, onFileCountChange]);

  // ─── Job poll callbacks (used by headless poller children) ─────────────

  const updateJobState = useCallback((jobId: string, job: JobRecord) => {
    setJobStateMap((prev) => {
      const next = new Map(prev);
      next.set(jobId, job);
      return next;
    });
  }, []);

  const handleJobComplete = useCallback(
    (file: UploadFile, provider: EnhanceProvider, job: JobRecord) => {
      updateJobState(job.id, job);
      if (!job.outputAssetId) return;
      // Fetch the signed GET URL once, then register the completed item so
      // the variant thumbnail can render the result and the downstream
      // "Send to Scan" pipeline has an outputUrl to forward.
      getAssetUrl(job.outputAssetId)
        .then(({ url }) => {
          setCompleted((prev) => {
            if (prev.has(job.id)) return prev;
            const next = new Map(prev);
            next.set(job.id, {
              fileId:        file.id,
              jobId:         job.id,
              provider,
              outputAssetId: job.outputAssetId as string,
              filename:      file.uploadedFilename ?? file.file.name,
              outputUrl:     url,
            });
            return next;
          });
        })
        .catch((err: Error) => {
          console.warn("[enhance] failed to fetch asset URL", err);
        });
    },
    [updateJobState],
  );

  const handleJobError = useCallback(
    (job: JobRecord) => {
      updateJobState(job.id, job);
    },
    [updateJobState],
  );

  // ─── Provider checkbox ─────────────────────────────────────────────────

  const toggleProvider = useCallback((p: EnhanceProvider) => {
    setSelectedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(p)) {
        if (next.size === 1) return prev;     // refuse to leave zero providers checked
        next.delete(p);
      } else {
        next.add(p);
      }
      return next;
    });
  }, []);

  // Header "Select all" checkbox. When all providers are already on,
  // clicking it collapses back to just gemini (the default single-pick)
  // — never to empty, per the same "must keep at least one" rule the
  // per-tile toggle enforces.
  const selectAllProviders = useCallback(() => {
    setSelectedProviders((prev) => {
      if (prev.size === ENHANCE_PROVIDERS.length) {
        return new Set<EnhanceProvider>(["gemini"]);
      }
      return new Set<EnhanceProvider>(ENHANCE_PROVIDERS);
    });
  }, []);

  // ─── File picker ───────────────────────────────────────────────────────

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const arr = Array.from(incoming);
    const allowed = MAX_UPLOADS - files.length;
    if (allowed <= 0) return;

    const slice = arr.slice(0, allowed);
    const newFiles: UploadFile[] = slice.map((f) => ({
      id: uuidv4(),
      file: f,
      previewUrl: URL.createObjectURL(f),
      status: "pending",
      progress: 0,
    }));
    setFiles((prev) => [...prev, ...newFiles]);
  }, [files.length]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  };

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const f = prev.find((x) => x.id === id);
      if (f) URL.revokeObjectURL(f.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const updateFile = useCallback((id: string, patch: Partial<UploadFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  // ─── Upload + Enhance pipeline ─────────────────────────────────────────

  const runUploadAndEnhance = async (
    uploadFile: UploadFile,
    index: number,
    total: number,
  ) => {
    const { id, file } = uploadFile;

    updateFile(id, { status: "compressing" });
    const targetFilename = buildEnhanceFilename(meta, index, total);
    let toUpload: File;
    try {
      toUpload = await convertToJpeg(file, targetFilename);
      updateFile(id, {
        compressedSize: toUpload.size,
        uploadedFilename: toUpload.name,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Conversion failed";
      updateFile(id, { status: "error", error: msg });
      return;
    }

    updateFile(id, { status: "uploading", progress: 0 });
    let signedResp: Awaited<ReturnType<typeof getSignedUploadUrl>>;
    try {
      signedResp = await getSignedUploadUrl({
        sessionId,
        filename: toUpload.name,
        contentType: "image/jpeg",
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[upload] signed-url request failed", err);
      updateFile(id, { status: "error", error: `Upload URL: ${detail}` });
      return;
    }

    try {
      await uploadToGcs(signedResp.uploadUrl, toUpload, (pct) =>
        updateFile(id, { progress: pct }),
      );
      updateFile(id, { status: "done", assetId: signedResp.assetId, gcsUri: signedResp.gcsUri });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[upload] PUT to GCS failed", err);
      updateFile(id, { status: "error", error: `GCS PUT: ${detail}` });
      return;
    }

    const providerList: EnhanceProvider[] = Array.from(selectedProviders);
    const perProviderJobIds = new Map<EnhanceProvider, string>();
    const enqueueErrors: string[] = [];

    for (const p of providerList) {
      try {
        const { jobId } = await enqueueEnhance({
          sessionId,
          assetId: signedResp.assetId,
          toggles,
          forkliftMeta: meta,
          provider: p,
          equipmentType: meta.equipmentType ?? "forklift",
          customPrompt: customPromptActive ? customPrompt : undefined,
          idempotencyKey: `enhance-${id}-${p}`,
        });
        perProviderJobIds.set(p, jobId);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[upload] enqueue enhance failed for provider=${p}`, err);
        enqueueErrors.push(`${p}: ${detail}`);
      }
    }

    if (perProviderJobIds.size === 0) {
      updateFile(id, { status: "error", error: `Enqueue: ${enqueueErrors.join("; ")}` });
      return;
    }

    setEnhanceJobs((prev) => {
      const next = new Map(prev);
      next.set(id, perProviderJobIds);
      return next;
    });
  };

  /**
   * Re-run enhance on a single (file, provider) result. Swaps the jobId in
   * `enhanceJobs[fileId][provider]` and evicts the previous job's
   * `completed` / `jobStateMap` entries so the variant thumb resets to
   * spinner. `sentJobIds` is intentionally untouched — already-forwarded
   * jobs stay historical fact.
   */
  const retryProvider = useCallback(
    async (file: UploadFile, provider: EnhanceProvider) => {
      if (!file.assetId) {
        setGlobalError("Can't retry — original upload didn't complete.");
        return;
      }
      setGlobalError(null);
      try {
        const { jobId } = await enqueueEnhance({
          sessionId,
          assetId:        file.assetId,
          toggles,
          forkliftMeta:   meta,
          provider,
          equipmentType:  meta.equipmentType ?? "forklift",
          customPrompt:   customPromptActive ? customPrompt : undefined,
          idempotencyKey: `enhance-${file.id}-${provider}-regen-${++regenSeqRef.current}`,
        });

        let oldJobId: string | undefined;
        setEnhanceJobs((prev) => {
          const next = new Map(prev);
          const fileMap = new Map(next.get(file.id) ?? []);
          oldJobId = fileMap.get(provider);
          fileMap.set(provider, jobId);
          next.set(file.id, fileMap);
          return next;
        });

        if (oldJobId) {
          const stale = oldJobId;
          setCompleted((prev) => {
            if (!prev.has(stale)) return prev;
            const next = new Map(prev);
            next.delete(stale);
            return next;
          });
          setJobStateMap((prev) => {
            if (!prev.has(stale)) return prev;
            const next = new Map(prev);
            next.delete(stale);
            return next;
          });
          // If the operator's chosen winner is the one we're retrying,
          // clear the pick so they re-confirm after seeing the new result.
          setChosenByFile((prev) => {
            const cur = prev.get(file.id);
            if (cur !== provider) return prev;
            const next = new Map(prev);
            next.delete(file.id);
            return next;
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to retry";
        setGlobalError(msg);
      }
    },
    [sessionId, toggles, meta, customPromptActive, customPrompt],
  );

  const handleEnhanceAll = async () => {
    const pending = files.filter((f) => f.status === "pending");
    if (pending.length === 0) return;
    if (!makeValid) {
      setGlobalError("Enter the forklift Make before enhancing.");
      return;
    }

    // If there's a prior batch's state hanging around AND that batch is fully
    // terminal (every variant complete/failed/cancelled), this Enhance click
    // is a fresh batch — wipe the prior batch's local state and the
    // downstream Scan/Resize pipeline before starting. Without this the
    // Scan tab keeps accumulating items from earlier enhance sessions
    // ("ended up with 2 sets in Scan after enhancing another lift").
    //
    // If the prior batch still has in-flight jobs, we DON'T clear — the
    // user is adding more images to the same batch and expects the
    // existing variants to keep polling.
    if (enhanceJobs.size > 0) {
      let allTerminal = true;
      for (const providerMap of enhanceJobs.values()) {
        for (const jobId of providerMap.values()) {
          const job = jobStateMap.get(jobId);
          if (!job || (job.status !== "complete" && job.status !== "failed" && job.status !== "cancelled")) {
            allTerminal = false;
            break;
          }
        }
        if (!allTerminal) break;
      }
      if (allTerminal) {
        // Drop fully-handled files from the upload grid so the previous
        // batch's thumbnails don't linger next to the new pending ones.
        files
          .filter((f) => f.status !== "pending")
          .forEach((f) => URL.revokeObjectURL(f.previewUrl));
        setFiles((prev) => prev.filter((f) => f.status === "pending"));
        setEnhanceJobs(new Map());
        setCompleted(new Map());
        setSentJobIds(new Set());
        setJobStateMap(new Map());
        setChosenByFile(new Map());
        setHeldFiles(new Set());
        // onClearPipeline wipes Workspace's enhancedAssets + resizeAssets +
        // resizeResults, which is what causes the Scan tab to reset.
        onClearPipeline();
        // Brand-new batch — clear the dirty flag + auto-reset latch so the
        // post-batch toggle reset fires fresh when this run completes.
        setTogglesDirty(false);
        resetDoneForBatchRef.current = false;
      }
    }

    setGlobalError(null);
    setIsRunning(true);

    requestAnimationFrame(() => {
      jobsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    await Promise.allSettled(
      pending.map((f, i) => runUploadAndEnhance(f, i, pending.length)),
    );
    setIsRunning(false);
  };

  /**
   * Re-enqueue enhance for every already-uploaded file in the batch using
   * the current toggles. Used by the "Re-enhance with new toggles" path on
   * the Enhance button after a batch has fully completed and the operator
   * has changed at least one toggle. Skips upload entirely — each file
   * still has the original assetId from its first run, so we just spin up
   * new jobs against the same GCS object.
   */
  const handleReEnhance = useCallback(async () => {
    const eligible = files.filter((f) => f.status === "done" && f.assetId);
    if (eligible.length === 0) return;
    if (!makeValid) {
      setGlobalError("Enter the forklift Make before enhancing.");
      return;
    }
    setGlobalError(null);

    // Same wipe pattern handleEnhanceAll uses for the fresh-batch branch —
    // re-enhance is morally a new batch over the same uploaded inputs, so
    // downstream Scan/Resize state has to be cleared too.
    setEnhanceJobs(new Map());
    setCompleted(new Map());
    setSentJobIds(new Set());
    setJobStateMap(new Map());
    setChosenByFile(new Map());
    setHeldFiles(new Set());
    onClearPipeline();
    setTogglesDirty(false);
    resetDoneForBatchRef.current = false;
    setIsRunning(true);

    requestAnimationFrame(() => {
      jobsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    const providerList: EnhanceProvider[] = Array.from(selectedProviders);
    await Promise.allSettled(
      eligible.map(async (file) => {
        const perProviderJobIds = new Map<EnhanceProvider, string>();
        const enqueueErrors: string[] = [];
        for (const p of providerList) {
          try {
            const { jobId } = await enqueueEnhance({
              sessionId,
              assetId:        file.assetId!,
              toggles,
              forkliftMeta:   meta,
              provider:       p,
              equipmentType:  meta.equipmentType ?? "forklift",
              customPrompt:   customPromptActive ? customPrompt : undefined,
              idempotencyKey: `re-enhance-${file.id}-${p}-${++regenSeqRef.current}`,
            });
            perProviderJobIds.set(p, jobId);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error(`[re-enhance] enqueue failed for provider=${p}`, err);
            enqueueErrors.push(`${p}: ${detail}`);
          }
        }
        if (perProviderJobIds.size > 0) {
          setEnhanceJobs((prev) => {
            const next = new Map(prev);
            next.set(file.id, perProviderJobIds);
            return next;
          });
        } else if (enqueueErrors.length > 0) {
          setGlobalError(`Re-enhance enqueue failed: ${enqueueErrors.join("; ")}`);
        }
      }),
    );
    setIsRunning(false);
  }, [
    files,
    makeValid,
    selectedProviders,
    sessionId,
    toggles,
    meta,
    customPromptActive,
    customPrompt,
    onClearPipeline,
  ]);

  /**
   * Call this from any UI control that mutates `toggles` because the user
   * touched it (the per-toggle switch + the "Reset" defaults button).
   * Marks the workspace dirty so the Enhance button re-enables in
   * re-enhance mode. Gated on batchTerminal so toggling around BEFORE the
   * first enhance run doesn't bury the operator under a "you changed
   * something" flag with nothing to re-run yet.
   */
  const markUserToggleChange = useCallback(() => {
    if (batchTerminal) setTogglesDirty(true);
  }, [batchTerminal]);

  // ─── Winner pick / Hold ────────────────────────────────────────────────

  const chooseWinner = useCallback(
    (fileId: string, provider: EnhanceProvider | null) => {
      setChosenByFile((prev) => {
        const next = new Map(prev);
        if (provider === null) next.delete(fileId);
        else next.set(fileId, provider);
        return next;
      });
    },
    [],
  );

  const toggleHold = useCallback((fileId: string) => {
    setHeldFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }, []);

  // ─── Per-variant erase ─────────────────────────────────────────────────

  /**
   * Open the EraseDialog for a specific completed variant. The dialog
   * needs the variant's outputAssetId + its signed URL to load the
   * image into the canvas. The (fileId, provider) pair lets us look up
   * the original jobId later when the operator accepts the result so
   * we can patch the variant in-place.
   */
  const handleOpenErase = useCallback(
    (fileId: string, provider: EnhanceProvider) => {
      const jobId = enhanceJobs.get(fileId)?.get(provider);
      if (!jobId) return;
      const completedItem = completed.get(jobId);
      if (!completedItem) return;
      setEraseTarget({
        fileId,
        provider,
        jobId,
        sourceAssetId: completedItem.outputAssetId,
        sourceUrl:     completedItem.outputUrl,
      });
    },
    [enhanceJobs, completed],
  );

  /**
   * Operator accepted the erased result. Patch the variant in-place —
   * `completed[jobId]` now points at the new outputAssetId/outputUrl,
   * and `jobStateMap[jobId].outputAssetId` is updated so the
   * SourceCompareCard renders the cleaned image. We deliberately keep
   * the same jobId so the operator's winner-pick, sent-to-Scan flags,
   * and the existing poller all stay coherent.
   */
  const handleEraseAccept = useCallback(
    (result: EraseDialogResult) => {
      if (!eraseTarget) return;
      const { jobId } = eraseTarget;
      setCompleted((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, {
          ...cur,
          outputAssetId: result.outputAssetId,
          outputUrl:     result.outputUrl,
        });
        return next;
      });
      setJobStateMap((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, { ...cur, outputAssetId: result.outputAssetId });
        return next;
      });
      setEraseTarget(null);
    },
    [eraseTarget],
  );

  // Same lookup-and-open pattern as handleOpenErase. The dialog needs
  // the variant's current outputAssetId + signed URL, and the original
  // jobId so handleTweakAccept can patch the right slot in `completed`
  // when the operator approves the result.
  const handleOpenTweak = useCallback(
    (fileId: string, provider: EnhanceProvider) => {
      const jobId = enhanceJobs.get(fileId)?.get(provider);
      if (!jobId) return;
      const completedItem = completed.get(jobId);
      if (!completedItem) return;
      setTweakTarget({
        fileId,
        provider,
        jobId,
        sourceAssetId: completedItem.outputAssetId,
        sourceUrl:     completedItem.outputUrl,
      });
    },
    [enhanceJobs, completed],
  );

  // Mirrors handleEraseAccept — patch the variant in-place under the
  // SAME jobId so winner-pick / sent-to-Scan flags / pollers stay
  // coherent. Closing the dialog clears the target.
  const handleTweakAccept = useCallback(
    (result: TweakDialogResult) => {
      if (!tweakTarget) return;
      const { jobId } = tweakTarget;
      setCompleted((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, {
          ...cur,
          outputAssetId: result.outputAssetId,
          outputUrl:     result.outputUrl,
        });
        return next;
      });
      setJobStateMap((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, { ...cur, outputAssetId: result.outputAssetId });
        return next;
      });
      setTweakTarget(null);
    },
    [tweakTarget],
  );

  // Same lookup-and-open shape as handleOpenTweak, just lights up the
  // Ideogram-variant of the dialog (tool="ideogram"). Separate state
  // slot so only one dialog opens at a time — opening the Ideogram
  // editor doesn't tear down a half-typed Gemini Tweak instruction.
  const handleOpenIdeogramEdit = useCallback(
    (fileId: string, provider: EnhanceProvider) => {
      const jobId = enhanceJobs.get(fileId)?.get(provider);
      if (!jobId) return;
      const completedItem = completed.get(jobId);
      if (!completedItem) return;
      setIdeogramEditTarget({
        fileId,
        provider,
        jobId,
        sourceAssetId: completedItem.outputAssetId,
        sourceUrl:     completedItem.outputUrl,
      });
    },
    [enhanceJobs, completed],
  );

  const handleIdeogramEditAccept = useCallback(
    (result: TweakDialogResult) => {
      if (!ideogramEditTarget) return;
      const { jobId } = ideogramEditTarget;
      setCompleted((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, {
          ...cur,
          outputAssetId: result.outputAssetId,
          outputUrl:     result.outputUrl,
        });
        return next;
      });
      setJobStateMap((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, { ...cur, outputAssetId: result.outputAssetId });
        return next;
      });
      setIdeogramEditTarget(null);
    },
    [ideogramEditTarget],
  );

  // Ideogram inpaint — mask-based sibling to Erase, same patch-in-place
  // semantics. The EraseDialog renders the canvas and exports the mask;
  // tool="ideogram" tells the worker to route through Ideogram inpaint.
  const handleOpenIdeogramInpaint = useCallback(
    (fileId: string, provider: EnhanceProvider) => {
      const jobId = enhanceJobs.get(fileId)?.get(provider);
      if (!jobId) return;
      const completedItem = completed.get(jobId);
      if (!completedItem) return;
      setIdeogramInpaintTarget({
        fileId,
        provider,
        jobId,
        sourceAssetId: completedItem.outputAssetId,
        sourceUrl:     completedItem.outputUrl,
      });
    },
    [enhanceJobs, completed],
  );

  const handleIdeogramInpaintAccept = useCallback(
    (result: EraseDialogResult) => {
      if (!ideogramInpaintTarget) return;
      const { jobId } = ideogramInpaintTarget;
      setCompleted((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, {
          ...cur,
          outputAssetId: result.outputAssetId,
          outputUrl:     result.outputUrl,
        });
        return next;
      });
      setJobStateMap((prev) => {
        const cur = prev.get(jobId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(jobId, { ...cur, outputAssetId: result.outputAssetId });
        return next;
      });
      setIdeogramInpaintTarget(null);
    },
    [ideogramInpaintTarget],
  );

  // ─── Derived: SourceCompareCard inputs ─────────────────────────────────

  const variantsByFile = useMemo(() => {
    const out = new Map<string, Partial<Record<EnhanceProvider, SourceVariant>>>();
    for (const f of files) {
      const fileJobs = enhanceJobs.get(f.id);
      if (!fileJobs) continue;
      const variants: Partial<Record<EnhanceProvider, SourceVariant>> = {};
      for (const [provider, jobId] of fileJobs) {
        const job = jobStateMap.get(jobId);
        const completedItem = completed.get(jobId);
        variants[provider] = {
          jobId,
          job,
          outputUrl: completedItem?.outputUrl,
          error: job?.error,
        };
      }
      out.set(f.id, variants);
    }
    return out;
  }, [files, enhanceJobs, jobStateMap, completed]);

  // Memoized ready set — items to send. A "ready" item is:
  //   • not held
  //   • has a winner pick
  //   • the winner's jobId has a completed entry
  //   • the winner's jobId hasn't already been sent
  const readyToSend = useMemo(() => {
    const out: CompletedEnhanceItem[] = [];
    for (const f of files) {
      if (heldFiles.has(f.id)) continue;
      const chosen = chosenByFile.get(f.id);
      if (!chosen) continue;
      const variants = enhanceJobs.get(f.id);
      const jobId = variants?.get(chosen);
      if (!jobId || sentJobIds.has(jobId)) continue;
      const item = completed.get(jobId);
      if (item) out.push(item);
    }
    return out;
  }, [files, heldFiles, chosenByFile, enhanceJobs, completed, sentJobIds]);

  // Auto-advance — when ON and there's something ready, ship it. We capture
  // the jobIds into sentJobIds in the same tick so the effect doesn't loop.
  // readyToSend identity changes with each completion — that's fine; once
  // its items are folded into sentJobIds the memo re-derives to [].
  useEffect(() => {
    if (!autoAdvance || readyToSend.length === 0) return;
    onSendToScan(readyToSend);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: forwarding to Scan + marking sent in lock-step is the whole side-effect; marking sent is what prevents the re-derive loop.
    setSentJobIds((prev) => {
      const next = new Set(prev);
      for (const it of readyToSend) next.add(it.jobId);
      return next;
    });
  }, [autoAdvance, readyToSend, onSendToScan]);

  // Manual "Send N to Scan →" CTA handler used by CommandBar.
  const handleSendAll = useCallback(() => {
    if (readyToSend.length === 0) return;
    onSendToScan(readyToSend);
    setSentJobIds((prev) => {
      const next = new Set(prev);
      for (const it of readyToSend) next.add(it.jobId);
      return next;
    });
  }, [readyToSend, onSendToScan]);

  // "Skip Scan → Send N to Resize" CTA handler, rendered inline with
  // handleSendAll inside CommandBar so both buttons match in size.
  const handleSkipScan = useCallback(() => {
    if (readyToSend.length === 0) return;
    onSendToResize(readyToSend);
    setSentJobIds((prev) => {
      const next = new Set(prev);
      for (const it of readyToSend) next.add(it.jobId);
      return next;
    });
  }, [readyToSend, onSendToResize]);

  // ─── CommandBar tallies ────────────────────────────────────────────────

  const commandCounts = useMemo(() => {
    let ready = 0;
    let working = 0;
    let undecided = 0;
    let held = 0;
    for (const f of files) {
      const fileJobs = enhanceJobs.get(f.id);
      if (!fileJobs || fileJobs.size === 0) continue;
      if (heldFiles.has(f.id)) {
        held++;
        continue;
      }
      let allTerminal = true;
      let anyComplete = false;
      for (const jobId of fileJobs.values()) {
        const job = jobStateMap.get(jobId);
        const status = job?.status;
        if (status === "complete") anyComplete = true;
        if (status !== "complete" && status !== "failed" && status !== "cancelled") {
          allTerminal = false;
        }
      }
      const chosen = chosenByFile.get(f.id);
      const chosenJobId = chosen ? fileJobs.get(chosen) : undefined;
      const chosenJobStatus = chosenJobId ? jobStateMap.get(chosenJobId)?.status : undefined;
      const chosenComplete = chosenJobStatus === "complete";
      const isSent = chosenJobId ? sentJobIds.has(chosenJobId) : false;

      // Bucket priority (top to bottom):
      //   1. ready    — operator has picked a winner AND that winner's
      //                 variant is complete AND not yet sent. The OTHER
      //                 providers for this source may still be in flight;
      //                 the operator's pick is enough to ship now. This
      //                 used to require `allTerminal` which forced
      //                 operators to wait for the slowest provider; the
      //                 new ordering lets them move early.
      //   2. working  — at least one provider is still running and there's
      //                 nothing shippable yet.
      //   3. undecided — everything settled, at least one variant
      //                 completed, but no winner picked.
      if (chosen && chosenComplete && !isSent) {
        ready++;
      } else if (!allTerminal) {
        working++;
      } else if (anyComplete && !chosen) {
        undecided++;
      }
    }
    return { ready, working, undecided, held };
  }, [files, enhanceJobs, jobStateMap, heldFiles, chosenByFile, sentJobIds]);

  // ─── Render ────────────────────────────────────────────────────────────

  const pendingCount = files.filter((f) => f.status === "pending").length;
  const doneCount    = files.filter((f) => f.status === "done").length;

  // Active jobIds — used to mount one headless poller per active job.
  const activeJobIds = useMemo(() => {
    const out: Array<{ jobId: string; fileId: string; provider: EnhanceProvider }> = [];
    for (const f of files) {
      const fileJobs = enhanceJobs.get(f.id);
      if (!fileJobs) continue;
      for (const [provider, jobId] of fileJobs) {
        out.push({ jobId, fileId: f.id, provider });
      }
    }
    return out;
  }, [files, enhanceJobs]);

  const handleClearAll = () => {
    files.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    setFiles([]);
    setEnhanceJobs(new Map());
    setCompleted(new Map());
    setSentJobIds(new Set());
    setJobStateMap(new Map());
    setChosenByFile(new Map());
    setHeldFiles(new Set());
    onClearPipeline();
    setGlobalError(null);
    setTogglesDirty(false);
    resetDoneForBatchRef.current = false;
  };

  return (
    <div className="space-y-4">

      {/* ── Plain-language explanation of what this tab is for ── */}
      <TipBanner
        title="Enhance tab — what this does"
        steps={[
          <>Drop the photos of one forklift in the upload zone below (up to 10 at once).</>,
          <>Fill in the equipment details (Make is required) so the AI uses the right brand colours and rules.</>,
          <>Pick one or more AI models to compare results side-by-side. Each model produces its own version of every photo.</>,
          <>Click <span className="font-semibold text-white">Enhance</span> and wait for the variants to come back.</>,
          <>For each photo, pick the winner variant. Use ↻ to retry, ✎ to tweak with words, or ⌫ to erase part of an image.</>,
          <>When you&apos;re happy with every photo, click <span className="font-semibold text-white">Send to Scan →</span> to move them forward.</>,
        ]}
      >
        <p>
          This is where raw used-forklift photos become clean,
          listing-ready images. Each AI model does its own version of
          your photos so you can pick the best one.
        </p>
      </TipBanner>

      {/* ── Per-variant Erase dialog (singleton) — Flux backend ── */}
      <EraseDialog
        open={eraseTarget !== null}
        sessionId={sessionId}
        sourceAssetId={eraseTarget?.sourceAssetId ?? ""}
        sourceImageUrl={eraseTarget?.sourceUrl ?? ""}
        tool="flux"
        onClose={() => setEraseTarget(null)}
        onAccept={handleEraseAccept}
      />

      {/* ── Per-variant Ideogram inpaint dialog (singleton) ── */}
      <EraseDialog
        open={ideogramInpaintTarget !== null}
        sessionId={sessionId}
        sourceAssetId={ideogramInpaintTarget?.sourceAssetId ?? ""}
        sourceImageUrl={ideogramInpaintTarget?.sourceUrl ?? ""}
        tool="ideogram"
        onClose={() => setIdeogramInpaintTarget(null)}
        onAccept={handleIdeogramInpaintAccept}
      />

      {/* ── Per-variant Tweak dialog (singleton) — Gemini backend ── */}
      <TweakDialog
        open={tweakTarget !== null}
        sessionId={sessionId}
        sourceAssetId={tweakTarget?.sourceAssetId ?? ""}
        sourceImageUrl={tweakTarget?.sourceUrl ?? ""}
        tool="gemini"
        onClose={() => setTweakTarget(null)}
        onAccept={handleTweakAccept}
      />

      {/* ── Per-variant Ideogram edit dialog (singleton) ── */}
      <TweakDialog
        open={ideogramEditTarget !== null}
        sessionId={sessionId}
        sourceAssetId={ideogramEditTarget?.sourceAssetId ?? ""}
        sourceImageUrl={ideogramEditTarget?.sourceUrl ?? ""}
        tool="ideogram"
        onClose={() => setIdeogramEditTarget(null)}
        onAccept={handleIdeogramEditAccept}
      />

      {/* ── Headless pollers ── */}
      {activeJobIds.map(({ jobId, fileId, provider }) => {
        const file = files.find((f) => f.id === fileId);
        if (!file) return null;
        return (
          <JobPollerHeadless
            key={jobId}
            jobId={jobId}
            onUpdate={(job) => updateJobState(jobId, job)}
            onComplete={(job) => handleJobComplete(file, provider, job)}
            onError={handleJobError}
          />
        );
      })}

      {/* ── Drop zone ── */}
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => fileInputRef.current?.click()}
        className={`
          relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
          ${files.length >= MAX_UPLOADS
            ? "border-zinc-700 opacity-50 cursor-not-allowed"
            : "border-zinc-600 hover:border-blue-500 hover:bg-blue-950/20"}
        `}
      >
        <input
          ref={fileInputRef}
          id={inputId}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          onChange={handleFileInput}
          disabled={files.length >= MAX_UPLOADS}
        />
        <div className="flex flex-col items-center gap-2 pointer-events-none">
          <svg className="w-10 h-10 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          <p className="text-lg font-semibold text-zinc-100">
            {files.length >= MAX_UPLOADS
              ? `Maximum ${MAX_UPLOADS} images reached`
              : `Drop images here or click to browse`}
          </p>
          <p className="text-sm text-zinc-300 mt-1">
            Up to {MAX_UPLOADS} images · Files over 4.5 MB auto-compressed
            · {files.length}/{MAX_UPLOADS} loaded
          </p>
        </div>
      </div>

      {/* ── Pending-thumbnail grid ── */}
      {files.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-bold text-zinc-100">
              {files.length} image{files.length !== 1 ? "s" : ""} loaded
              {doneCount > 0 && (
                <span className="ml-2 text-green-300">· {doneCount} uploaded</span>
              )}
            </h3>
            <button
              onClick={handleClearAll}
              className="text-sm font-bold text-zinc-200 hover:text-red-300 transition-colors border border-zinc-700 hover:border-red-600 rounded px-3 py-1.5"
            >
              Clear all
            </button>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-11 gap-2">
            {files.map((f) => (
              <div key={f.id} className="relative group">
                <ThumbnailCard file={f} />
                <button
                  onClick={() => removeFile(f.id)}
                  className="absolute -top-1.5 -right-1.5 bg-red-600 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                  aria-label={`Remove ${f.file.name}`}
                >
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Forklift metadata (lifted) ── */}
      <MetaCard
        meta={meta}
        onChange={setMeta}
        expanded={metaExpanded}
        onExpand={setMetaExpanded}
      />
      {makeValid && files.length > 0 && (
        <p className="-mt-2 text-[11px] text-zinc-500 font-mono px-1">
          Files will be uploaded as{" "}
          <span className="text-zinc-300">
            {buildEnhanceFilename(meta, 0, Math.max(files.length, 1))}
          </span>
          {files.length > 1 && (
            <>
              {" "}through{" "}
              <span className="text-zinc-300">
                {buildEnhanceFilename(meta, files.length - 1, files.length)}
              </span>
            </>
          )}
        </p>
      )}

      {/* ── Provider chips ── */}
      <ProviderRow
        selected={selectedProviders}
        onToggle={toggleProvider}
        onSelectAll={selectAllProviders}
      />

      {/* ── Advanced (toggles + custom prompt) ── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="w-full flex items-center justify-between px-5 py-4 bg-zinc-900/30 hover:bg-zinc-900/50 transition-colors text-left"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-base font-semibold uppercase tracking-[0.14em] text-zinc-100">
              Advanced
            </span>
            <span className="text-sm uppercase tracking-[0.16em] text-zinc-300">
              Optional emphasis + custom prompt
            </span>
            {customPromptActive && (
              <span className="text-xs uppercase tracking-[0.18em] font-bold text-amber-200 bg-amber-900/60 border border-amber-700 rounded px-2 py-0.5">
                Prompt active
              </span>
            )}
          </div>
          <svg
            className={`w-5 h-5 text-zinc-200 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {advancedOpen && (
          <div className="border-t border-zinc-900 p-5 space-y-5">
            <div
              aria-disabled={customPromptActive || undefined}
              className={customPromptActive ? "opacity-40 pointer-events-none" : ""}
            >
              <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
                <h3 className="text-lg font-semibold text-zinc-100">
                  Optional emphasis
                  {customPromptActive && (
                    <span className="ml-2 text-sm uppercase tracking-[0.16em] text-amber-300">
                      disabled — custom prompt active
                    </span>
                  )}
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setToggles(DEFAULT_TOGGLES);
                    markUserToggleChange();
                  }}
                  className="text-sm text-zinc-300 hover:text-white transition-colors font-semibold"
                >
                  Reset
                </button>
              </div>
              <p className="text-sm text-zinc-200 mb-4 leading-relaxed">
                Every enhance run already does the standard makeover (paint
                refresh, decal restoration, rust cleanup, tire shine, lighting
                correction). The toggles below add{" "}
                <span className="font-semibold text-yellow-300">extra emphasis</span>{" "}
                on a specific area, or kick in a{" "}
                <span className="font-semibold text-yellow-300">specific action</span>{" "}
                (like painting the forks red, or removing rental decals). Leave
                them off if the standard treatment is already doing what you
                want — these are nudges, not requirements.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(Object.keys(TOGGLE_LABELS) as Array<keyof EnhanceToggles>)
                  // paintForksRedYellowTips applies to fork-carrying
                  // equipment (forklifts + telehandlers). Scissor lifts
                  // have no forks, so hide the toggle for those. Backend
                  // also defensively skips the bullet if the type slips
                  // through with the toggle on.
                  .filter((key) => {
                    if (key !== "paintForksRedYellowTips") return true;
                    const et = meta.equipmentType ?? "forklift";
                    return et === "forklift" || et === "telehandler";
                  })
                  .map((key) => (
                    <ToggleSwitch
                      key={key}
                      id={`toggle-${key}`}
                      label={TOGGLE_LABELS[key]}
                      description={TOGGLE_DESCRIPTIONS[key]}
                      checked={toggles[key]}
                      onChange={(v) => {
                        setToggles((prev) => ({ ...prev, [key]: v }));
                        markUserToggleChange();
                      }}
                    />
                  ))}
              </div>
            </div>

            <div className="border-t border-zinc-900 pt-5 space-y-3">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={() => setCustomPromptOpen((v) => !v)}
                  aria-expanded={customPromptOpen}
                  className="text-base font-semibold uppercase tracking-[0.14em] text-zinc-100 hover:text-white transition-colors flex items-center gap-2"
                >
                  <svg
                    className={`w-4 h-4 text-zinc-300 transition-transform ${customPromptOpen ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                  Custom prompt
                </button>
                <span className="text-sm text-zinc-300">
                  Advanced — overrides every toggle above
                </span>
              </div>

              {customPromptOpen && (
                <>
                  <div
                    role="alert"
                    className="flex items-start gap-3 rounded-lg border border-amber-900 bg-amber-950/30 px-4 py-3"
                  >
                    <svg
                      className="w-5 h-5 text-amber-300 mt-0.5 shrink-0"
                      fill="none" viewBox="0 0 24 24" stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <p className="text-sm text-amber-100 leading-relaxed">
                      <span className="font-semibold">Power-user only.</span> A
                      custom prompt completely replaces the carefully-tuned
                      default and is sent to the AI verbatim. The built-in
                      safety clauses (preserve make / model / decals /
                      proportions, keep used-character signs visible, avoid
                      bait-and-switch) are <span className="font-semibold">NOT</span>{" "}
                      automatically added — you have to write them in yourself
                      if they matter. Results can be unpredictable. Use this
                      only when you know exactly what you want and the toggles
                      above can&apos;t express it.
                    </p>
                  </div>
                  <textarea
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    placeholder="Example: Repaint this forklift in matte black with red OSHA forks, keep all decals intact, soft studio lighting."
                    rows={5}
                    className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-base text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition font-mono leading-relaxed"
                  />
                  <p className="text-sm text-zinc-300">
                    Clear the textarea above to re-enable the standard
                    toggles. The textarea has to be empty (no trailing
                    spaces) for the toggle path to kick back in.
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Global error ── */}
      {globalError && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3" role="alert">
          {globalError}
        </p>
      )}

      {/* ── Enhance button ── */}
      {(() => {
        const reEnhanceCount = files.filter(
          (f) => f.status === "done" && f.assetId,
        ).length;
        const canReEnhance =
          togglesDirty && batchTerminal && reEnhanceCount > 0;
        const buttonActive =
          (pendingCount > 0 || canReEnhance) && makeValid && !isRunning;
        const onClick = pendingCount > 0 ? handleEnhanceAll : handleReEnhance;
        const pluralPending = pendingCount !== 1 ? "s" : "";
        const pluralReRun = reEnhanceCount !== 1 ? "s" : "";
        return (
          <button
            onClick={onClick}
            disabled={!buttonActive}
            className={`
              w-full py-3 px-6 rounded-xl font-semibold text-sm transition-all
              ${buttonActive
                ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40"
                : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}
            `}
          >
            {isRunning
              ? "Converting, uploading & enhancing…"
              : pendingCount > 0
                ? !makeValid
                  ? "Enter forklift Make to continue"
                  : customPromptActive
                    ? `Enhance ${pendingCount} Image${pluralPending} (custom prompt)`
                    : `Enhance ${pendingCount} Image${pluralPending}`
                : canReEnhance
                  ? !makeValid
                    ? "Enter forklift Make to continue"
                    : customPromptActive
                      ? `Re-enhance ${reEnhanceCount} Image${pluralReRun} (custom prompt)`
                      : `Re-enhance ${reEnhanceCount} Image${pluralReRun} with new toggles`
                  : doneCount > 0
                    ? "All images processing"
                    : "Add images above"}
          </button>
        );
      })()}

      {/* ── SourceCompareCards ── */}
      {(enhanceJobs.size > 0 || isRunning) && (
        <div ref={jobsSectionRef} className="space-y-3 scroll-mt-4">
          <header className="flex items-baseline justify-between pt-1 flex-wrap gap-2">
            <h2 className="text-xl font-bold text-white uppercase tracking-[0.14em]">
              Results — {variantsByFile.size} image{variantsByFile.size !== 1 ? "s" : ""}
            </h2>
            <span className="text-sm text-zinc-200 italic">
              One card per source · all providers compared side-by-side
            </span>
          </header>

          {enhanceJobs.size === 0 && isRunning && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-6 text-center text-xs text-zinc-500 flex items-center justify-center gap-2">
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Preparing batch — converting to JPEG, uploading, and enqueueing…
            </div>
          )}

          {/* Single column at every breakpoint. The 2-col xl layout
              shrank variants to ~half the size they need to be for
              close inspection (operator needs ≥85% of original size to
              spot subtle paint / decal differences). Scroll length on
              big batches is a known trade-off. */}
          <div className="flex flex-col gap-3 pb-4">
            {files.map((f) => {
              const variants = variantsByFile.get(f.id);
              if (!variants) return null;
              const chosen = chosenByFile.get(f.id) ?? null;
              const chosenJobId = chosen ? enhanceJobs.get(f.id)?.get(chosen) : undefined;
              const isSent = chosenJobId ? sentJobIds.has(chosenJobId) : false;
              return (
                <SourceCompareCard
                  key={f.id}
                  file={f}
                  variants={variants}
                  chosen={chosen}
                  held={heldFiles.has(f.id)}
                  autoAdvance={autoAdvance}
                  sent={isSent}
                  nowMs={nowMs}
                  onChoose={(provider) => chooseWinner(f.id, provider)}
                  onToggleHold={() => toggleHold(f.id)}
                  onRetry={(provider) => retryProvider(f, provider)}
                  onErase={(provider) => handleOpenErase(f.id, provider)}
                  onTweak={(provider) => handleOpenTweak(f.id, provider)}
                  onIdeogramEdit={(provider) => handleOpenIdeogramEdit(f.id, provider)}
                  onIdeogramInpaint={(provider) => handleOpenIdeogramInpaint(f.id, provider)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* ── Model attribution ── */}
      {enhanceJobs.size > 0 && (
        <p className="text-[11px] text-zinc-700 text-center">
          Enhancement powered by{" "}
          {ENHANCE_PROVIDERS.filter((p) => selectedProviders.has(p)).map((p, i, arr) => (
            <span key={p}>
              <code className="font-mono">{ENHANCE_PROVIDER_LABELS[p]}</code>
              {i < arr.length - 1 ? " · " : ""}
            </span>
          ))}
        </p>
      )}

      {/* ── Sticky command bar — Send to Scan + Skip Scan render inline
            so they're the same size and read as a pair. ── */}
      {enhanceJobs.size > 0 && (
        <CommandBar
          readyCount={commandCounts.ready}
          workingCount={commandCounts.working}
          undecidedCount={commandCounts.undecided}
          heldCount={commandCounts.held}
          autoAdvance={autoAdvance}
          onSendAll={handleSendAll}
          onSkipScan={handleSkipScan}
        />
      )}
    </div>
  );
}
