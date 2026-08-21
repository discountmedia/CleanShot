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
  VISIBLE_TOGGLES,
  TOGGLE_DESCRIPTIONS,
  isEnhanceable,
  type EnhanceToggles,
  type ForkliftMeta,
  type JobRecord,
  type UploadFile,
} from "../../lib/types";
import {
  applyModifyBatch,
  enqueueEnhance,
  getAssetUrl,
  getSessionState,
  getSignedUploadUrl,
  judgeVariants,
  uploadToGcs,
  type JudgeResult,
} from "../../lib/api";
import {
  mapImportedAsset,
  reconcileImports,
  seedPlaceholders,
  selectImportableAssets,
  unlandedRows,
  type HandoffItem,
  type ServerAsset,
} from "../../lib/import-hydrate";
import { useHandoffPoller } from "../../lib/useHandoffPoller";
import {
  anyScanPending,
  readInlineScans,
  type InlineScanState,
} from "../../lib/inline-scan";
import {
  DEFAULT_FORK_VISIBILITY,
  buildRecommendedPrompt,
  isDefaultForkVisibility,
  matchesRecommendedPrompt,
  type ForkVisibility,
} from "../../lib/recommended-prompt";
import { useJobPoller } from "../../lib/polling";
import {
  ENHANCE_PROVIDERS,
  ENHANCE_PROVIDER_LABELS,
  type EnhanceProvider,
} from "../../lib/types-enhance";
import type { UserRestriction } from "../../lib/access-control";

import { MetaCard } from "./MetaCard";
import { ProviderRow } from "./ProviderRow";
import { SavedPromptsBar } from "./SavedPromptsBar";
import { ForkFramingControls } from "./ForkFramingControls";
import {
  NEUTRAL_ADJUSTMENT,
  SourceCompareCard,
  type VariantAdjustment,
  type SourceVariant,
} from "./SourceCompareCard";
import { EraseDialog, type EraseDialogResult } from "./EraseDialog";
import { TweakDialog, type TweakDialogResult } from "./TweakDialog";
import { TipBanner } from "../workspace/TipBanner";
import { AlertBanner } from "../workspace/AlertBanner";
// Modify-tab darkroom controls relocated to live INSIDE Enhance below the
// variants grid (2026-06-01) — the Modify tab itself is being deleted.
// Embedded mode hides the TipBanner + standalone uploader.
import { ExportControls } from "../export/ExportControls";

const MAX_UPLOADS = 150;

// ─── Pending-upload thumbnail (used in the drop-zone grid) ─────────────────

function ThumbnailCard({
  file,
  onPreviewExpired,
  forkVisibility,
  onForkVisibilityChange,
  showForkControls,
}: {
  file: UploadFile;
  /** Re-mints the signed GET URL for an imported asset whose preview 404'd. */
  onPreviewExpired: (file: UploadFile) => void;
  /** Per-image fork framing for THIS photo. */
  forkVisibility: ForkVisibility;
  onForkVisibilityChange: (next: ForkVisibility) => void;
  /** False for scissor lifts, which have a platform and no forks at all. */
  showForkControls: boolean;
}) {
  // Imported previews are signed GCS GET URLs with a 1-hour life
  // (_SIGNED_URL_EXPIRY_GET in services/gcs.py — a SHARED constant also used by
  // export download links, so it is deliberately not lengthened for our
  // convenience). When one expires the <img> errors, we re-mint ONCE, and then
  // give up and show a placeholder rather than looping the BFF.
  //
  // An expired preview is cosmetic ONLY. The asset stays fully enhanceable
  // because the enqueue path sends assetId — see isEnhanceable() in lib/types.
  const [previewDead, setPreviewDead] = useState(false);
  const retriedRef = useRef(false);

  const handleError = () => {
    if (file.origin !== "import" || retriedRef.current) {
      setPreviewDead(true);
      return;
    }
    retriedRef.current = true;
    onPreviewExpired(file);
  };

  return (
    <div className="rounded-lg overflow-hidden bg-panel border border-line">
    <div className="relative group">
      {previewDead ? (
        <div className="w-full aspect-square flex items-center justify-center bg-well px-2 text-center">
          <span className="text-[10px] font-mono text-ink-faint">
            preview unavailable
          </span>
        </div>
      ) : (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={file.previewUrl}
        alt={file.filename}
        onError={handleError}
        /* Explicit 1:1 dims belt-and-suspender the aspect-square
           Tailwind class — the CSS already enforces the square but
           the width/height attrs let the browser establish the aspect
           ratio before the blob image decodes, killing any micro-CLS
           on the upload grid (Real Experience Score fix 2026-05-27). */
        width={300}
        height={300}
        className="w-full aspect-square object-cover"
      />
      )}

      {file.status !== "done" && (
        <div className="absolute inset-0 bg-header-bg/60 flex flex-col items-center justify-center gap-2 p-2">
          {file.status === "compressing" && (
            <>
              <svg className="animate-spin w-6 h-6 text-accent" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              <span className="text-xs text-accent text-center">Compressing…</span>
            </>
          )}
          {file.status === "uploading" && (
            <>
              {/* Same fill==track bug as the Scan tab had. */}
              <div className="w-full bg-well rounded-full h-2.5 border border-line">
                <div
                  className="bg-accent h-2.5 rounded-full transition-all"
                  style={{ width: `${file.progress}%` }}
                />
              </div>
              <span className="text-xs font-bold text-accent">{file.progress}%</span>
            </>
          )}
          {file.status === "error" && (
            <span className="text-xs text-attn text-center">{file.error ?? "Upload failed"}</span>
          )}
          {file.status === "pending" && (
            <span className="text-xs text-ink-soft">Queued</span>
          )}
          {file.status === "importing" && (
            <>
              <svg className="animate-spin w-6 h-6 text-accent" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              <span className="text-xs text-accent text-center">Importing…</span>
            </>
          )}
        </div>
      )}

      {file.status === "done" && (
        <div className="absolute top-1.5 right-1.5 bg-accent rounded-full p-0.5">
          <svg className="w-3 h-3 text-header-bg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}

      {file.compressedSize !== undefined && (
        <div className="absolute bottom-1.5 left-1.5 bg-header-bg/70 rounded px-1.5 py-0.5 text-[10px] text-accent">
          {formatBytes(file.compressedSize)}
        </div>
      )}

      {/* Provenance for imported assets — the source unit's stock number.
          Display only; nothing is built on this beyond showing it. */}
      {file.origin === "import" && file.sourceRef && (
        <div className="absolute top-1.5 left-1.5 bg-header-bg/70 rounded px-1.5 py-0.5 text-[10px] font-mono text-ink-soft">
          {file.sourceRef}
        </div>
      )}

      <div className="absolute bottom-0 inset-x-0 bg-linear-to-t from-black/80 to-transparent px-2 py-1.5 translate-y-full group-hover:translate-y-0 transition-transform">
        <p className="text-xs text-white truncate">{file.filename}</p>
      </div>
    </div>

    {/* Fork framing, set BEFORE the first run. Under the image rather than
        over it — the operator is judging this photo to decide, so covering
        it would be self-defeating. */}
    {showForkControls && (
      <div className="border-t border-line px-2 py-1.5 bg-well">
        <ForkFramingControls
          value={forkVisibility}
          onChange={onForkVisibilityChange}
          promptIsCustom={false}
          compact
        />
      </div>
    )}
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
          ? "bg-panel-hi border-accent text-ink"
          : "bg-panel border-line text-ink-soft hover:border-ink-faint"}
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
        {/* Track: lime when ON ("good"/active), neutral raised when OFF.
            Knob flips to the dark plate colour on the lime track — a white
            knob on #95EA00 is ~1.5:1 and effectively disappears. */}
        <div
          className={`w-10 h-6 rounded-full transition-colors ${
            checked ? "bg-accent" : "bg-panel-hi"
          }`}
        />
        <div
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full shadow transition-transform ${
            checked ? "translate-x-4 bg-header-bg" : "translate-x-0 bg-ink"
          }`}
        />
      </div>
      <div className="min-w-0">
        <span className="block text-base font-semibold">{label}</span>
        <span className={`block text-sm mt-1 leading-snug ${checked ? "text-ink" : "text-ink-soft"}`}>
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
  /**
   * Import assets already known when the session became ready.
   *
   *   null — no import in play; skip hydration entirely (freshly-minted session)
   *   []   — an import exists but nothing has landed yet (just-exchanged token)
   *   [..] — assets from the resume path's validating read
   *
   * Passing them down is what removed the duplicate session read: the resume
   * path had to read the session to validate the stored id, and this panel used
   * to read the same session again to hydrate.
   */
  initialImportAssets?: ServerAsset[] | null;
  /** Present when there's an import to watch. Drives the progress poller. */
  handoffId?: string | null;
  /**
   * Seeds placeholder tiles for the first paint so the grid doesn't grow from
   * empty. A SEED ONLY — the server is authoritative for what actually exists,
   * and a shortfall (crop produced fewer photos than expected) is reconciled
   * away rather than left as a stuck tile.
   */
  expectedImportCount?: number;
  meta: Partial<ForkliftMeta>;
  onMetaChange: (meta: Partial<ForkliftMeta>) => void;
  onClearPipeline: () => void;
  /**
   * Explicit "Clear all" only. Tells Workspace to forget the session handle so
   * a reload doesn't resurrect the imports the operator just cleared. NOT
   * called by the automatic post-batch reset, which keeps imports on purpose.
   */
  onDiscardSession?: () => void;
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
  initialImportAssets = null,
  handoffId = null,
  expectedImportCount = 0,
  meta,
  onMetaChange,
  onClearPipeline,
  onDiscardSession,
  onFileCountChange,
  userEmail,
  restriction = null,
}: EnhancePanelProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jobsSectionRef = useRef<HTMLDivElement>(null);

  // ─── Core state ─────────────────────────────────────────────────────────

  /**
   * Placeholder tiles for an inbound import are seeded in the INITIALIZER, not
   * an effect: the point is that the grid paints the right number of tiles on
   * the first frame rather than growing from empty as photos land. Doing it in
   * an effect would be one commit late and a setState-inside-an-effect.
   *
   * This panel only mounts once the session is ready, so `expectedImportCount`
   * is already known on the first render and never changes afterwards.
   *
   * Seeded tiles are a SEED, not truth — every one is reconciled against the
   * server (see reconcileImports), so a shortfall disappears rather than
   * spinning.
   */
  const [files, setFiles] = useState<UploadFile[]>(() =>
    expectedImportCount > 0
      ? seedPlaceholders(expectedImportCount, uuidv4)
      : [],
  );
  const [toggles, setToggles] = useState<EnhanceToggles>(DEFAULT_TOGGLES);
  const setMeta = onMetaChange;

  /**
   * Turn a set of server assets (+ the poller's not-yet-landed items) into grid
   * rows and reconcile them in.
   *
   * The SESSION READ is the source of truth for what exists; the poller only
   * contributes the two states a read cannot express (still copying, failed).
   * That split is why hydration works identically for someone who just arrived
   * from media-auditor and someone who reloaded an hour later with no handoff at
   * all — the handoff record is TTL'd, the assets are permanent.
   */
  const applyImportState = useCallback(
    async (
      assets: ServerAsset[],
      unlandedItems: HandoffItem[],
      isCancelled: () => boolean,
    ) => {
      // One signed GET URL per asset: the session read returns gs:// URIs, not
      // fetchable URLs. Settled (not all-or-nothing) so one bad mint doesn't
      // cost the operator the whole import — a row with no preview still
      // enhances, per the isEnhanceable() invariant.
      const minted = await Promise.allSettled(assets.map((a) => getAssetUrl(a.id)));
      if (isCancelled()) return;

      const hydrated = assets.map((a, i) => {
        const m = minted[i];
        return mapImportedAsset(
          a,
          m.status === "fulfilled" ? m.value.url : "",
          uuidv4(),
        );
      });
      setFiles((prev) =>
        reconcileImports(prev, hydrated, unlandedRows(unlandedItems, uuidv4)),
      );
    },
    [],
  );

  /**
   * First paint. Seeds placeholders from expectedCount and maps whatever the
   * session already had, without a read of its own — Workspace handed both down.
   */
  useEffect(() => {
    if (initialImportAssets === null) return;
    let cancelled = false;
    const isCancelled = () => cancelled;

    // NOTE: placeholders are NOT seeded here. They're seeded in the `files`
    // state initializer, which puts them on the very first frame (the actual
    // goal) instead of one commit later, and avoids a setState-in-an-effect.
    if (initialImportAssets.length > 0) {
      const assets = initialImportAssets;
      void (async () => {
        await applyImportState(assets, [], isCancelled);
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [initialImportAssets, applyImportState]);

  /**
   * Progress poller. Its ONLY jobs are to say "re-read now" as photos land and
   * to go terminal — it is never a source of asset data.
   */
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const handoffProgress = useHandoffPoller(
    handoffId,
    (status) => {
      if (!sessionId) return;
      void (async () => {
        let assets: ServerAsset[] = [];
        try {
          assets = selectImportableAssets(await getSessionState(sessionId));
        } catch {
          // Keep whatever is already on screen. The poller will tick again, and
          // if the reads keep failing it surfaces "unavailable" on its own.
          return;
        }
        await applyImportState(
          assets,
          status.items.filter((it) => it.status !== "landed"),
          () => cancelledRef.current,
        );
      })();
    },
  );

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
      // The auto-reset IS the side-effect here; the one-shot ref gates it so
      // there's no loop.
      setToggles(DEFAULT_TOGGLES);
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
              filename:      file.uploadedFilename ?? file.filename,
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

  // ─── Inline scan (Enhance tab) ─────────────────────────────────────────
  //
  // Every enhance output is scanned automatically by the backend already —
  // `_run_enhance` enqueues a differential scan job against the original the
  // moment a variant lands. So this does NOT start scans; it reads the ones
  // that exist and shows each verdict beside the image it belongs to.
  //
  // One session read resolves the whole batch, and each variant's card renders
  // as soon as ITS OWN row appears — no waiting on the slowest scan, and a job
  // that fails marks only its own variant.
  const [scansByAsset, setScansByAsset] = useState<Map<string, InlineScanState>>(
    () => new Map(),
  );

  // ─── Per-image fork framing ────────────────────────────────────────────
  //
  // Which parts of the fork are in frame, PER SOURCE PHOTO. Per-image is the
  // only shape that makes sense: whether the tips got cropped is a property of
  // one camera angle, not of the batch. The wire format already supported this
  // — every queued image gets its own EnhanceTaskPayload — so this needed a
  // new field, not new plumbing.
  //
  // A file missing from this map is fully-visible, which is the common case
  // and reproduces the pre-existing prompt exactly.
  const [forkVisByFile, setForkVisByFile] = useState<Map<string, ForkVisibility>>(
    () => new Map(),
  );

  /**
   * Master switch for the whole fork-conditionals feature. EXPERIMENTAL, so it
   * is OFF by default and only an explicit click turns it on.
   *
   * Deliberately plain `useState` with no persistence: not localStorage, not
   * the session, not derived from any other setting. It resets to off on every
   * page load, and nothing else in this component can turn it on as a side
   * effect. If the feature produces strange output, one click gets the
   * operator back to the prompt the app built before it existed.
   */
  const [forkConditionalsOn, setForkConditionalsOn] = useState(false);

  /**
   * THE gate. Every read of fork visibility goes through here, so switching
   * the feature off leaves no residual effect on the assembled prompt: the
   * per-file selections stay in `forkVisByFile` (so they come back if the
   * operator re-enables it) but are never consulted, and every caller sees
   * fully-visible — byte-identical to the pre-feature behaviour.
   *
   * Turning it off mid-batch therefore affects only the NEXT run. Images
   * already generated are untouched; nothing re-enqueues on this flag.
   */
  const forkVisFor = useCallback(
    (fileId: string): ForkVisibility =>
      forkConditionalsOn
        ? (forkVisByFile.get(fileId) ?? DEFAULT_FORK_VISIBILITY)
        : DEFAULT_FORK_VISIBILITY,
    [forkConditionalsOn, forkVisByFile],
  );

  const setForkVis = useCallback((fileId: string, next: ForkVisibility) => {
    setForkVisByFile((prev) => {
      const map = new Map(prev);
      map.set(fileId, next);
      return map;
    });
  }, []);

  // Is the box still holding the recommended text (in any fork-visibility
  // combination), or has the operator written their own?
  const promptIsCustom = useMemo(
    () =>
      customPromptActive &&
      !matchesRecommendedPrompt(customPrompt, meta.equipmentType ?? "forklift", {
        make:  meta.make,
        model: meta.model,
        year:  meta.year,
      }),
    [customPromptActive, customPrompt, meta.equipmentType, meta.make, meta.model, meta.year],
  );

  /**
   * The prompt to enqueue for ONE image, and whether the fork framing is
   * already baked into it.
   *
   * Two paths, and which one runs is the whole design:
   *
   *  • Recommended text untouched → rebuild it from fragments using THIS
   *    image's fork visibility. The offending clause is simply absent. This is
   *    the reliable path, because the model is never asked for the thing it
   *    would otherwise invent.
   *
   *  • Operator wrote their own → leave their words exactly as typed. There is
   *    no fragment of ours to remove, and rewriting their prompt would throw
   *    their edits away. The backend appends an explicit FORK FRAMING note
   *    instead; the UI says so next to the controls rather than letting the
   *    control appear to do nothing.
   *
   * The prompt BOX still shows one shared prompt — per-image variation happens
   * here at enqueue time, because fork framing is a property of the photo and
   * the box is not per photo.
   */
  const promptForFile = useCallback(
    (fileId: string): { prompt: string | undefined; framingInPrompt: boolean } => {
      if (!customPromptActive) return { prompt: undefined, framingInPrompt: false };
      // Feature off → the operator's text goes out VERBATIM, with no rebuild
      // at all. Rebuilding it even from default fragments would round-trip
      // their prompt through our assembler, and any wording drift there would
      // be a residual effect of a feature that is supposed to be inert.
      if (!forkConditionalsOn) return { prompt: customPrompt, framingInPrompt: false };
      if (promptIsCustom) return { prompt: customPrompt, framingInPrompt: false };
      const fork = forkVisFor(fileId);
      return {
        prompt: buildRecommendedPrompt(
          meta.equipmentType ?? "forklift",
          { make: meta.make, model: meta.model, year: meta.year },
          fork,
        ),
        // Rebuilt from fragments, so the framing IS the prompt — tell the
        // worker not to append its own note on top.
        framingInPrompt: !isDefaultForkVisibility(fork),
      };
    },
    [
      customPromptActive, customPrompt, promptIsCustom, forkVisFor,
      forkConditionalsOn,
      meta.equipmentType, meta.make, meta.model, meta.year,
    ],
  );

  // Per-image adjustment state. Declared up here with the rest of the batch
  // state because the batch-wipe handlers below reset it alongside
  // `completed` / `jobStateMap`; the handlers that drive it live further down
  // next to the other per-variant actions.
  const [adjByFile, setAdjByFile] = useState<
    Map<string, Partial<Record<EnhanceProvider, VariantAdjustment>>>
  >(() => new Map());
  const [adjustingJobs, setAdjustingJobs] = useState<Set<string>>(() => new Set());

  // Asset ids of every completed variant currently on screen. This is the
  // lookup key on both sides: the scan job's input_asset_id and the
  // scan_results row's asset_id are both the enhance OUTPUT asset.
  const completedAssetIds = useMemo(() => {
    const out: string[] = [];
    for (const item of completed.values()) out.push(item.outputAssetId);
    return out;
  }, [completed]);

  // Poll while anything is unresolved, then stop. `deadline` keeps a variant
  // whose scan job never materialises (older asset, worker drop) from polling
  // the session read forever.
  const scanDeadlineRef = useRef(0);
  useEffect(() => {
    if (completedAssetIds.length > 0) {
      scanDeadlineRef.current = Date.now() + 4 * 60 * 1000;
    }
  }, [completedAssetIds]);

  useEffect(() => {
    if (!sessionId || completedAssetIds.length === 0) return;

    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const state = await getSessionState(sessionId);
        if (cancelled) return;
        const next = readInlineScans(state, completedAssetIds);
        setScansByAsset(next);
        const everyoneReported = completedAssetIds.every((id) => {
          const s = next.get(id);
          return s !== undefined && s.status !== "waiting";
        });
        if (everyoneReported || Date.now() > scanDeadlineRef.current) return;
      } catch {
        // A failed read is not a failed scan — keep the prior state and try
        // again on the next tick until the deadline.
        if (cancelled) return;
        if (Date.now() > scanDeadlineRef.current) return;
      }
      timer = window.setTimeout(tick, 5000);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sessionId, completedAssetIds]);

  const scansPending = useMemo(() => anyScanPending(scansByAsset), [scansByAsset]);

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
      origin: "upload",
      file: f,
      filename: f.name,
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

  /**
   * Release a grid item's object URL. Only "upload" items HAVE one — an
   * import's previewUrl is a signed https:// GCS URL, and calling
   * revokeObjectURL on it is a silent no-op today but a lie about what the
   * value is. Keyed on origin so the intent is greppable.
   */
  const releasePreview = (f: UploadFile) => {
    if (f.origin === "upload") URL.revokeObjectURL(f.previewUrl);
  };

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const f = prev.find((x) => x.id === id);
      if (f) releasePreview(f);
      return prev.filter((x) => x.id !== id);
    });
  };

  /**
   * Re-mint an imported asset's signed preview URL after the <img> errored.
   * ThumbnailCard caps this at one attempt per item, so this cannot loop.
   *
   * Takes the whole file rather than an id so the fetch stays OUT of a
   * setFiles updater — updaters must be pure (React may invoke them twice, and
   * React Compiler's purity rule flags impure component-scoped callbacks; see
   * hard-won lesson #9).
   */
  const refreshImportPreview = useCallback((f: UploadFile) => {
    if (f.origin !== "import" || !f.assetId) return;
    void getAssetUrl(f.assetId)
      .then(({ url }) => {
        setFiles((cur) =>
          cur.map((x) => (x.id === f.id ? { ...x, previewUrl: url } : x)),
        );
      })
      .catch(() => {
        /* Swallowed: ThumbnailCard already fell back to the placeholder, and
           the asset stays enhanceable regardless — see isEnhanceable(). */
      });
  }, []);

  const updateFile = useCallback((id: string, patch: Partial<UploadFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  // ─── Upload + Enhance pipeline ─────────────────────────────────────────

  const runUploadAndEnhance = async (
    uploadFile: UploadFile,
    index: number,
    total: number,
  ) => {
    const { id, file, origin } = uploadFile;

    // HARD GUARD. Imported assets are already in GCS and have no local `File`;
    // sending one down this path would hand `convertToJpeg` an undefined and
    // re-upload bytes that are already there. handleEnhanceAll only selects
    // "pending" items and imports are "done", so this is unreachable today —
    // which is exactly why it is asserted rather than assumed. A future edit to
    // the Enhance button must fail loudly here, not silently corrupt a batch.
    // Imports reach the queue through the assetId path instead (handleReEnhance).
    if (origin === "import" || !file) {
      console.error(
        "[enhance] refusing to run the upload pipeline on an imported asset",
        { id, origin },
      );
      return;
    }

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
          customPrompt: promptForFile(id).prompt,
          forkVisibility: forkVisFor(id),
          forkFramingInPrompt: promptForFile(id).framingInPrompt,
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
   * spinner. Powers both the per-variant Retry button on the thumb and the
   * failed-variant retry strip, so a retry always re-runs with the CURRENT
   * prompt and toggle state.
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
          customPrompt:   promptForFile(file.id).prompt,
          forkVisibility: forkVisFor(file.id),
          forkFramingInPrompt: promptForFile(file.id).framingInPrompt,
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
    // forkVisFor + promptForFile MUST be here: without them this closure keeps
    // the fork state from the render it was created in, so a Retry fired after
    // ticking "tips not visible" would re-run with the OLD framing — the exact
    // case the button exists for.
    // The prompt no longer appears directly — promptForFile resolves it, and
    // carries customPrompt / customPromptActive in its own deps.
    [sessionId, toggles, meta, forkVisFor, promptForFile],
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
        //
        // CARVE-OUT: imported assets SURVIVE this wipe. They land as "done"
        // (already in GCS), so the status test alone would silently delete the
        // operator's whole media-auditor import the first time they ran a
        // second enhance batch. The exception is keyed on `origin` rather than
        // on status precisely so it reads as intentional and doesn't get
        // "simplified" away by someone who doesn't know why it's here.
        const survives = (f: UploadFile) =>
          f.status === "pending" || f.origin === "import";
        files.filter((f) => !survives(f)).forEach(releasePreview);
        setFiles((prev) => prev.filter(survives));
        setEnhanceJobs(new Map());
        setCompleted(new Map());
        setScansByAsset(new Map());
        setAdjByFile(new Map());
        setAdjustingJobs(new Set());
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
    // isEnhanceable() rather than an inline test: it carries the invariant that
    // previewUrl is NOT part of eligibility, so an imported asset with an
    // expired thumbnail still enhances. This is also the path imported assets
    // take into the queue — they arrive already "done" with an assetId, so
    // they need no upload.
    const eligible = files.filter(isEnhanceable);
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
    setScansByAsset(new Map());
    setAdjByFile(new Map());
    setAdjustingJobs(new Set());
    setJobStateMap(new Map());
    setChosenByFile(new Map());
    setHeldFiles(new Set());
    setJudgeByFile(new Map());
    setJudgingFiles(new Set());
    judgeStartedRef.current = new Set();
    judgeEpochRef.current += 1;   // invalidate any in-flight judge from the prior batch
    onClearPipeline();
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
              customPrompt:   promptForFile(file.id).prompt,
              forkVisibility: forkVisFor(file.id),
              forkFramingInPrompt: promptForFile(file.id).framingInPrompt,
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
    forkVisFor,
    promptForFile,
    metaGate,
    restriction,
    selectedProviders,
    sessionId,
    toggles,
    meta,
    // customPrompt / customPromptActive are not listed: the prompt is resolved
    // through promptForFile, which carries them in its own deps.
    onClearPipeline,
  ]);


  // ─── Per-image adjustments ─────────────────────────────────────────────
  //
  // Replaces the bulk darkroom (ModifyPanel) that used to sit at the bottom of
  // this page and applied one contrast/saturation setting to every picked
  // winner at once. Each variant now carries its own two sliders.
  //
  // Uncommitted values live here and drive a CSS-filter preview on the thumb.
  // Apply renders the real bytes through the SAME backend path the darkroom
  // used (`applyModifyBatch`, one asset at a time via its `perAsset` contract)
  // and swaps the result into `completed` — which is what `pickedWinners` and
  // therefore ExportControls read, so an applied adjustment persists through
  // export with no extra plumbing.

  const handleAdjustChange = useCallback(
    (fileId: string, provider: EnhanceProvider, adj: VariantAdjustment) => {
      setAdjByFile((prev) => {
        const next = new Map(prev);
        next.set(fileId, { ...(next.get(fileId) ?? {}), [provider]: adj });
        return next;
      });
    },
    [setAdjByFile],
  );

  const handleAdjustApply = useCallback(
    async (fileId: string, provider: EnhanceProvider) => {
      const jobId = enhanceJobs.get(fileId)?.get(provider);
      if (!jobId) return;
      const item = completed.get(jobId);
      if (!item) return;
      const adj = adjByFile.get(fileId)?.[provider];
      if (!adj) return;
      if (adjustingJobs.has(jobId)) return;

      setAdjustingJobs((prev) => new Set(prev).add(jobId));
      try {
        const { items } = await applyModifyBatch({
          sessionId,
          assetIds: [item.outputAssetId],
          // Contrast + saturation only. brightness / rotation / crop stay
          // neutral — those controls came off with the bulk panel and the
          // backend treats 1.0 / 0 / "free" / 1.0 as no-ops.
          adjustments: {
            brightness:  1.0,
            contrast:    adj.contrast,
            saturation:  adj.saturation,
            rotationDeg: 0,
            cropAspect:  "free",
            cropZoom:    1.0,
          },
        });
        const rendered = items[0];
        if (!rendered) return;

        // Replace the variant in place so the thumb, the winner pick, and the
        // export set all move to the adjusted asset together.
        setCompleted((prev) => {
          const cur = prev.get(jobId);
          if (!cur) return prev;
          const next = new Map(prev);
          next.set(jobId, {
            ...cur,
            outputAssetId: rendered.assetId,
            outputUrl:     rendered.url,
          });
          return next;
        });
        // Mirror into jobStateMap for symmetry with the Erase / Tweak patches —
        // the tool-open flows read outputAssetId from there as a fallback.
        setJobStateMap((prev) => {
          const cur = prev.get(jobId);
          if (!cur) return prev;
          const next = new Map(prev);
          next.set(jobId, { ...cur, outputAssetId: rendered.assetId });
          return next;
        });
        // The adjustment is now baked into the bytes, so the sliders return to
        // neutral — leaving them where they were would double-apply on the
        // CSS preview and on any second Apply.
        setAdjByFile((prev) => {
          const forFile = prev.get(fileId);
          if (!forFile) return prev;
          const next = new Map(prev);
          next.set(fileId, { ...forFile, [provider]: NEUTRAL_ADJUSTMENT });
          return next;
        });
      } catch (err: unknown) {
        setGlobalError(err instanceof Error ? err.message : "Adjustment failed");
      } finally {
        setAdjustingJobs((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [
      sessionId, enhanceJobs, completed, adjByFile, adjustingJobs,
      setAdjustingJobs, setCompleted, setJobStateMap, setAdjByFile, setGlobalError,
    ],
  );

  // Providers whose Apply is in flight, shaped per-file for the compare card.
  const adjustingByFile = useMemo(() => {
    const out = new Map<string, Partial<Record<EnhanceProvider, boolean>>>();
    for (const f of files) {
      const fileJobs = enhanceJobs.get(f.id);
      if (!fileJobs) continue;
      const perProvider: Partial<Record<EnhanceProvider, boolean>> = {};
      for (const [provider, jobId] of fileJobs.entries()) {
        if (adjustingJobs.has(jobId)) perProvider[provider] = true;
      }
      if (Object.keys(perProvider).length > 0) out.set(f.id, perProvider);
    }
    return out;
  }, [files, enhanceJobs, adjustingJobs]);

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
  // Per-file, per-provider scan lookup for the compare cards. Keyed the same
  // way `variantsByFile` is so the card can render a verdict directly beneath
  // the variant it describes.
  const scansByFile = useMemo(() => {
    const out = new Map<string, Partial<Record<EnhanceProvider, InlineScanState>>>();
    for (const f of files) {
      const fileJobs = enhanceJobs.get(f.id);
      if (!fileJobs) continue;
      const perProvider: Partial<Record<EnhanceProvider, InlineScanState>> = {};
      for (const [provider, jobId] of fileJobs.entries()) {
        const item = completed.get(jobId);
        if (!item) continue;
        const scan = scansByAsset.get(item.outputAssetId);
        if (scan) perProvider[provider] = scan;
      }
      if (Object.keys(perProvider).length > 0) out.set(f.id, perProvider);
    }
    return out;
  }, [files, enhanceJobs, completed, scansByAsset]);

  // The operator-picked winners — the set that gets exported (and, as of
  // 2026-08-21, saved to the project by that same export click).
  //
  // Winner-resolution chain: file → chosenByFile → enhanceJobs[file][chosen]
  // → completed[jobId]. Held files are filtered out so "Hold" reads
  // consistently as "exclude from every batch operation".
  //
  // Returns the jobId alongside each item so per-image adjustments can patch
  // results back keyed by assetId → jobId. assetId is guaranteed one-to-one
  // with jobId (each job owns its own outputAssetId, and every job ID is
  // unique per batch), so building a Map<assetId, jobId> never silently
  // de-dupes.
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
    // Explicit operator action, so imports go too — unlike the automatic
    // batch wipe above, which carves them out.
    files.forEach(releasePreview);
    setFiles([]);
    setEnhanceJobs(new Map());
    setCompleted(new Map());
    setScansByAsset(new Map());
    setAdjByFile(new Map());
    setAdjustingJobs(new Set());
    setJobStateMap(new Map());
    setChosenByFile(new Map());
    setHeldFiles(new Set());
    setJudgeByFile(new Map());
    setJudgingFiles(new Set());
    judgeStartedRef.current = new Set();
    judgeEpochRef.current += 1;   // invalidate any in-flight judge from the prior batch
    onClearPipeline();
    // Explicit clear: stop remembering the session so a reload doesn't bring
    // the imports back. The automatic post-batch reset does NOT do this.
    onDiscardSession?.();
    setGlobalError(null);
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
          <>Click <span className="font-semibold text-ink">Enhance</span> and wait for the variants to come back.</>,
          <>For each photo, pick the winner variant. Use ↻ to retry, ✎ to tweak with words, or ⌫ to erase part of an image.</>,
          <>When you&apos;re happy with every photo, click <span className="font-semibold text-ink">Send to Scan →</span> to move them forward.</>,
        ]}
      >
        <p>
          This is where raw used-forklift photos become clean,
          listing-ready images. Each AI model does its own version of
          your photos so you can pick the best one.
        </p>
      </TipBanner>

      {/* ── Import progress / outcome ──
          The poller stops on a terminal state, and a stalled or unreachable
          import must SAY so rather than leaving tiles spinning. Whatever landed
          is already usable underneath this. */}
      {handoffId && handoffProgress.status && !handoffProgress.outcome && (
        <p className="text-sm font-mono text-ink-soft">
          Bringing in your photos…{" "}
          {handoffProgress.status.statusCounts.landed ?? 0} of{" "}
          {handoffProgress.status.total} ready
        </p>
      )}
      {handoffProgress.outcome === "timeout" && (
        <AlertBanner
          severity="warn"
          title="Some photos are still on their way"
          body="We stopped waiting after five minutes. What arrived is ready to enhance — reload to check for the rest, or send them over again from the unit page."
        />
      )}
      {handoffProgress.outcome === "unavailable" && (
        <AlertBanner
          severity="warn"
          title="Lost track of the import"
          body="We can't reach the import status right now. Anything that already arrived is ready to enhance; reload to pick the rest up."
        />
      )}
      {handoffProgress.outcome === "complete" &&
        (handoffProgress.status?.statusCounts.failed ?? 0) > 0 && (
          <AlertBanner
            severity="warn"
            title={`${handoffProgress.status?.statusCounts.failed} photo(s) didn't come through`}
            body="The tiles marked in the grid show why. Everything else imported fine and is ready to enhance."
          />
        )}

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
            ? "border-line opacity-50 cursor-not-allowed"
            : "border-line hover:border-line hover:bg-panel"}
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
          <svg className="w-10 h-10 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          <p className="text-lg font-semibold text-ink">
            {files.length >= MAX_UPLOADS
              ? `Maximum ${MAX_UPLOADS} images reached`
              : `Drop images here or click to browse`}
          </p>
          <p className="text-sm text-ink-soft mt-1">
            Up to {MAX_UPLOADS} images · Files over 4.5 MB auto-compressed
            · {files.length}/{MAX_UPLOADS} loaded
          </p>
        </div>
      </div>

      {/* ── Pending-thumbnail grid ── */}
      {files.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-bold text-ink">
              {files.length} image{files.length !== 1 ? "s" : ""} loaded
              {doneCount > 0 && (
                <span className="ml-2 text-accent">· {doneCount} uploaded</span>
              )}
            </h3>
            <button
              onClick={handleClearAll}
              className="text-sm font-bold text-ink hover:text-attn transition-colors border border-line hover:border-attn rounded px-3 py-1.5"
            >
              Clear all
            </button>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-11 gap-2">
            {files.map((f) => (
              <div key={f.id} className="relative group">
                <ThumbnailCard
                  file={f}
                  onPreviewExpired={refreshImportPreview}
                  forkVisibility={forkVisFor(f.id)}
                  onForkVisibilityChange={(next) => setForkVis(f.id, next)}
                  showForkControls={
                    forkConditionalsOn &&
                    (meta.equipmentType ?? "forklift") !== "scissor_lift"
                  }
                />
                <button
                  onClick={() => removeFile(f.id)}
                  className="absolute -top-1.5 -right-1.5 bg-danger rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                  aria-label={`Remove ${f.filename}`}
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
        <p className="-mt-2 text-[11px] text-ink-faint font-mono px-1">
          Files will be uploaded as{" "}
          <span className="text-ink-soft">
            {buildEnhanceFilename(meta, 0, Math.max(files.length, 1))}
          </span>
          {files.length > 1 && (
            <>
              {" "}through{" "}
              <span className="text-ink-soft">
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
      <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="w-full flex items-center justify-between px-5 py-4 bg-panel/30 hover:bg-panel/50 transition-colors text-left"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-base font-semibold uppercase tracking-[0.14em] text-ink">
              Prompt
            </span>
            <span className="text-sm uppercase tracking-[0.16em] text-ink-soft">
              Write your own — toggles fine-tune it
            </span>
            {customPromptActive ? (
              <span className="text-xs uppercase tracking-[0.18em] font-bold text-header-bg bg-accent border border-accent rounded px-2 py-0.5">
                ✓ Prompt set
              </span>
            ) : (
              <span className="text-xs uppercase tracking-[0.18em] font-bold text-attn bg-panel border border-attn rounded px-2 py-0.5">
                Required
              </span>
            )}
          </div>
          <svg
            className={`w-5 h-5 text-ink transition-transform ${advancedOpen ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {advancedOpen && (
          <div className="border-t border-line p-5 space-y-5">
            {/* ── Your prompt — PRIMARY + required (prompt-first redesign,
                2026-07-21). The operator's own words drive the result;
                "Insert recommended prompt" gives unfamiliar users an
                equipment-aware starting point they then edit. The toggles
                below append to whatever ends up here, and the backend always
                adds the safety guardrails on top (custom_prompt is now the
                spine_override, not a verbatim override). */}
            <div className="space-y-3">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h3 className="text-lg font-semibold text-ink">
                  Your prompt <span className="text-attn">*</span>
                </h3>
                <div className="flex items-center gap-4">
                  {/* Primary action. Behaviour is unchanged — only the weight:
                      filled lime, larger type, real padding, an icon. It was a
                      plain text link sitting at the same weight as the "Clear"
                      link next to it, which read as secondary for what is the
                      main way an unfamiliar operator gets a usable prompt.
                      text-header-bg is mandatory on a lime fill (white is
                      ~1.5:1). */}
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
                    }}
                    className="inline-flex items-center gap-2 text-base font-bold uppercase tracking-[0.1em] px-5 py-3 rounded-lg bg-accent hover:bg-accent/85 text-header-bg shadow-lg transition-colors"
                  >
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
                      />
                    </svg>
                    {customPromptActive ? "Reset to recommended" : "Insert recommended prompt"}
                  </button>
                  {customPromptActive && (
                    <button
                      type="button"
                      onClick={() => {
                        setCustomPrompt("");
                      }}
                      className="text-sm text-ink-soft hover:text-ink transition-colors font-semibold"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <p className="text-base text-ink leading-relaxed">
                Describe how you want this machine to look, in your own words —{" "}
                <span className="font-semibold text-accent">your prompt drives the result</span>.
                New to this? Click{" "}
                <span className="font-semibold">Insert recommended prompt</span>{" "}
                for a solid starting point and edit it to taste.
              </p>
              <textarea
                value={customPrompt}
                onChange={(e) => {
                  setCustomPrompt(e.target.value);
                }}
                placeholder="Example: Give this forklift a clean respray in its original orange, keep every decal, paint the forks red with yellow tips, glossy tire sidewalls, brighten the lighting, tidy the background."
                rows={6}
                className="w-full bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink placeholder:text-ink-soft focus:outline-none focus:ring-2 focus:ring-cta focus:border-transparent transition leading-relaxed"
              />

              {/* Save the current prompt to the operator's profile, or drop a
                  previously saved one back into the box. Inserted text is a
                  COPY — editing it here never writes back to the saved row. */}
              <SavedPromptsBar
                currentPrompt={customPrompt}
                onInsert={(body) => setCustomPrompt(body)}
              />
              <p className="text-sm text-ink-soft leading-relaxed">
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
            <div className="border-t border-line pt-5">
              <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
                <h3 className="text-lg font-semibold text-ink">
                  Optional add-ons
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setToggles(DEFAULT_TOGGLES);
                  }}
                  className="text-sm text-ink-soft hover:text-ink transition-colors font-semibold"
                >
                  Reset
                </button>
              </div>
              <p className="text-base text-ink mb-1.5 leading-relaxed">
                These{" "}
                <span className="font-semibold text-accent">append to your prompt</span>{" "}
                above — extra emphasis (paint, rust, tire shine) or a specific
                action (paint forks red, remove rental decals).
              </p>
              <p className="text-base text-accent italic mb-4 leading-relaxed">
                (Optional — leave them all off to let your prompt stand on its own.)
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {VISIBLE_TOGGLES
                  // VISIBLE_TOGGLES (lib/types.ts) is the single list that
                  // decides what renders — the other keys stay in state at
                  // their DEFAULT_TOGGLES value and still reach the backend
                  // prompt builder. Restoring one is a one-line edit there.
                  //
                  // The equipment-conditional gates below stay in lock-step
                  // with the backend paint_forks_on / three_wheel gates, so
                  // they keep working if either key is made visible again:
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
        <p className="text-sm text-attn bg-panel border border-attn rounded-lg px-4 py-3" role="alert">
          {globalError}
        </p>
      )}

      {/* ── Fork conditionals: master switch ──
          Sits immediately above the Enhance button, OUTSIDE the collapsible
          settings section, and is visible whenever this tab is. That placement
          is the point: the feature is experimental, so the way back to
          known-good output has to be one click from where the operator is
          standing when they notice the output is wrong — not a setting they
          have to go hunting for.

          Hidden entirely for scissor lifts, which have a platform and no
          forks, so the control would do nothing there. */}
      {(meta.equipmentType ?? "forklift") !== "scissor_lift" && (
        <div
          className={`rounded-xl border-2 px-4 py-3 transition-colors ${
            forkConditionalsOn ? "border-attn bg-panel" : "border-line bg-well/40"
          }`}
        >
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={forkConditionalsOn}
              onChange={(e) => setForkConditionalsOn(e.target.checked)}
              className="mt-1 w-5 h-5 accent-accent shrink-0"
            />
            <div className="min-w-0">
              <p className="text-base font-bold text-ink leading-snug">
                Fork conditionals{" "}
                <span className="text-sm uppercase tracking-[0.16em] font-bold text-attn border border-attn rounded px-2 py-0.5 ml-1">
                  Experimental
                </span>
              </p>
              <p className="text-sm text-attn mt-1.5 leading-relaxed">
                This feature is experimental and may produce unexpected results.
              </p>
              <p className="text-sm text-ink-soft mt-1.5 leading-relaxed">
                Turns on per-image controls for photos where the fork isn&apos;t
                fully in frame, letting you drop the fork instructions the model
                can&apos;t satisfy. While this is off, prompts are built exactly
                as they were before the feature existed. Switching it off takes
                effect on the next run and never changes images you&apos;ve
                already generated.
              </p>
            </div>
          </label>
        </div>
      )}

      {/* ── Enhance button ── */}
      {(() => {
        const reEnhanceCount = files.filter(isEnhanceable).length;
        // No dirty-input guard. The operator may re-run an identical
        // batch at will — same prompt, same toggles — because generation
        // is non-deterministic and a second roll is often the whole point
        // (removed 2026-08-21).
        const canReEnhance = batchTerminal && reEnhanceCount > 0;
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
                ? "border-cta bg-cta hover:bg-cta-dark text-white"
                : "border-line bg-panel-hi text-ink-faint cursor-not-allowed"}
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
            <h2 className="font-display text-xl text-ink uppercase tracking-[0.14em]">
              Results — {variantsByFile.size} image{variantsByFile.size !== 1 ? "s" : ""}
            </h2>
            <span className="text-sm text-ink italic">
              One card per source · all providers compared side-by-side
              {scansPending && " · scanning results as they land"}
            </span>
          </header>

          {enhanceJobs.size === 0 && isRunning && (
            <div className="rounded-xl border border-line bg-well/60 px-4 py-6 text-center text-xs text-ink-faint flex items-center justify-center gap-2">
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
              return (
                <SourceCompareCard
                  key={f.id}
                  file={f}
                  variants={variants}
                  chosen={chosen}
                  held={heldFiles.has(f.id)}
                  /* Nothing forwards to the Scan tab any more — the scan is
                     inline on this card. Kept as a prop so the card's own
                     "already sent" treatment survives for a future caller. */
                  sent={false}
                  nowMs={nowMs}
                  judgeResult={judgeByFile.get(f.id) ?? null}
                  scans={scansByFile.get(f.id) ?? {}}
                  forkVisibility={forkVisFor(f.id)}
                  onForkVisibilityChange={(next) => setForkVis(f.id, next)}
                  promptIsCustom={promptIsCustom}
                  showForkControls={
                    forkConditionalsOn &&
                    (meta.equipmentType ?? "forklift") !== "scissor_lift"
                  }
                  adjustments={adjByFile.get(f.id) ?? {}}
                  adjusting={adjustingByFile.get(f.id) ?? {}}
                  onAdjustChange={(provider, adj) => handleAdjustChange(f.id, provider, adj)}
                  onAdjustApply={(provider) => void handleAdjustApply(f.id, provider)}
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

      {/* ── Export ──
          Moved here from the removed Resize tab. Operates on the
          operator-picked winners. Export is also the save: the click writes
          the finished files into Your Photo Library. Only picked winners get
          here, so unselected variants are never persisted. */}
      {pickedWinners.length > 0 && (
        <ExportControls
          sessionId={sessionId}
          assets={pickedWinners.map(({ item }) => ({
            assetId:      item.outputAssetId,
            filename:     item.filename,
            thumbnailUrl: item.outputUrl,
            provider:     item.provider,
            // The pre-enhance photo. Export saves it into the project
            // alongside the enhanced file, so the library keeps the before.
            originalAssetId: item.sourceAssetId,
          }))}
          meta={meta}
          userEmail={userEmail}
        />
      )}

      {/* ── Model attribution ── */}
      {enhanceJobs.size > 0 && (
        <p className="text-[11px] text-muted text-center">
          Enhancement powered by{" "}
          {ENHANCE_PROVIDERS.filter((p) => selectedProviders.has(p)).map((p, i, arr) => (
            <span key={p}>
              <code className="font-mono">{ENHANCE_PROVIDER_LABELS[p]}</code>
              {i < arr.length - 1 ? " · " : ""}
            </span>
          ))}
        </p>
      )}

    </div>
  );
}
