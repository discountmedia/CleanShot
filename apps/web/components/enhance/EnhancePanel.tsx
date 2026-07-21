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
//   • heldFiles:    Set<fileId> (per-card opt-out from the bulk Send to Scan)
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
  judgeVariants,
  uploadToGcs,
  type JudgeResult,
} from "../../lib/api";
import { buildRecommendedPrompt } from "../../lib/recommended-prompt";
import { useJobPoller } from "../../lib/polling";
import {
  ENHANCE_PROVIDERS,
  ENHANCE_PROVIDER_LABELS,
  type EnhanceProvider,
} from "../../lib/types-enhance";
import type { UserRestriction } from "../../lib/access-control";

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
// Modify-tab darkroom controls relocated to live INSIDE Enhance below the
// variants grid (2026-06-01) — the Modify tab itself is being deleted.
// Embedded mode hides the TipBanner + standalone uploader.
import { ModifyPanel } from "../modify/ModifyPanel";
import { ExportControls } from "../export/ExportControls";

const MAX_UPLOADS = 150;

// ─── Pending-upload thumbnail (used in the drop-zone grid) ─────────────────

function ThumbnailCard({ file }: { file: UploadFile }) {
  return (
    <div className="relative group rounded-lg overflow-hidden bg-zinc-900 border border-zinc-800">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={file.previewUrl}
        alt={file.file.name}
        /* Explicit 1:1 dims belt-and-suspender the aspect-square
           Tailwind class — the CSS already enforces the square but
           the width/height attrs let the browser establish the aspect
           ratio before the blob image decodes, killing any micro-CLS
           on the upload grid (Real Experience Score fix 2026-05-27). */
        width={300}
        height={300}
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
  /**
   * Asset id of the ORIGINAL pre-enhance photo this variant was generated
   * from. Threaded to the Scan tab so it can run a differential (before/
   * after) scan instead of judging the enhanced output in isolation.
   */
  sourceAssetId: string;
}

export interface EnhancePanelProps {
  sessionId: string;
  meta: Partial<ForkliftMeta>;
  onMetaChange: (meta: Partial<ForkliftMeta>) => void;
  onSendToScan: (items: CompletedEnhanceItem[]) => void;
  onClearPipeline: () => void;
  /** Lets Workspace render the BatchContextStrip image count. */
  onFileCountChange: (count: number) => void;
  /** Signed-in user's email — threaded into the embedded ExportControls. */
  userEmail: string;
  /**
   * Per-user access restriction (null = unrestricted). When set, the
   * model picker collapses to the single locked model, feature toggles
   * are hidden, the custom prompt auto-expands as the primary input,
   * and the metadata fields hide (equipment type stays). UI gating only
   * — the model lock is also enforced server-side in /api/enhance.
   */
  restriction?: UserRestriction | null;
}

export function EnhancePanel({
  sessionId,
  meta,
  onMetaChange,
  onSendToScan,
  onClearPipeline,
  onFileCountChange,
  userEmail,
  restriction = null,
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

  // Restricted users are locked to exactly one model; everyone else
  // starts on gemini and can multi-select.
  const [selectedProviders, setSelectedProviders] = useState<Set<EnhanceProvider>>(
    () => new Set<EnhanceProvider>([restriction?.model ?? "gemini"]),
  );

  // The per-provider master-prompt "Prompt:" dropdown was removed — every
  // enhance flows through the single built-in prompt. No prompt_choice is
  // sent, so the backend resolves to its procedural builder.

  // The operator's prompt — now the PRIMARY, required Enhance input
  // (2026-07-21 prompt-first redesign). Always visible; no collapse.
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
  // Prompt-first (2026-07-21): a non-empty prompt is now REQUIRED to enhance,
  // alongside Make. (Restricted custom-prompt-only users have no Make field, so
  // their gate stays prompt-only — inert now that access-control is defanged,
  // kept for shape.)
  const metaGate = restriction?.customPromptOnly
    ? customPromptActive
    : makeValid && customPromptActive;

  // Completed-jobs map and "have we already sent this to Scan?" set —
  // preserved from the prior implementation. Keyed by jobId so each
  // (file × provider) pair has its own entry.
  const [completed, setCompleted] = useState<Map<string, CompletedEnhanceItem>>(new Map());
  const [sentJobIds, setSentJobIds] = useState<Set<string>>(new Set());

  // Hoisted from the old JobStatusRow internal state so the variant
  // thumbnails can share poll updates. Keyed by jobId.
  const [jobStateMap, setJobStateMap] = useState<Map<string, JobRecord>>(new Map());

  // Operator's winner pick per source file, and the per-file Hold opt-out
  // from the bulk Send to Scan. These replace the old `selectedJobIds`.
  const [chosenByFile, setChosenByFile] = useState<Map<string, EnhanceProvider>>(new Map());
  const [heldFiles, setHeldFiles] = useState<Set<string>>(new Set());

  // Auto-pick "best of N" judge state.
  //   • judgeByFile   — the completed ranking per source file (drives the
  //                     "★ Best of N" winner badge + the judge's reason).
  //   • judgingFiles  — files whose judge call is in flight (drives the
  //                     transient "judging…" badge).
  //   • judgeStartedRef — one-shot guard so the auto-judge effect fires the
  //                     judge EXACTLY once per file. A ref (not state) because
  //                     the effect re-runs on every job-state change and we
  //                     must not re-fire; refs also don't trigger re-renders.
  //                     Reset alongside the other batch state on re-enhance /
  //                     clear so a fresh batch judges cleanly.
  const [judgeByFile, setJudgeByFile] = useState<Map<string, JudgeResult>>(new Map());
  const [judgingFiles, setJudgingFiles] = useState<Set<string>>(new Set());
  const judgeStartedRef = useRef<Set<string>>(new Set());
  // Monotonic batch token, bumped on every batch reset (fresh enhance /
  // re-enhance / clear). The auto-judge effect captures it before firing the
  // async judge; its continuations no-op if it changed — so a judge still in
  // flight when the operator resets can't write the OLD batch's winner onto the
  // NEW batch (which reuses the same file ids). Paired with a
  // judgeStartedRef.has(fileId) recheck that additionally covers a per-file
  // Retry (retryProvider drops the file from judgeStartedRef).
  const judgeEpochRef = useRef(0);

  // Mirror of enhanceJobs so handleJobComplete (memoized with stable
  // deps so the poller's callback identity stays steady across re-
  // renders) can read the AT-SUBMIT-TIME per-file provider count from
  // inside its closure. We deliberately gate auto-pick on what was
  // enqueued for THIS file, not on the live selectedProviders set —
  // the operator can untick a provider mid-batch and that should not
  // retroactively make the still-running variants of that batch look
  // "uncontested." Bare assign during render is the canonical "latest
  // snapshot for callbacks" pattern.
  const enhanceJobsRef = useRef(enhanceJobs);
  enhanceJobsRef.current = enhanceJobs;

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
              sourceAssetId: file.assetId ?? "",
            });
            return next;
          });
          // Narrow auto-pick: when EXACTLY one provider was enqueued for
          // THIS file, the variant that just completed is trivially the
          // winner — there's no other candidate to compare against. The
          // embedded Darkroom (which now filters to chosen winners only)
          // would otherwise appear empty for the dominant single-
          // provider Gemini case. Skipped when a manual pick already
          // exists. We read the per-file enqueued count from
          // enhanceJobsRef so toggling a provider on/off AFTER submit
          // doesn't retroactively change which files qualify — only
          // what the batch was actually enqueued with counts.
          if ((enhanceJobsRef.current.get(file.id)?.size ?? 0) === 1) {
            setChosenByFile((prev) => {
              if (prev.has(file.id)) return prev;
              const next = new Map(prev);
              next.set(file.id, provider);
              return next;
            });
          }
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

  // ─── Auto-pick "best of N" ─────────────────────────────────────────────
  //
  // Once a MULTI-provider batch for a source image goes terminal, ask the
  // judge to rank the surviving variants and auto-select the winner. This is
  // the whole point of fanning out to N providers — the operator sees one
  // vetted image instead of grading three. Everything downstream (Darkroom,
  // Export, Send-to-Scan) already filters to `chosenByFile`, so setting the
  // winner here is all that's needed to collapse the choice.
  //
  // Single-provider files are handled in handleJobComplete (trivial winner).
  // We only act when >= 2 providers were enqueued. Failure is soft: if the
  // judge errors or is unavailable (503), we leave the file for a manual pick
  // — exactly today's behaviour.
  useEffect(() => {
    for (const f of files) {
      if (judgeStartedRef.current.has(f.id)) continue;   // one-shot per file
      if (chosenByFile.has(f.id)) continue;              // pick already exists
      const fileJobs = enhanceJobs.get(f.id);
      if (!fileJobs || fileJobs.size < 2) continue;      // single-provider → handleJobComplete

      // Ready = every job terminal AND every completed job has its asset URL
      // resolved (handleJobComplete populates `completed` a beat after the
      // status flips to "complete" — waiting for it closes that race so we
      // never judge a partial candidate set).
      let ready = true;
      const survivors: Array<{ provider: EnhanceProvider; assetId: string }> = [];
      for (const [provider, jobId] of fileJobs) {
        const status = jobStateMap.get(jobId)?.status;
        if (status !== "complete" && status !== "failed" && status !== "cancelled") {
          ready = false;
          break;
        }
        if (status === "complete") {
          const item = completed.get(jobId);
          if (!item) { ready = false; break; }
          survivors.push({ provider, assetId: item.outputAssetId });
        }
      }
      if (!ready) continue;

      // Mark started BEFORE any async work so a re-render mid-flight (or
      // React strict-mode double-invoke) can't double-fire the judge.
      judgeStartedRef.current.add(f.id);

      if (survivors.length === 0) continue;              // all failed — nothing to pick
      if (survivors.length === 1) {
        // Only one provider survived → trivially the winner, no judge call.
        const only = survivors[0];
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: one-shot per file (judgeStartedRef) + prev.has() guard, so no cascade.
        setChosenByFile((prev) =>
          prev.has(f.id) ? prev : new Map(prev).set(f.id, only.provider),
        );
        continue;
      }

      // >= 2 survivors → judge. Capture the batch token; if a reset (epoch
      // bump) or a per-file Retry (drops f.id from judgeStartedRef) lands while
      // this ~10s call is in flight, isStale() makes the continuations no-op so
      // a stale winner/ranking can't be written onto a since-reset/retried
      // batch (which reuses the same file id).
      const epoch = judgeEpochRef.current;
      const isStale = () =>
        epoch !== judgeEpochRef.current || !judgeStartedRef.current.has(f.id);
      setJudgingFiles((prev) => new Set(prev).add(f.id));
      judgeVariants({
        sessionId,
        originalAssetId: f.assetId ?? undefined,
        candidates: survivors.map((s) => ({ provider: s.provider, assetId: s.assetId })),
        equipmentType: meta.equipmentType ?? undefined,
        make: meta.make?.trim() || undefined,
      })
        .then((result) => {
          if (isStale()) return;   // batch reset / file retried mid-flight — drop
          setJudgeByFile((prev) => new Map(prev).set(f.id, result));
          // Respect an operator pick made while the judge was thinking.
          setChosenByFile((prev) =>
            prev.has(f.id)
              ? prev
              : new Map(prev).set(f.id, result.winnerProvider as EnhanceProvider),
          );
        })
        .catch((err: Error) => {
          console.warn(
            "[enhance] variant judge failed — leaving winner for manual pick",
            err,
          );
        })
        .finally(() => {
          if (isStale()) return;   // reset/retry already cleared judgingFiles
          setJudgingFiles((prev) => {
            if (!prev.has(f.id)) return prev;
            const next = new Set(prev);
            next.delete(f.id);
            return next;
          });
        });
    }
  }, [
    files,
    enhanceJobs,
    jobStateMap,
    completed,
    chosenByFile,
    sessionId,
    meta.equipmentType,
    meta.make,
  ]);

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
          // A retry replaces one variant, so any prior best-of-N ranking for
          // this file is stale. Drop it + re-arm the one-shot so the file is
          // re-judged once the new variant lands (the effect still won't run
          // until the pick is clear), and clear any in-flight "judging" spinner.
          // Dropping f.id from judgeStartedRef also makes an in-flight judge's
          // late continuation no-op (see the isStale() guard in the effect).
          judgeStartedRef.current.delete(file.id);
          setJudgeByFile((prev) => {
            if (!prev.has(file.id)) return prev;
            const next = new Map(prev);
            next.delete(file.id);
            return next;
          });
          setJudgingFiles((prev) => {
            if (!prev.has(file.id)) return prev;
            const next = new Set(prev);
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
    if (!metaGate) {
      setGlobalError(
        restriction?.customPromptOnly
          ? "Enter a custom prompt before enhancing."
          : "Enter the forklift Make before enhancing.",
      );
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
        setJudgeByFile(new Map());
        setJudgingFiles(new Set());
        judgeStartedRef.current = new Set();
        judgeEpochRef.current += 1;   // invalidate any in-flight judge from the prior batch
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
    if (!metaGate) {
      setGlobalError(
        restriction?.customPromptOnly
          ? "Enter a custom prompt before enhancing."
          : "Enter the forklift Make before enhancing.",
      );
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
    setJudgeByFile(new Map());
    setJudgingFiles(new Set());
    judgeStartedRef.current = new Set();
    judgeEpochRef.current += 1;   // invalidate any in-flight judge from the prior batch
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
    metaGate,
    restriction,
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

  // Sibling of readyToSend used by the embedded Darkroom panel below.
  // Same winner-resolution chain (file → chosenByFile → enhanceJobs
  // [file][chosen] → completed[jobId]) and ALSO filters held files so
  // "Hold" reads consistently as "exclude from every batch operation"
  // — without this filter, an operator who held a file before its job
  // completed (and lost track of which they held) would silently get
  // batch slider adjustments applied to it. Unlike readyToSend we do
  // NOT filter by sentJobIds: an already-sent variant may still need
  // a brighter re-pass before a subsequent Resize export.
  //
  // Returns the jobId alongside each item so onModifyApplied can patch
  // results back keyed by assetId → jobId. assetId is guaranteed
  // one-to-one with jobId (each job owns its own outputAssetId, and
  // every job ID is unique per batch), so building a Map<assetId,
  // jobId> never silently de-dupes.
  const pickedWinners = useMemo(() => {
    const out: Array<{ jobId: string; item: CompletedEnhanceItem }> = [];
    for (const f of files) {
      if (heldFiles.has(f.id)) continue;
      const chosen = chosenByFile.get(f.id);
      if (!chosen) continue;
      const jobId = enhanceJobs.get(f.id)?.get(chosen);
      if (!jobId) continue;
      const item = completed.get(jobId);
      if (item) out.push({ jobId, item });
    }
    return out;
  }, [files, heldFiles, chosenByFile, enhanceJobs, completed]);

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
    setJudgeByFile(new Map());
    setJudgingFiles(new Set());
    judgeStartedRef.current = new Set();
    judgeEpochRef.current += 1;   // invalidate any in-flight judge from the prior batch
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
        restriction={restriction}
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

      {/* ── AI provider picker (multi-select) ──
          Per-user model locking is gone (access-control USER_RESTRICTIONS
          is empty) but the multi-provider picker is back: operators pick
          any subset of models and get one variant per selected provider
          per source image. */}
      <ProviderRow
        selected={selectedProviders}
        onToggle={toggleProvider}
        onSelectAll={selectAllProviders}
      />

      {/* ── Prompt (required) + optional toggle add-ons ── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="w-full flex items-center justify-between px-5 py-4 bg-zinc-900/30 hover:bg-zinc-900/50 transition-colors text-left"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-base font-semibold uppercase tracking-[0.14em] text-zinc-100">
              Prompt
            </span>
            <span className="text-sm uppercase tracking-[0.16em] text-zinc-300">
              Write your own — toggles fine-tune it
            </span>
            {customPromptActive ? (
              <span className="text-xs uppercase tracking-[0.18em] font-bold text-emerald-200 bg-emerald-900/50 border border-emerald-700 rounded px-2 py-0.5">
                ✓ Prompt set
              </span>
            ) : (
              <span className="text-xs uppercase tracking-[0.18em] font-bold text-red-200 bg-red-900/50 border border-red-700 rounded px-2 py-0.5">
                Required
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
            {/* ── Your prompt — PRIMARY + required (prompt-first redesign,
                2026-07-21). The operator's own words drive the result;
                "Insert recommended prompt" gives unfamiliar users an
                equipment-aware starting point they then edit. The toggles
                below append to whatever ends up here, and the backend always
                adds the safety guardrails on top (custom_prompt is now the
                spine_override, not a verbatim override). */}
            <div className="space-y-3">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h3 className="text-lg font-semibold text-zinc-100">
                  Your prompt <span className="text-red-400">*</span>
                </h3>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setCustomPrompt(
                        buildRecommendedPrompt(meta.equipmentType ?? "forklift", {
                          make:  meta.make,
                          model: meta.model,
                          year:  meta.year,
                        }),
                      );
                      markUserToggleChange();
                    }}
                    className="text-sm font-bold text-sky-400 hover:text-sky-300 transition-colors"
                  >
                    {customPromptActive ? "Reset to recommended" : "Insert recommended prompt"}
                  </button>
                  {customPromptActive && (
                    <button
                      type="button"
                      onClick={() => {
                        setCustomPrompt("");
                        markUserToggleChange();
                      }}
                      className="text-sm text-zinc-300 hover:text-white transition-colors font-semibold"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <p className="text-base text-zinc-200 leading-relaxed">
                Describe how you want this machine to look, in your own words —{" "}
                <span className="font-semibold text-yellow-300">your prompt drives the result</span>.
                New to this? Click{" "}
                <span className="font-semibold">Insert recommended prompt</span>{" "}
                for a solid starting point and edit it to taste.
              </p>
              <textarea
                value={customPrompt}
                onChange={(e) => {
                  setCustomPrompt(e.target.value);
                  markUserToggleChange();
                }}
                placeholder="Example: Give this forklift a clean respray in its original orange, keep every decal, paint the forks red with yellow tips, glossy tire sidewalls, brighten the lighting, tidy the background."
                rows={6}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-base text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent transition leading-relaxed"
              />
              <p className="text-sm text-zinc-400 leading-relaxed">
                Your prompt is the base. The built-in safety guardrails (keep the
                real make / model / decals / proportions, no bait-and-switch) are
                always applied on top, and any toggles below append extra
                instructions.
              </p>
            </div>

            {/* ── Optional add-ons — toggles now AUGMENT the prompt above
                (they append emphasis / actions) rather than being overridden
                by it. Always enabled. (`disableToggles` guard is inert now that
                access-control is defanged — kept for shape.) */}
            {!restriction?.disableToggles && (
            <div className="border-t border-zinc-900 pt-5">
              <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
                <h3 className="text-lg font-semibold text-zinc-100">
                  Optional add-ons
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
              <p className="text-base text-zinc-200 mb-1.5 leading-relaxed">
                These{" "}
                <span className="font-semibold text-yellow-300">append to your prompt</span>{" "}
                above — extra emphasis (paint, rust, tire shine) or a specific
                action (paint forks red, remove rental decals).
              </p>
              <p className="text-base text-yellow-300 italic mb-4 leading-relaxed">
                (Optional — leave them all off to let your prompt stand on its own.)
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(Object.keys(TOGGLE_LABELS) as Array<keyof EnhanceToggles>)
                  // Equipment-conditional toggle visibility — keep in lock-step
                  // with the backend paint_forks_on / three_wheel gates:
                  //  • paintForksRedYellowTips — every type EXCEPT scissor_lift.
                  //  • threeWheel — ONLY when equipmentType is "forklift".
                  .filter((key) => {
                    const et = meta.equipmentType ?? "forklift";
                    if (key === "paintForksRedYellowTips") return et !== "scissor_lift";
                    if (key === "threeWheel")              return et === "forklift";
                    return true;
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
            )}
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
          (pendingCount > 0 || canReEnhance) && metaGate && !isRunning;
        const onClick = pendingCount > 0 ? handleEnhanceAll : handleReEnhance;
        const pluralPending = pendingCount !== 1 ? "s" : "";
        const pluralReRun = reEnhanceCount !== 1 ? "s" : "";
        // When metaGate is unmet, the prompt differs by user type:
        // restricted users need a custom prompt; everyone else needs Make.
        const gatePrompt = restriction?.customPromptOnly
          ? "Write or insert a prompt to continue"
          : !makeValid
            ? "Enter forklift Make to continue"
            : "Write or insert a prompt to continue";
        return (
          <button
            onClick={onClick}
            disabled={!buttonActive}
            className={`
              inline-flex py-3 px-6 rounded-lg font-bold text-base uppercase tracking-[0.12em] border-2 transition-all
              ${buttonActive
                ? "border-green-500 bg-green-600 hover:bg-green-500 text-white"
                : "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"}
            `}
          >
            {isRunning
              ? "Converting, uploading & enhancing…"
              : pendingCount > 0
                ? !metaGate
                  ? gatePrompt
                  : `Enhance ${pendingCount} Image${pluralPending}`
                : canReEnhance
                  ? !metaGate
                    ? gatePrompt
                    : `Re-enhance ${reEnhanceCount} Image${pluralReRun}`
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
                  sent={isSent}
                  nowMs={nowMs}
                  judgeResult={judgeByFile.get(f.id) ?? null}
                  judging={judgingFiles.has(f.id)}
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

      {/* ── Darkroom (Adjustments / Crop / Straighten) ──
          FILTERED to operator-picked winners (the `pickedWinners` memo
          above) — variants without a Choose click don't appear, and
          held files are excluded so Hold reads as a real opt-out from
          every batch operation. The live-preview grid inside
          ModifyPanel renders directly from `resizeAssets`, so it
          shrinks to winners-only too. Single-provider runs auto-pick
          on job completion (see handleJobComplete); multi-provider
          runs require explicit Choose clicks per card.

          Race defense: the `onModifyApplied` arrow and the
          `resizeAssets` array are both fresh on every render, but
          ModifyPanel's `handleApply` is recreated each render too and
          runs to completion on the at-click closure. That click-time
          closure pins (a) the `pairs[i].original.assetId` values it
          will send back, AND (b) THIS callback's `pickedWinners`
          snapshot — the two are guaranteed to be from the same
          render. So even if the operator re-picks a winner during the
          await, the assetIdToJobId lookup below succeeds against the
          original (pre-Apply) state and patches the right jobId.

          Winner changed AFTER Apply: the modified bytes are persisted
          under the OLD jobId in `completed`. The new winner is the
          original untouched variant. Acceptable; do not cascade.

          Embedded mode hides the TipBanner + standalone uploader. */}
      {pickedWinners.length > 0 && (
        <ModifyPanel
          embedded={true}
          sessionId={sessionId}
          resizeAssets={pickedWinners.map(({ item }) => ({
            assetId:      item.outputAssetId,
            filename:     item.filename,
            thumbnailUrl: item.outputUrl,
            outputUrl:    item.outputUrl,
            provider:     item.provider,
          }))}
          onModifyApplied={(pairs) => {
            // outputAssetId is structurally one-to-one with jobId (each
            // job mints its own asset), so this Map can't silently de-
            // duplicate keys.
            const assetIdToJobId = new Map(
              pickedWinners.map(({ jobId, item }) => [item.outputAssetId, jobId]),
            );
            if (pairs.length !== pickedWinners.length) {
              console.warn(
                "[darkroom] partial result: sent",
                pickedWinners.length,
                "got",
                pairs.length,
                "— some variants may not have been patched",
              );
            }
            // Patch `completed` so SourceCompareCard's variant thumb
            // re-renders with the Darkroom-rendered image immediately
            // (variantsByFile derives from `completed`).
            setCompleted((prev) => {
              const updated = new Map(prev);
              for (const { original, modified } of pairs) {
                const jobId = assetIdToJobId.get(original.assetId);
                if (!jobId) continue;
                const cur = updated.get(jobId);
                if (!cur) continue;
                updated.set(jobId, {
                  ...cur,
                  outputAssetId: modified.assetId,
                  // ModifyPanel guarantees outputUrl is set on the
                  // returned modified asset (see ModifyPanel.handleApply),
                  // so no defensive fallback is needed.
                  outputUrl:     modified.outputUrl!,
                });
              }
              return updated;
            });
            // Mirror outputAssetId into jobStateMap for symmetry with
            // the Erase / Tweak / Ideogram patches — some downstream
            // tool-open flows read it as a fallback identifier for the
            // current asset behind a job.
            setJobStateMap((prev) => {
              const updated = new Map(prev);
              for (const { original, modified } of pairs) {
                const jobId = assetIdToJobId.get(original.assetId);
                if (!jobId) continue;
                const cur = updated.get(jobId);
                if (!cur) continue;
                updated.set(jobId, { ...cur, outputAssetId: modified.assetId });
              }
              return updated;
            });
          }}
        />
      )}

      {/* ── Save & export ──
          Moved here from the removed Resize tab. Operates on the
          operator-picked winners — Save Project unlocks the PRO export,
          then download from right inside Enhance. */}
      {pickedWinners.length > 0 && (
        <ExportControls
          sessionId={sessionId}
          assets={pickedWinners.map(({ item }) => ({
            assetId:      item.outputAssetId,
            filename:     item.filename,
            thumbnailUrl: item.outputUrl,
            provider:     item.provider,
          }))}
          meta={meta}
          userEmail={userEmail}
        />
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
          onSendAll={handleSendAll}
        />
      )}
    </div>
  );
}
