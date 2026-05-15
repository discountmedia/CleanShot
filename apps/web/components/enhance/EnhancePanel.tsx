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
// Model: gemini-3-pro-image-preview (confirmed in FastAPI lifespan)

import { useCallback, useId, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";  // pnpm add uuid @types/uuid

import { compressIfNeeded, formatBytes, MAX_BYTES } from "../../lib/compress";
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

const META_FIELDS: Array<{ key: keyof ForkliftMeta; label: string; placeholder: string }> = [
  { key: "make",      label: "Make",      placeholder: "e.g. Toyota" },
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
      {META_FIELDS.map(({ key, label, placeholder }) => (
        <div key={key}>
          <label className="block text-xs font-medium text-zinc-400 mb-1">{label}</label>
          <input
            type="text"
            value={meta[key] ?? ""}
            onChange={(e) => onChange({ ...meta, [key]: e.target.value })}
            placeholder={placeholder}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
          />
        </div>
      ))}
    </div>
  );
}

// ─── Job status row ───────────────────────────────────────────────────────────

function JobStatusRow({
  file,
  jobId,
  onComplete,
}: {
  file: UploadFile;
  jobId: string;
  onComplete: (job: JobRecord) => void;
}) {
  const [job, setJob] = useState<JobRecord | null>(null);

  useJobPoller(
    jobId,
    (j) => setJob(j),
    (j) => { setJob(j); onComplete(j); },
    (j) => setJob(j)
  );

  const statusColor: Record<string, string> = {
    queued:     "text-yellow-400",
    processing: "text-blue-400",
    complete:   "text-green-400",
    failed:     "text-red-400",
    cancelled:  "text-zinc-400",
  };

  return (
    <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 rounded-lg border border-zinc-800">
      <span className="text-xs text-zinc-400 truncate max-w-[160px]">{file.file.name}</span>
      {job ? (
        <span className={`text-xs font-medium ${statusColor[job.status] ?? "text-zinc-400"}`}>
          {job.status === "processing" && (
            <svg className="inline animate-spin w-3 h-3 mr-1" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
          )}
          {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
        </span>
      ) : (
        <span className="text-xs text-zinc-500">Waiting…</span>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export interface EnhancePanelProps {
  sessionId: string;
  onEnhanceComplete: (jobId: string, outputAssetId: string) => void;
}

export function EnhancePanel({ sessionId, onEnhanceComplete }: EnhancePanelProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles]           = useState<UploadFile[]>([]);
  const [toggles, setToggles]       = useState<EnhanceToggles>(DEFAULT_TOGGLES);
  const [meta, setMeta]             = useState<Partial<ForkliftMeta>>({});
  const [enhanceJobs, setEnhanceJobs] = useState<Map<string, string>>(new Map()); // fileId → jobId
  const [metaOpen, setMetaOpen]     = useState(false);
  const [isRunning, setIsRunning]   = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

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

  const runUploadAndEnhance = async (uploadFile: UploadFile) => {
    const { id, file } = uploadFile;

    // Step 1: compress if needed
    let toUpload = file;
    if (file.size > MAX_BYTES) {
      updateFile(id, { status: "compressing" });
      try {
        toUpload = await compressIfNeeded(file);
        updateFile(id, { compressedSize: toUpload.size });
      } catch (err) {
        updateFile(id, { status: "error", error: "Compression failed" });
        return;
      }
    }

    // Step 2: get signed PUT URL
    updateFile(id, { status: "uploading", progress: 0 });
    let signedResp: Awaited<ReturnType<typeof getSignedUploadUrl>>;
    try {
      signedResp = await getSignedUploadUrl({
        sessionId,
        filename: toUpload.name,
        contentType: toUpload.type || "image/jpeg",
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
    if (!anyToggleOn) {
      setGlobalError("Enable at least one enhancement toggle before processing.");
      return;
    }
    setGlobalError(null);
    setIsRunning(true);

    // Upload all in parallel (browser limits concurrent XHRs naturally)
    await Promise.allSettled(pending.map(runUploadAndEnhance));
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

      {/* ── Forklift metadata (collapsible) ── */}
      <div className="border border-zinc-800 rounded-xl overflow-hidden">
        <button
          onClick={() => setMetaOpen((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 bg-zinc-900/50 hover:bg-zinc-900 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-300">Forklift Details</span>
            <span className="text-xs text-zinc-600">(optional — helps AI cross-reference catalogue)</span>
          </div>
          <svg
            className={`w-4 h-4 text-zinc-500 transition-transform ${metaOpen ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {metaOpen && (
          <div className="p-4 bg-zinc-950 border-t border-zinc-800">
            <MetaFields meta={meta} onChange={setMeta} />
          </div>
        )}
      </div>

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
        disabled={pendingCount === 0 || !anyToggleOn || isRunning}
        className={`
          w-full py-3 px-6 rounded-xl font-semibold text-sm transition-all
          ${pendingCount > 0 && anyToggleOn && !isRunning
            ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40"
            : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}
        `}
      >
        {isRunning
          ? "Uploading & Enhancing…"
          : pendingCount > 0
            ? `Enhance ${pendingCount} Image${pendingCount !== 1 ? "s" : ""}`
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
                onComplete={(job) => {
                  if (job.outputAssetId) {
                    onEnhanceComplete(job.id, job.outputAssetId);
                  }
                }}
              />
            ))}
        </div>
      )}

      {/* ── Model attribution ── */}
      <p className="text-[11px] text-zinc-700 text-center">
        Enhancement powered by{" "}
        <code className="font-mono">gemini-3-pro-image-preview</code>
      </p>
    </div>
  );
}
