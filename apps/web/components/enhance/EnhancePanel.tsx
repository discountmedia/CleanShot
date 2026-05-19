"use client";
// apps/web/components/enhance/EnhancePanel.tsx
// Enhance tab — Phase 2 v2.5
//
// Features:
//  • Up to 22 simultaneous uploads (queued, not processed simultaneously)
//  • Client-side compression when file > 4.5 MB (Vercel limit)
//  • Thumbnail grid with upload progress per image
//  • Optional forklift metadata fields (make, model, year, tire type, capacity, fuel)
//  • 7 enhancement toggles
//  • Direct-to-GCS upload via V4 signed PUT URL (API pod never receives bytes)
//  • Enqueues enhance job per uploaded asset, shows per-job polling
//
// Model: gemini-2.5-flash-image (confirmed in FastAPI lifespan)

import { useCallback, useId, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";  // pnpm add uuid @types/uuid

import { buildEnhanceFilename, convertToJpeg, formatBytes } from "../../lib/compress";
import {
  DEFAULT_TOGGLES,
  TOGGLE_LABELS,
  TOGGLE_DESCRIPTIONS,
  type EnhanceToggles,
  type ForkliftMeta,
  type UploadFile,
} from "../../lib/types";
import {
  createSession,
  enqueueEnhance,
  getAssetUrl,
  getSignedUploadUrl,
  uploadToGcs,
} from "../../lib/api";
import { useJobPoller } from "../../lib/polling";
import type { JobRecord } from "../../lib/types";

const MAX_UPLOADS = 22;

// ─── Sub-components ───────────────────────────────────────────────────────────

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
      {/* Toggle button */}
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
      {/* Label + description */}
      <div className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-zinc-500 mt-0.5 leading-snug">{description}</span>
      </div>
    </label>
  );
}

function ThumbnailCard({ file }: { file: UploadFile }) {
  return (
    <div className="relative group rounded-lg overflow-hidden bg-zinc-900 border border-zinc-800">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={file.previewUrl}
        alt={file.file.name}
        className="w-full aspect-square object-cover"
      />

      {/* Status overlay */}
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

      {/* Done badge */}
      {file.status === "done" && (
        <div className="absolute top-1.5 right-1.5 bg-green-500 rounded-full p-0.5">
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}

      {/* Compressed badge */}
      {file.compressedSize !== undefined && (
        <div className="absolute bottom-1.5 left-1.5 bg-black/70 rounded px-1.5 py-0.5 text-[10px] text-yellow-300">
          {formatBytes(file.compressedSize)}
        </div>
      )}

      {/* Filename tooltip */}
      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-1.5 translate-y-full group-hover:translate-y-0 transition-transform">
        <p className="text-xs text-white truncate">{file.file.name}</p>
      </div>
    </div>
  );
}

// ─── Metadata form ────────────────────────────────────────────────────────────

const META_FIELDS: Array<{
  key: keyof ForkliftMeta;
  label: string;
  placeholder: string;
  required?: boolean;
}> = [
  { key: "make",      label: "Make",      placeholder: "e.g. Toyota",     required: true },
  { key: "model",     label: "Model",     placeholder: "e.g. 8FGU25" },
  { key: "year",      label: "Year",      placeholder: "e.g. 2019" },
  { key: "tireType",  label: "Tire Type", placeholder: "e.g. Pneumatic" },
  { key: "capacity",  label: "Capacity",  placeholder: "e.g. 5000 lbs" },
  { key: "fuelType",  label: "Fuel Type", placeholder: "e.g. LPG" },
];

function MetaFields({
  meta,
  onChange,
}: {
  meta: Partial<ForkliftMeta>;
  onChange: (meta: Partial<ForkliftMeta>) => void;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {META_FIELDS.map(({ key, label, placeholder, required }) => {
        const missing = required && !(meta[key] ?? "").trim();
        return (
          <div key={key}>
            <label className="flex items-center gap-1 text-xs font-medium text-zinc-400 mb-1">
              {label}
              {required && <span className="text-red-500" aria-label="required">*</span>}
            </label>
            <input
              type="text"
              value={meta[key] ?? ""}
              onChange={(e) => onChange({ ...meta, [key]: e.target.value })}
              placeholder={placeholder}
              required={required}
              aria-required={required}
              aria-invalid={missing || undefined}
              className={`w-full bg-zinc-900 border rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:border-transparent transition ${
                missing
                  ? "border-red-800 focus:ring-red-500"
                  : "border-zinc-700 focus:ring-blue-500"
              }`}
            />
          </div>
        );
      })}
    </div>
  );
}

// ─── Job status row ───────────────────────────────────────────────────────────

function JobStatusRow({
  file,
  jobId,
  sent,
  onComplete,
  onSend,
}: {
  file: UploadFile;
  jobId: string;
  /** True once the user has already "sent to Scan" — disables the per-row button. */
  sent: boolean;
  // Resolved by the parent into a thumbnailUrl appended to the pipeline.
  // Called once, after a successful job has its signed URL minted.
  onComplete: (job: JobRecord, outputUrl: string) => void;
  /** Per-row "Send to Scan" click handler. */
  onSend: () => void;
}) {
  const [job, setJob] = useState<JobRecord | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);

  useJobPoller(
    jobId,
    (j) => setJob(j),
    (j) => {
      // Job completed — fetch the signed GET URL for the output asset, then
      // hand it up so the workspace can append it to enhancedAssets and the
      // Scan / Resize tabs immediately see it.
      setJob(j);
      if (j.outputAssetId) {
        getAssetUrl(j.outputAssetId)
          .then((res) => {
            setOutputUrl(res.url);
            onComplete(j, res.url);
          })
          .catch((err: Error) => setOutputError(err.message));
      }
    },
    (j) => setJob(j)
  );

  const statusColor: Record<string, string> = {
    queued:     "text-yellow-400",
    processing: "text-blue-400",
    complete:   "text-green-400",
    failed:     "text-red-400",
    cancelled:  "text-zinc-400",
  };

  const isProcessing = job?.status === "processing" || job?.status === "queued";
  const isFailed     = job?.status === "failed";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-900 gap-3">
        <div className="min-w-0 flex-1">
          <p
            className="text-sm text-zinc-200 font-mono truncate"
            title={file.uploadedFilename ?? file.file.name}
          >
            {file.uploadedFilename ?? file.file.name}
          </p>
          {file.uploadedFilename && file.uploadedFilename !== file.file.name && (
            <p className="text-[10px] text-zinc-600 truncate" title={file.file.name}>
              from {file.file.name}
            </p>
          )}
        </div>
        {job ? (
          <span className={`text-xs font-semibold uppercase tracking-[0.18em] ${statusColor[job.status] ?? "text-zinc-400"}`}>
            {job.status === "processing" && (
              <svg className="inline animate-spin w-3.5 h-3.5 mr-1.5 -mt-0.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
            )}
            {job.status}
          </span>
        ) : (
          <span className="text-xs uppercase tracking-[0.18em] text-zinc-500">Waiting…</span>
        )}
      </div>

      {/* Body — large before/after */}
      <div className="p-5">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-center gap-4">
          {/* Original */}
          <figure className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">Original</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={file.previewUrl}
              alt={`${file.file.name} (original)`}
              className="w-full aspect-square object-contain bg-zinc-950 rounded-lg border border-zinc-800"
            />
          </figure>

          {/* Arrow */}
          <div className="hidden md:flex items-center justify-center text-3xl text-zinc-700" aria-hidden="true">
            →
          </div>

          {/* Enhanced (or placeholder) */}
          <figure className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">Enhanced</span>
            {outputUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={outputUrl}
                alt={`${file.file.name} (enhanced)`}
                className="w-full aspect-square object-contain bg-zinc-950 rounded-lg border border-green-900"
              />
            ) : (
              <div className="w-full aspect-square rounded-lg border border-dashed border-zinc-800 bg-zinc-950 flex items-center justify-center">
                {isProcessing ? (
                  <div className="flex flex-col items-center gap-2 text-zinc-600">
                    <svg className="animate-spin w-8 h-8" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    <span className="text-xs uppercase tracking-[0.18em]">{job?.status}</span>
                  </div>
                ) : isFailed ? (
                  <div className="text-center px-4 text-red-400">
                    <svg className="w-10 h-10 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                    <p className="text-xs uppercase tracking-[0.18em] font-semibold">Failed</p>
                  </div>
                ) : (
                  <span className="text-zinc-700 text-xs uppercase tracking-[0.18em]">Awaiting</span>
                )}
              </div>
            )}
          </figure>
        </div>

        {/* Error detail */}
        {isFailed && job?.error && (
          <p className="mt-4 text-xs text-red-400 bg-red-950/30 border border-red-900 rounded px-3 py-2 font-mono leading-relaxed">
            {job.error}
          </p>
        )}
        {outputError && (
          <p className="mt-4 text-xs text-red-400">
            Could not load output: {outputError}
          </p>
        )}

        {/* Action row */}
        {outputUrl && (
          <div className="mt-4 flex items-center justify-end gap-2">
            <a
              href={outputUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs uppercase tracking-[0.18em] font-semibold text-zinc-400 hover:text-white transition-colors px-3 py-2 border border-zinc-800 hover:border-zinc-600 rounded"
            >
              Open full size
            </a>
            {sent ? (
              <span className="text-xs uppercase tracking-[0.18em] font-semibold text-zinc-600 px-3 py-2">
                ✓ Sent
              </span>
            ) : (
              <button
                onClick={onSend}
                className="text-xs uppercase tracking-[0.18em] font-semibold text-white bg-red-600 hover:bg-red-500 border border-red-500 transition-colors px-3 py-2 rounded"
              >
                Send to Scan →
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export interface CompletedEnhanceItem {
  jobId: string;
  outputAssetId: string;
  filename: string;
  /** Signed GET URL for the enhanced image (works as both preview and full-size). */
  outputUrl: string;
}

export interface EnhancePanelProps {
  sessionId: string;
  /**
   * Called when the user explicitly clicks "Send to Scan" (per-row) or
   * "Send all to Scan tab" (batch). The workspace appends to its
   * enhancedAssets pipeline and switches to the Scan tab. Nothing happens
   * automatically — completion alone does not push to Scan.
   */
  onSendToScan: (items: CompletedEnhanceItem[]) => void;
}

export function EnhancePanel({ sessionId, onSendToScan }: EnhancePanelProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles]           = useState<UploadFile[]>([]);
  const [toggles, setToggles]       = useState<EnhanceToggles>(DEFAULT_TOGGLES);
  const [meta, setMeta]             = useState<Partial<ForkliftMeta>>({});
  const [enhanceJobs, setEnhanceJobs] = useState<Map<string, string>>(new Map()); // fileId → jobId
  const [isRunning, setIsRunning]   = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const makeValid = Boolean(meta.make?.trim());

  // Completed-but-not-yet-sent state for the explicit "Send to Scan" flow.
  // Keyed by jobId so a re-poll on remount won't duplicate.
  const [completed, setCompleted]   = useState<Map<string, CompletedEnhanceItem>>(new Map());
  const [sentJobIds, setSentJobIds] = useState<Set<string>>(new Set());

  const markCompleted = useCallback((item: CompletedEnhanceItem) => {
    setCompleted((prev) => {
      if (prev.has(item.jobId)) return prev;
      const next = new Map(prev);
      next.set(item.jobId, item);
      return next;
    });
  }, []);

  const sendOne = useCallback((item: CompletedEnhanceItem) => {
    if (sentJobIds.has(item.jobId)) return;
    onSendToScan([item]);
    setSentJobIds((prev) => new Set(prev).add(item.jobId));
  }, [onSendToScan, sentJobIds]);

  const unsentItems = Array.from(completed.values()).filter(
    (it) => !sentJobIds.has(it.jobId)
  );

  const sendAll = useCallback(() => {
    if (unsentItems.length === 0) return;
    onSendToScan(unsentItems);
    setSentJobIds((prev) => {
      const next = new Set(prev);
      for (const it of unsentItems) next.add(it.jobId);
      return next;
    });
  }, [onSendToScan, unsentItems]);

  const anyToggleOn = Object.values(toggles).some(Boolean);

  // ─── File picker ──────────────────────────────────────────────────────────

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

  // ─── Upload + Enhance pipeline ────────────────────────────────────────────

  const updateFile = useCallback((id: string, patch: Partial<UploadFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const runUploadAndEnhance = async (
    uploadFile: UploadFile,
    index: number,
    total: number,
  ) => {
    const { id, file } = uploadFile;

    // Step 1: convert to JPEG + rename to {make}_{model}_{year}_{NN}.jpg.
    // This is unconditional — every upload runs through this step so the
    // worker always receives a deterministic JPEG with the operator's chosen
    // name. Strips problematic format metadata and decouples downstream
    // filenames from whatever the source was called.
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

    // Step 2: get signed PUT URL (always JPEG content type now)
    updateFile(id, { status: "uploading", progress: 0 });
    let signedResp: Awaited<ReturnType<typeof getSignedUploadUrl>>;
    try {
      signedResp = await getSignedUploadUrl({
        sessionId,
        filename: toUpload.name,
        contentType: "image/jpeg",
      });
    } catch {
      updateFile(id, { status: "error", error: "Failed to get upload URL" });
      return;
    }

    // Step 3: PUT directly to GCS
    try {
      await uploadToGcs(signedResp.uploadUrl, toUpload, (pct) =>
        updateFile(id, { progress: pct })
      );
      updateFile(id, { status: "done", assetId: signedResp.assetId, gcsUri: signedResp.gcsUri });
    } catch {
      updateFile(id, { status: "error", error: "Upload to GCS failed" });
      return;
    }

    // Step 4: enqueue enhance job
    try {
      const { jobId } = await enqueueEnhance({
        sessionId,
        assetId: signedResp.assetId,
        toggles,
        forkliftMeta: meta,
        idempotencyKey: `enhance-${id}`,
      });
      setEnhanceJobs((prev) => new Map(prev).set(id, jobId));
    } catch {
      updateFile(id, { status: "error", error: "Failed to enqueue enhance job" });
    }
  };

  const handleEnhanceAll = async () => {
    const pending = files.filter((f) => f.status === "pending");
    if (pending.length === 0) return;
    if (!makeValid) {
      setGlobalError("Enter the forklift Make before enhancing.");
      return;
    }
    if (!anyToggleOn) {
      setGlobalError("Enable at least one enhancement toggle before processing.");
      return;
    }
    setGlobalError(null);
    setIsRunning(true);

    // Upload all in parallel (browser limits concurrent XHRs naturally).
    // Index + total are used to assign sequential filename suffixes.
    await Promise.allSettled(
      pending.map((f, i) => runUploadAndEnhance(f, i, pending.length))
    );
    setIsRunning(false);
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const pendingCount = files.filter((f) => f.status === "pending").length;
  const doneCount    = files.filter((f) => f.status === "done").length;

  return (
    <div className="space-y-6">

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
          <p className="text-sm text-zinc-400">
            {files.length >= MAX_UPLOADS
              ? `Maximum ${MAX_UPLOADS} images reached`
              : `Drop images here or click to browse`}
          </p>
          <p className="text-xs text-zinc-600">
            Up to {MAX_UPLOADS} images · Files over 4.5 MB auto-compressed
            · {files.length}/{MAX_UPLOADS} loaded
          </p>
        </div>
      </div>

      {/* ── Thumbnail grid ── */}
      {files.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-300">
              {files.length} image{files.length !== 1 ? "s" : ""} loaded
              {doneCount > 0 && (
                <span className="ml-2 text-green-400">· {doneCount} uploaded</span>
              )}
            </h3>
            <button
              onClick={() => { files.forEach((f) => URL.revokeObjectURL(f.previewUrl)); setFiles([]); }}
              className="text-xs text-zinc-500 hover:text-red-400 transition-colors"
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

      {/* ── Forklift details (always open; Make required) ── */}
      <section className="border border-zinc-800 rounded-xl overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 bg-zinc-900/50 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">
              Forklift Details
            </span>
            <span className="text-xs text-zinc-600">
              — Make is required; used to name the uploaded files
            </span>
          </div>
          {!makeValid && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-red-400">
              Make required
            </span>
          )}
        </header>
        <div className="p-4 bg-zinc-950">
          <MetaFields meta={meta} onChange={setMeta} />
          {makeValid && (
            <p className="mt-3 text-[11px] text-zinc-500 font-mono">
              Files will be uploaded as{" "}
              <span className="text-zinc-300">
                {buildEnhanceFilename(meta, 0, Math.max(files.length, 1))}
              </span>
              {files.length > 1 && <> through <span className="text-zinc-300">
                {buildEnhanceFilename(meta, files.length - 1, files.length)}
              </span></>}
            </p>
          )}
        </div>
      </section>

      {/* ── Enhancement toggles ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-zinc-200">Enhancements</h3>
          <button
            onClick={() => setToggles(DEFAULT_TOGGLES)}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Reset
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(Object.keys(TOGGLE_LABELS) as Array<keyof EnhanceToggles>).map((key) => (
            <ToggleSwitch
              key={key}
              id={`toggle-${key}`}
              label={TOGGLE_LABELS[key]}
              description={TOGGLE_DESCRIPTIONS[key]}
              checked={toggles[key]}
              onChange={(v) => setToggles((prev) => ({ ...prev, [key]: v }))}
            />
          ))}
        </div>

        {!anyToggleOn && (
          <p className="mt-2 text-xs text-amber-500" role="alert">
            Enable at least one toggle to apply enhancements.
          </p>
        )}
      </div>

      {/* ── Global error ── */}
      {globalError && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3" role="alert">
          {globalError}
        </p>
      )}

      {/* ── Enhance button ── */}
      <button
        onClick={handleEnhanceAll}
        disabled={pendingCount === 0 || !anyToggleOn || !makeValid || isRunning}
        className={`
          w-full py-3 px-6 rounded-xl font-semibold text-sm transition-all
          ${pendingCount > 0 && anyToggleOn && makeValid && !isRunning
            ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40"
            : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}
        `}
      >
        {isRunning
          ? "Converting, uploading & enhancing…"
          : pendingCount > 0
            ? !makeValid
              ? "Enter forklift Make to continue"
              : !anyToggleOn
                ? "Enable at least one enhancement toggle"
                : `Enhance ${pendingCount} Image${pendingCount !== 1 ? "s" : ""}`
            : doneCount > 0
              ? "All images processing"
              : "Add images above"}
      </button>

      {/* ── Per-job status rows ── */}
      {enhanceJobs.size > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Enhance Jobs</h3>
          {files
            .filter((f) => enhanceJobs.has(f.id))
            .map((f) => (
              <JobStatusRow
                key={f.id}
                file={f}
                jobId={enhanceJobs.get(f.id)!}
                sent={sentJobIds.has(enhanceJobs.get(f.id)!)}
                onComplete={(job, outputUrl) => {
                  if (job.outputAssetId) {
                    markCompleted({
                      jobId: job.id,
                      outputAssetId: job.outputAssetId,
                      filename: f.file.name,
                      outputUrl,
                    });
                  }
                }}
                onSend={() => {
                  const item = completed.get(enhanceJobs.get(f.id)!);
                  if (item) sendOne(item);
                }}
              />
            ))}
        </div>
      )}

      {/* ── Send-all-to-Scan batch button ── */}
      {completed.size > 0 && (
        <button
          onClick={sendAll}
          disabled={unsentItems.length === 0}
          className={`
            w-full py-4 px-6 rounded-xl font-bold text-sm uppercase tracking-[0.18em] transition-all border-2
            ${unsentItems.length > 0
              ? "bg-red-600 hover:bg-red-500 border-red-500 text-white shadow-lg shadow-red-900/40"
              : "bg-zinc-900 border-zinc-800 text-zinc-600 cursor-not-allowed"}
          `}
        >
          {unsentItems.length > 0
            ? <>Send {unsentItems.length} image{unsentItems.length !== 1 ? "s" : ""} to Scan tab →</>
            : <>✓ All sent to Scan</>}
        </button>
      )}

      {/* ── Model attribution ── */}
      <p className="text-[11px] text-zinc-700 text-center">
        Enhancement powered by{" "}
        <code className="font-mono">gemini-2.5-flash-image</code>
      </p>
    </div>
  );
}
