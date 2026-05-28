"use client";
// apps/web/components/resize/ResizePanel.tsx
//
// Resize tab — Phase 3
//
// Flow:
//   1. Operator fills the 9 project fields (or accepts defaults from prior
//      tabs once that state is lifted to Workspace — currently not lifted,
//      so this tab collects them fresh).
//   2. Click "Save Project"      → POST /api/projects/save
//      Backend flips projects.saved_at, unblocking the export endpoints.
//   3. Click "Export PRO (ZIP)"  → POST /api/export/pro
//      Backend returns a binary ZIP (or single JPEG if only one asset).
//      The browser is then handed the blob via an <a download> click.
//
// PRO spec (server-enforced via pyvips, see services/image_processing.py):
//   • 1024×731 px, 7:5 aspect ratio
//   • Zoom-to-fill (crop, never letterbox)
//   • JPEG, iteratively re-encoded until ≤100 KB (or X-Warning header set)
//
// Custom + Fullsize + streaming-ZIP endpoints exist on the backend too but
// are intentionally not surfaced here yet — PRO is the only preset the
// operator needs day-to-day. Add an "Advanced" disclosure later if usage
// data shows they're wanted.

import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  approveSet,
  createBrandedCollage,
  exportCollageAsBlob,
  exportProPreviewStream,
  getSignedUploadUrl,
  saveProject,
  uploadToGcs,
  type ExportProPreviewItem,
} from "../../lib/api";
import { convertToJpeg } from "../../lib/compress";
import {
  EQUIPMENT_GROUPS,
  EQUIPMENT_TYPE_LABELS,
  type EquipmentType,
  type ForkliftMeta,
  type ResizeResult,
} from "../../lib/types";
import { TipBanner } from "../workspace/TipBanner";

const MAX_UPLOADS = 10;

// Watermark string burnt into the bottom-right corner of every exported
// JPEG when the operator ticks "Add AI disclaimer". Wording reads as an
// honest disclosure that doesn't oversell the AI's role — the unit IS
// real, the photo has just been cleaned up to show it as it will arrive.
// Backend pyvips uses the same string; keep in sync if you change one.
export const AI_DISCLAIMER_WATERMARK =
  "AI-enhanced image — depicts the unit as it will be delivered";

/**
 * Local state for a file the operator dropped directly onto the Resize
 * tab (standalone mode — bypasses the Enhance / Scan pipeline). Each
 * file is JPEG-converted client-side, uploaded to GCS via a signed PUT,
 * then registered as an asset that the export endpoints can consume.
 *
 * Status machine:
 *   uploading → done  (happy path; `assetId` set)
 *   uploading → error ('error' string set)
 */
interface StandaloneUpload {
  id:         string;        // local UUID, used as React key
  filename:   string;        // post-convertToJpeg name
  previewUrl: string;        // createObjectURL on the original File
  size:       number;        // post-convertToJpeg bytes
  status:     "uploading" | "done" | "error";
  progress:   number;        // 0-100 during upload, 100 when done
  assetId?:   string;        // populated when status flips to done
  error?:     string;        // populated when status flips to error
}

export interface ResizePanelProps {
  sessionId: string;
  /**
   * Curated list of assets the user "Send to Resize"'d from the Scan tab.
   * `provider` is carried so the backend export endpoint can append the
   * model name to each output filename — when the operator sends the
   * same source image's Gemini + OpenAI variants both to Resize, the
   * ZIP entries become `..._01_Gemini.jpg` and `..._01_Openai.jpg`
   * instead of two same-named files.
   */
  enhancedAssets: Array<{ assetId: string; filename: string; thumbnailUrl: string; provider?: string }>;
  /**
   * Kept for prop compatibility with Workspace. The current PRO flow returns a
   * single ZIP blob and does not produce per-asset ResizeResult rows, so this
   * isn't rendered. Wire it up when a future preview-grid UX needs per-image
   * signed URLs.
   */
  resizeResults: ResizeResult[];
  /** Kept for prop compatibility with Workspace; not currently invoked. */
  onResizeComplete: (results: ResizeResult[]) => void;
  /**
   * Resets the cross-tab pipeline state (Workspace's enhancedAssets +
   * resizeAssets + resizeResults). Used by the local "Clear all" button
   * so the operator can wipe everything queued for export — both the
   * curated set from Enhance/Scan AND the standalone uploads — and
   * start fresh without a page reload. Optional so older callers without
   * the prop don't break.
   */
  onClearPipeline?: () => void;
  /**
   * Shared forklift metadata from Workspace state. The Resize tab's Save
   * Project form pre-fills from this — the operator already typed
   * make / model / year on the Enhance tab, so re-entry would be busywork.
   * Read-only here (the form has its own local edit state for any
   * field the operator wants to tweak before saving).
   */
  meta: Partial<ForkliftMeta>;
  /**
   * Signed-in user's email. Used to pre-fill the Username field so the
   * operator doesn't re-type it every project.
   */
  userEmail: string;
}

interface ProjectForm {
  make:      string;
  year:      string;        // input value; parsed to int before send
  model:     string;
  tireType:  string;
  capacity:  string;
  fuelType:  string;
  username:  string;
}

const EMPTY_FORM: ProjectForm = {
  make:      "",
  year:      "",
  model:     "",
  tireType:  "",
  capacity:  "",
  fuelType:  "",
  username:  "",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateForm(form: ProjectForm): { valid: boolean; yearNum: number | null } {
  // Per-product call: only `make` and `model` are gating fields for the
  // Save Project action. Year is parsed if provided (validated 1900-2100)
  // and falls back to the current year when blank. Capacity / tireType /
  // fuelType / username are nice-to-have free text — empty values get
  // replaced with "unknown" / the operator's email before send so the
  // backend's NOT-NULL columns are still satisfied.
  const yearRaw = form.year.trim();
  let yearNum: number | null = null;
  if (yearRaw.length === 0) {
    yearNum = new Date().getFullYear();
  } else {
    const parsed = Number.parseInt(yearRaw, 10);
    if (Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2100) {
      yearNum = parsed;
    }
  }
  const valid = form.make.trim().length > 0 && form.model.trim().length > 0 && yearNum !== null;
  return { valid, yearNum };
}

// ─── Form field components ────────────────────────────────────────────────────

function TextField({
  label, value, onChange, placeholder, disabled, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm uppercase tracking-[0.16em] text-zinc-100 font-bold">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-base text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition disabled:opacity-50"
      />
      {hint && <span className="text-base text-yellow-300 font-semibold leading-relaxed">{hint}</span>}
    </label>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function ResizePanel({
  sessionId,
  enhancedAssets,
  onClearPipeline,
  meta,
  userEmail,
}: ResizePanelProps) {
  // Initialise the form from the values the operator already entered on
  // the Enhance tab + their signed-in email. Once the form mounts the
  // local state takes over — edits stay local until Save Project. If
  // the operator returns to Enhance and changes meta, the next mount of
  // this panel (or the effect below) reflects the new values.
  const [form, setForm] = useState<ProjectForm>(() => ({
    ...EMPTY_FORM,
    make:     meta.make     ?? "",
    model:    meta.model    ?? "",
    year:     meta.year     ?? "",
    tireType: meta.tireType ?? "",
    capacity: meta.capacity ?? "",
    fuelType: meta.fuelType ?? "",
    username: userEmail && userEmail !== "dev@local" ? userEmail : "",
  }));

  // Keep the form in sync when Workspace's meta changes (e.g. the
  // operator edits the Enhance form while the Resize panel is mounted
  // but hidden). Only fills in fields the operator hasn't already
  // touched locally — once they've typed something we don't clobber it.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from upstream prop to local form state; uses functional setForm so prior input survives.
  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      make:     prev.make     || (meta.make     ?? ""),
      model:    prev.model    || (meta.model    ?? ""),
      year:     prev.year     || (meta.year     ?? ""),
      tireType: prev.tireType || (meta.tireType ?? ""),
      capacity: prev.capacity || (meta.capacity ?? ""),
      fuelType: prev.fuelType || (meta.fuelType ?? ""),
      username: prev.username || (userEmail && userEmail !== "dev@local" ? userEmail : ""),
    }));
  }, [meta, userEmail]);

  // Status flags. `isSaved` flips true after a successful Save — Export is
  // gated on it. Editing the form after a successful Save does NOT unset
  // isSaved (the backend project row is still saved); we re-enable Save so
  // the user can push the updated metadata in (it's an UPSERT server-side).
  const [isSaving,           setIsSaving]           = useState(false);
  const [isSaved,            setIsSaved]            = useState(false);
  const [isExporting,        setIsExporting]        = useState(false);
  const [isExportingCollage, setIsExportingCollage] = useState(false);
  const [isCreatingCollage,  setIsCreatingCollage]  = useState(false);
  const [collageEquipmentType, setCollageEquipmentType] =
    useState<EquipmentType | null>(null);

  // Branded-collage result state. When set, the preview card renders
  // with the composed JPEG + Download + Save-to-History buttons so the
  // operator can review before deciding what to do with it. The blob
  // URL is revoked when the operator dismisses or creates another.
  const [collageBlob,        setCollageBlob]        = useState<Blob | null>(null);
  const [collagePreviewUrl,  setCollagePreviewUrl]  = useState<string | null>(null);
  const [collageFilename,    setCollageFilename]    = useState<string | null>(null);
  const [collageSizeBytes,   setCollageSizeBytes]   = useState<number>(0);
  const [collageSizeWarning, setCollageSizeWarning] = useState<boolean>(false);
  const [collageSavingToHistory, setCollageSavingToHistory] = useState(false);
  const [collageSavedToHistory,  setCollageSavedToHistory]  = useState(false);
  const [error,              setError]              = useState<string | null>(null);
  // Operator toggle — when on, the export pipeline burns a very small,
  // semi-transparent disclaimer into the bottom-right corner of every
  // exported JPEG. The exact text is the AI_DISCLAIMER_WATERMARK
  // constant below; backend pyvips draws it server-side so the bytes
  // the customer receives carry the disclaimer permanently.
  const [addAiDisclaimer,    setAddAiDisclaimer]    = useState(false);

  // Standalone-upload state. Each entry is a file the operator dropped
  // directly on the Resize tab (vs. routed through Enhance/Scan first).
  // Once an upload's status flips to "done" + has assetId, it merges
  // with `enhancedAssets` (the prop) to form the export set.
  const [uploads, setUploads] = useState<StandaloneUpload[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  // Upload pipeline: client-side JPEG conversion (≤4.5 MB target +
  // optional long-edge cap from compress.ts), signed PUT to GCS,
  // register asset_id on success. Identical pattern to EnhancePanel.addFiles
  // minus the enqueueEnhance step — standalone Resize doesn't run any AI.
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

      // Reserve a slot in `uploads` for each file before kicking off
      // async work so the UI shows them immediately. `previewUrl` uses
      // the original File (pre-JPEG conversion) — for display only, so
      // format consistency doesn't matter.
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

      // Fire upload pipelines in parallel — getSignedUploadUrl is cheap
      // and uploadToGcs is bandwidth-bound, so concurrency helps.
      next.forEach((u, i) => {
        void runUpload(u.id, accepted[i]);
      });
    },
    [uploads.length, runUpload],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) addFiles(e.target.files);
      // Reset so picking the same file twice still fires onChange.
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

  // Done uploads merged with the prop-supplied enhanced assets — both
  // feed into the same export endpoints. Pre-Enhance assets carry their
  // `provider` (Gemini / OpenAI / etc.) so the backend filename suffix
  // can disambiguate variants; standalone uploads don't have a provider.
  const standaloneAssets = uploads
    .filter((u) => u.status === "done" && u.assetId)
    .map((u) => ({
      assetId:      u.assetId as string,
      filename:     u.filename,
      thumbnailUrl: u.previewUrl,
      provider:     undefined as string | undefined,
    }));
  const allAssets = [...enhancedAssets, ...standaloneAssets];
  const anyUploadInFlight = uploads.some((u) => u.status === "uploading");

  // Preview state: populated by the /api/export/pro/preview response.
  // When non-null the grid renders, the operator visually verifies the
  // 7:5 zoom-to-fill output, then clicks "Download ZIP" (a direct GCS
  // hyperlink — no second backend roundtrip).
  const [previewItems, setPreviewItems] = useState<ExportProPreviewItem[]>([]);
  const [zipUrl,       setZipUrl]       = useState<string | null>(null);
  const [zipSizeBytes, setZipSizeBytes] = useState<number>(0);
  const [anyWarning,   setAnyWarning]   = useState<boolean>(false);

  // Streaming progress state — populated by exportProPreviewStream's
  // callbacks. While `progressTotal > 0` and the result hasn't arrived
  // yet, the UI renders a determinate progress bar instead of just a
  // spinner.
  const [progressTotal,    setProgressTotal]    = useState<number>(0);
  const [progressCurrent,  setProgressCurrent]  = useState<number>(0);
  const [progressFilename, setProgressFilename] = useState<string>("");

  const { valid: formValid, yearNum } = validateForm(form);
  // `allAssets` = the prop-supplied curated set + standalone uploads.
  // Use this for export gating and submission, NOT the raw prop.
  const hasAssets = allAssets.length > 0;
  const canSave   = formValid && !isSaving;
  const canExport        = isSaved && hasAssets && !isExporting && !isExportingCollage && !anyUploadInFlight;
  const canExportCollage = isSaved && hasAssets && !isExporting && !isExportingCollage && !anyUploadInFlight;

  const updateField = <K extends keyof ProjectForm>(key: K, value: ProjectForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // ─── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!formValid || yearNum === null) return;
    setError(null);
    setIsSaving(true);
    try {
      // Auto-derive title from make/model/year — the backend's
      // SaveProjectRequest still requires a title (min_length=1), but the
      // operator already enters those values so re-typing a third name
      // would be busywork. photoType isn't surfaced in the UI either;
      // defaults to "auction" since that's the dominant use case.
      const derivedTitle =
        [form.make, form.model, form.year].map((s) => s.trim()).filter(Boolean).join(" ")
        || "Untitled";

      // Only make + model are gating fields on the form. Everything else
      // is nice-to-have, but the FastAPI schema still requires min_length=1
      // on each column. Substitute sensible placeholders when the
      // operator left them blank rather than blocking the save.
      const tireTypeOut = form.tireType.trim() || "unknown";
      const capacityOut = form.capacity.trim() || "unknown";
      const fuelTypeOut = form.fuelType.trim() || "unknown";
      const usernameOut = form.username.trim() || (userEmail && userEmail !== "dev@local" ? userEmail : "unknown");

      // 1. Commit the project metadata (unlocks the export endpoints
      // server-side by setting projects.saved_at).
      await saveProject({
        sessionId,
        title:     derivedTitle,
        make:      form.make.trim(),
        year:      yearNum,
        model:     form.model.trim(),
        tireType:  tireTypeOut,
        capacity:  capacityOut,
        fuelType:  fuelTypeOut,
        username:  usernameOut,
        photoType: "auction",
      });

      // 2. Commit the curated image set to History. Save Project is the
      // single trigger that does both — there is no separate "Approve
      // All" action. Skips silently if no assets are queued; the user
      // can still save the project metadata without an image set yet.
      if (allAssets.length > 0) {
        await approveSet({
          sessionId,
          assetIds: allAssets.map((a) => a.assetId),
          projectMeta: {
            make:  form.make.trim()  || "unknown",
            model: form.model.trim() || "unknown",
            year:  form.year.trim(),
          },
        });
      }

      setIsSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Export ─────────────────────────────────────────────────────────────────

  const handleExport = async () => {
    if (!hasAssets) return;
    setError(null);
    setIsExporting(true);
    // Wipe stale preview + progress so the loading state is unambiguous.
    setPreviewItems([]);
    setZipUrl(null);
    setZipSizeBytes(0);
    setAnyWarning(false);
    setProgressTotal(0);
    setProgressCurrent(0);
    setProgressFilename("");
    try {
      await exportProPreviewStream(
        {
          sessionId,
          assetIds:  allAssets.map((a) => a.assetId),
          // Parallel list so the backend can suffix each output's
          // filename with the model name — e.g. when the operator
          // resizes Gemini + OpenAI variants of the same source they
          // both end up in the ZIP under distinguishable names.
          // Standalone uploads have provider=undefined; backend
          // collapses those to no suffix.
          providers: allAssets.map((a) => a.provider ?? null),
          aiDisclaimer: addAiDisclaimer,
        },
        {
          onStarted: (total) => {
            setProgressTotal(total);
            setProgressCurrent(0);
          },
          onProgress: (p) => {
            setProgressCurrent(p.current);
            setProgressFilename(p.filename);
          },
          onResult: (resp) => {
            setPreviewItems(resp.items);
            setZipUrl(resp.zipUrl);
            setZipSizeBytes(resp.zipSizeBytes);
            setAnyWarning(resp.anySizeWarning);
          },
        },
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setIsExporting(false);
      // Leave the progress numbers in place after success so the bar
      // doesn't snap back to 0 between the last progress event and the
      // grid render. They get reset on the next click.
    }
  };

  // Collage export — fit-to-long-edge at 1024 px, no crop, ≤99 KB JPEG.
  // Simpler than PRO: no streaming progress + no preview grid, just a
  // straight blob download. The image's original aspect ratio is
  // preserved, so there's nothing to "preview" the way the 7:5 crop
  // needs — the operator already composed the layout upstream and just
  // wants the downsized JPEG.
  const handleExportCollage = async () => {
    if (!hasAssets) return;
    setError(null);
    setIsExportingCollage(true);
    try {
      const { blob, filename, warning } = await exportCollageAsBlob({
        sessionId,
        assetIds:  allAssets.map((a) => a.assetId),
        providers: allAssets.map((a) => a.provider ?? null),
        aiDisclaimer: addAiDisclaimer,
      });
      if (warning) setAnyWarning(true);
      // Trigger browser download. Object URL is revoked once the click
      // completes so we don't pin the blob in memory.
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Collage export failed");
    } finally {
      setIsExportingCollage(false);
    }
  };

  // ─── Branded collage ──────────────────────────────────────────────────────
  //
  // Builds the 5-image marketing collage shown to operators in the spec
  // screenshots — 1 large hero on the left + 4 thumbnails stacked on the
  // right, 1024×580 canvas, ≤99 KB JPEG. The first asset becomes the
  // hero; the next four become the thumb strip. Backend pyvips does the
  // composition (no client-side canvas work), so the output bytes match
  // exactly what gets returned to other channels.
  //
  // No auto-download — the result lands in the preview card below the
  // button so the operator can review BEFORE deciding to download
  // and/or save to history.
  const handleCreateBrandedCollage = async () => {
    if (!collageEquipmentType || allAssets.length < 5 || !isSaved) return;
    setError(null);
    setIsCreatingCollage(true);
    // Revoke any prior blob URL before we replace it so the browser
    // doesn't pin two collage blobs in memory.
    if (collagePreviewUrl) URL.revokeObjectURL(collagePreviewUrl);
    setCollageBlob(null);
    setCollagePreviewUrl(null);
    setCollageFilename(null);
    setCollageSizeBytes(0);
    setCollageSizeWarning(false);
    setCollageSavedToHistory(false);
    try {
      const { blob, filename, warning } = await createBrandedCollage({
        sessionId,
        equipmentType: collageEquipmentType,
        assetIds:      allAssets.slice(0, 5).map((a) => a.assetId),
        aiDisclaimer:  addAiDisclaimer,
      });
      setCollageBlob(blob);
      setCollagePreviewUrl(URL.createObjectURL(blob));
      setCollageFilename(filename);
      setCollageSizeBytes(blob.size);
      setCollageSizeWarning(Boolean(warning));
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? `Collage creation failed: ${err.message}`
          : "Collage creation failed",
      );
    } finally {
      setIsCreatingCollage(false);
    }
  };

  // Local download — triggers a browser <a download> click using the
  // already-fetched blob, no second backend roundtrip.
  const handleDownloadCollage = () => {
    if (!collageBlob || !collageFilename) return;
    const objectUrl = URL.createObjectURL(collageBlob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = collageFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  };

  // Save-to-History — uploads the composed JPEG to GCS as a new asset
  // (via the same signed-PUT flow the standalone Resize upload uses),
  // then folds the asset into this session's approval set. Once saved
  // it shows up under `approved/{email}/.../` on the backend and in
  // History on the frontend, alongside the other approved assets.
  const handleSaveCollageToHistory = async () => {
    if (!collageBlob || !collageFilename || collageSavingToHistory) return;
    setError(null);
    setCollageSavingToHistory(true);
    try {
      const blobAsFile = new File([collageBlob], collageFilename, {
        type: "image/jpeg",
      });
      const signed = await getSignedUploadUrl({
        sessionId,
        filename:    collageFilename,
        contentType: "image/jpeg",
      });
      await uploadToGcs(signed.uploadUrl, blobAsFile);
      await approveSet({
        sessionId,
        assetIds: [signed.assetId],
        projectMeta: {
          make:  form.make.trim()  || "unknown",
          model: form.model.trim() || "unknown",
          year:  form.year.trim(),
        },
      });
      setCollageSavedToHistory(true);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? `Save to Your Photo Library failed: ${err.message}`
          : "Save to Your Photo Library failed",
      );
    } finally {
      setCollageSavingToHistory(false);
    }
  };

  // Discard the current collage preview — revokes the blob URL and
  // resets the related state so the next click on Create starts fresh.
  const handleDiscardCollagePreview = () => {
    if (collagePreviewUrl) URL.revokeObjectURL(collagePreviewUrl);
    setCollageBlob(null);
    setCollagePreviewUrl(null);
    setCollageFilename(null);
    setCollageSizeBytes(0);
    setCollageSizeWarning(false);
    setCollageSavedToHistory(false);
  };

  // Revoke the collage blob URL on unmount so it doesn't leak.
  useEffect(() => {
    return () => {
      if (collagePreviewUrl) URL.revokeObjectURL(collagePreviewUrl);
    };
  }, [collagePreviewUrl]);

  // ─── Clear all ──────────────────────────────────────────────────────────────
  //
  // Wipes everything queued for export and every visible result on this tab:
  //   • Standalone uploads (with URL.revokeObjectURL on each preview)
  //   • PRO preview cards + ZIP signed URL + warning banner
  //   • Streaming progress numbers
  //   • Surface error message
  //   • The cross-tab pipeline state via onClearPipeline (Workspace's
  //     enhancedAssets / resizeAssets / resizeResults) — same callback the
  //     Enhance and Scan tabs already use for their own Clear All actions
  //   • Save status (so the next batch upserts the project metadata + a
  //     fresh approval set for the new image set, not the old one)
  //
  // What it deliberately does NOT touch: the project metadata form values.
  // The operator usually keeps working on the same forklift model across
  // multiple batches, so re-typing make/model/year every time would be
  // friction with no upside. Clear them manually if needed.
  const handleClearAll = () => {
    uploads.forEach((u) => URL.revokeObjectURL(u.previewUrl));
    setUploads([]);
    setPreviewItems([]);
    setZipUrl(null);
    setZipSizeBytes(0);
    setAnyWarning(false);
    setProgressTotal(0);
    setProgressCurrent(0);
    setProgressFilename("");
    setError(null);
    setIsSaved(false);
    onClearPipeline?.();
  };

  // Format bytes as KB or MB for the status badges.
  const formatBytes = (b: number): string => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── Plain-language explanation of what this tab is for ── */}
      <TipBanner
        title="Resize tab — what this does"
        steps={[
          <>Confirm the project details below (Make / Model / Year, etc.) — they pre-fill from the Enhance tab.</>,
          <>Click <span className="font-semibold text-white">Save Project</span> to lock those details in. This is required before any export.</>,
          <>Pick an export preset (PRO for standard listings, Collage for marketing posts).</>,
          <>Click the download button. Each image is auto-cropped to the listing-site size and packed into a ZIP.</>,
          <>Approved sets are saved to Your Photo Library for 60 days.</>,
        ]}
      >
        <p>
          This is the final step. Your approved photos get cropped to
          marketplace dimensions, compressed to fit listing-site upload
          caps, and saved to Your Photo Library so you can re-download
          them later if needed.
        </p>
      </TipBanner>

      {/* ── Spec card ── */}
      {/* Card background = page background (black) with a thin light
          border, matching the other cards. "Use for:" blurbs + the
          "Batch returns…" line removed per operator review — the bullet
          constraints carry the meaning. */}
      <div className="bg-black border border-zinc-700 rounded-xl p-5 space-y-5">
        <div className="space-y-2.5">
          <h3 className="text-lg font-semibold text-zinc-100">PRO CONSTRAINTS EXPORT</h3>
          <ul className="text-base text-zinc-100 space-y-1.5 leading-relaxed" role="list">
            <li>• <strong className="font-semibold text-yellow-300">1024 × 731 px</strong> — 7:5 aspect ratio</li>
            <li>• <strong className="font-semibold text-yellow-300">Zoom-to-fill</strong> — smart-crop to subject, no letterboxing</li>
            <li>• <strong className="font-semibold text-yellow-300">≤ 99 KB JPEG</strong> — quality iterated until target</li>
          </ul>
        </div>
        <div className="space-y-2.5 pt-4 border-t border-zinc-800">
          <h3 className="text-lg font-semibold text-zinc-100">COLLAGE EXPORT</h3>
          <ul className="text-base text-zinc-100 space-y-1.5 leading-relaxed" role="list">
            <li>• <strong className="font-semibold text-yellow-300">1024 px long edge</strong> — original aspect ratio preserved</li>
            <li>• <strong className="font-semibold text-yellow-300">No crop</strong> — fits to long edge; output is whatever the input&apos;s shape calls for</li>
            <li>• <strong className="font-semibold text-yellow-300">≤ 99 KB JPEG</strong> — same quality-iteration loop as PRO</li>
          </ul>
        </div>
      </div>

      {/* ── Upload (standalone) ── */}
      {/* Drop zone for resize-as-a-standalone-tool. Files dropped here
          skip Enhance/Scan entirely — they go straight to GCS and join
          the export set. Same MAX_UPLOADS cap as EnhancePanel. */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <header className="flex items-start justify-between gap-4 px-5 py-4 bg-zinc-900/50 border-b border-zinc-800">
          <div className="flex flex-col gap-1">
            <span className="text-base font-semibold uppercase tracking-[0.14em] text-zinc-100">
              Upload images directly
            </span>
            <span className="text-sm text-zinc-300 leading-relaxed">
              Skip the Enhance + Scan steps and drop photos straight in here.
              Use this when a photo is already good enough and you just need
              it cropped to listing-site size. Files are auto-converted to
              JPEG before upload.
            </span>
          </div>
          <span className="text-sm uppercase tracking-[0.18em] font-mono text-zinc-300 tabular-nums shrink-0">
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
          /* Standardized drop-zone style — matches the Scan tab
             reference (border-2 border-dashed rounded-xl p-8, blue
             hover) so every tab's uploader looks + sizes identically. */
          className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
            ${isDragging
              ? "border-blue-500 bg-blue-950/20"
              : uploads.length >= MAX_UPLOADS
                ? "border-zinc-700 opacity-50 cursor-not-allowed"
                : "border-zinc-600 hover:border-blue-500 hover:bg-blue-950/20"}`}
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
          <p className="text-base text-zinc-100 font-semibold">
            {uploads.length >= MAX_UPLOADS
              ? `Maximum ${MAX_UPLOADS} uploads reached`
              : isDragging
                ? "Drop to upload"
                : "Click or drop image files here"}
          </p>
          <p className="text-sm text-zinc-300 mt-1">
            JPEG, PNG, WebP · auto-converted to JPEG before upload
          </p>
        </div>

        {/* Thumbnail grid for in-flight + completed standalone uploads */}
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

      {/* ── Assets queued (from Enhance / Scan) ── */}
      {/* Thumbnails for images that arrived via "Send to Resize" — without
          this, when the operator clicks Send-to-Resize on the Scan tab and
          lands here, the only visible signal is a "1" / "5" in the count
          column. Showing the actual previews makes the hand-off legible
          and matches the standalone-upload grid above. */}
      {enhancedAssets.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
          <header className="flex items-start justify-between gap-4 px-5 py-4 bg-zinc-900/50 border-b border-zinc-800">
            <div className="flex flex-col gap-1">
              <span className="text-base font-semibold uppercase tracking-[0.14em] text-zinc-100">
                From Enhance / Scan
              </span>
              <span className="text-sm text-zinc-300 leading-relaxed">
                These images came from the other tabs via the &quot;Send to
                Resize&quot; buttons. They&apos;ll be included in the next
                export below.
              </span>
            </div>
            <span className="text-sm uppercase tracking-[0.18em] font-mono text-zinc-300 tabular-nums shrink-0">
              {enhancedAssets.length}
            </span>
          </header>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2 p-4">
            {enhancedAssets.map((a) => (
              <div
                key={a.assetId}
                className="relative rounded-lg overflow-hidden border border-zinc-800 bg-zinc-900"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.thumbnailUrl}
                  alt={a.filename}
                  className="w-full aspect-square object-cover"
                />
                {a.provider && (
                  <span className="absolute top-1 right-1 text-[9px] uppercase tracking-[0.12em] font-bold px-1.5 py-0.5 rounded bg-black/70 text-zinc-200">
                    {a.provider}
                  </span>
                )}
                <div className="absolute bottom-0 inset-x-0 bg-linear-to-t from-black/80 to-transparent px-2 py-1">
                  <p className="text-[10px] text-zinc-200 truncate" title={a.filename}>
                    {a.filename}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Asset count + Clear all ── */}
      {/* Clear all is shown whenever there's anything to clear — assets
          queued OR an export preview lingering OR an in-flight upload
          (lets the operator bail on a stuck upload too). Styled as a
          de-emphasised text link to match the Enhance tab's "Clear all". */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-5 py-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-col">
          <span className="text-base uppercase tracking-[0.14em] text-zinc-100 font-semibold">
            Assets queued for export
          </span>
          <span className="text-sm text-zinc-300 mt-1 leading-relaxed">
            {hasAssets
              ? (
                <>
                  {enhancedAssets.length > 0 && (
                    <>{enhancedAssets.length} from Enhance/Scan</>
                  )}
                  {enhancedAssets.length > 0 && standaloneAssets.length > 0 && " + "}
                  {standaloneAssets.length > 0 && (
                    <>{standaloneAssets.length} uploaded directly</>
                  )}
                  {" — these will all be cropped and packed when you export."}
                </>
              )
              : "Nothing queued yet. Drop files above, or approve images from Scan to send them here."}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {(hasAssets || uploads.length > 0 || previewItems.length > 0) && (
            <button
              type="button"
              onClick={handleClearAll}
              className="text-sm text-zinc-300 hover:text-red-400 transition-colors font-semibold"
              title="Wipe queued assets, uploads, and previews"
            >
              Clear all
            </button>
          )}
          <span className={`text-2xl font-mono tabular-nums font-semibold ${hasAssets ? "text-yellow-300" : "text-zinc-500"}`}>
            {allAssets.length}
          </span>
        </div>
      </div>

      {/* ── Project form ── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <header className="flex items-start justify-between gap-4 px-5 py-4 bg-zinc-900/50 border-b border-zinc-800">
          <div className="flex flex-col gap-1">
            <span className="text-base font-semibold uppercase tracking-[0.14em] text-zinc-100">
              Project details
            </span>
            <span className="text-sm text-zinc-300 leading-relaxed">
              Clicking <span className="font-semibold text-white">Save Project</span> does two things:
              it locks in this metadata so the export endpoints will work, AND
              it copies the queued images into Your Photo Library so you can
              re-download them within 60 days. Only{" "}
              <span className="font-semibold text-yellow-300">Make</span> and{" "}
              <span className="font-semibold text-yellow-300">Model</span> are
              required — the rest are pre-filled from the Enhance tab when
              you came from there.
            </span>
          </div>
          {isSaved && (
            <span className="text-sm uppercase tracking-[0.18em] font-semibold text-green-400 shrink-0">
              ✓ Saved
            </span>
          )}
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-5">
          <TextField
            label="Make *"
            value={form.make}
            onChange={(v) => updateField("make", v)}
            placeholder="Toyota"
            hint="OEM brand — Toyota, Hyster, Yale, Crown, etc."
          />
          <TextField
            label="Model *"
            value={form.model}
            onChange={(v) => updateField("model", v)}
            placeholder="8FGU25"
            hint="Model number from the data plate."
          />
          <TextField
            label="Year"
            value={form.year}
            onChange={(v) => updateField("year", v.replace(/[^0-9]/g, "").slice(0, 4))}
            placeholder="defaults to current year"
            hint="Model year (1900–2100). Leave blank for current year."
          />
          <TextField
            label="Username"
            value={form.username}
            onChange={(v) => updateField("username", v)}
            placeholder="defaults to your login email"
            hint="Who's saving this — defaults to your account email."
          />
          <TextField
            label="Capacity"
            value={form.capacity}
            onChange={(v) => updateField("capacity", v)}
            placeholder="5000 lbs"
            hint="Rated load capacity from the data plate."
          />
          <TextField
            label="Tire type"
            value={form.tireType}
            onChange={(v) => updateField("tireType", v)}
            placeholder="Pneumatic / Cushion / Non-marking"
            hint="Pneumatic (outdoor), cushion (indoor), or non-marking."
          />
          <TextField
            label="Fuel type"
            value={form.fuelType}
            onChange={(v) => updateField("fuelType", v)}
            placeholder="LP / Diesel / Electric"
            hint="LP, diesel, electric, gasoline, dual-fuel."
          />
        </div>
      </section>

      {/* ── Error / warning banners ── */}
      {error && (
        <p
          className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3"
          role="alert"
        >
          {error}
        </p>
      )}
      {anyWarning && (
        <p
          className="text-sm text-amber-300 bg-amber-950/40 border border-amber-800 rounded-lg px-4 py-3"
          role="status"
        >
          Some images could not be compressed under 99 KB at acceptable quality — those tiles are flagged below. Inspect them before downloading; the ZIP still contains the lowest-quality version the encoder could produce.
        </p>
      )}

      {/* ── Save action ── */}
      <button
        onClick={handleSave}
        disabled={!canSave}
        className={`
          inline-flex py-3 px-6 rounded-lg font-semibold text-sm uppercase tracking-[0.12em] border-2 transition-all
          ${canSave
            ? isSaved
              ? "border-green-700 bg-green-700 hover:bg-green-600 text-white"
              : "border-green-500 bg-green-600 hover:bg-green-500 text-white"
            : "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"}
        `}
      >
        {isSaving
          ? "Saving project…"
          : isSaved
            ? "Re-save Project"
            : !formValid
              ? "Fill all fields to save"
              : "Save Project"}
      </button>

      {/* ── AI-disclaimer toggle ── */}
      {/* When ticked, the backend pyvips export burns the
          AI_DISCLAIMER_WATERMARK string into the bottom-right corner of
          every exported JPEG (small, semi-transparent). Off by default
          so the operator opts in deliberately — the watermark IS visible
          on the final asset and we don't want it on internal/preview
          downloads by accident. */}
      <label
        className={`flex items-start gap-3 rounded-xl border-2 px-4 py-3 cursor-pointer transition-colors select-none ${
          addAiDisclaimer
            ? "border-yellow-500 bg-yellow-950/30 hover:bg-yellow-900/30"
            : "border-zinc-700 bg-zinc-950/40 hover:border-zinc-500"
        }`}
      >
        <input
          type="checkbox"
          checked={addAiDisclaimer}
          onChange={(e) => setAddAiDisclaimer(e.target.checked)}
          className="mt-1 w-5 h-5 accent-yellow-500 shrink-0"
        />
        <div className="min-w-0">
          <p className="text-base font-bold text-zinc-100 leading-snug">
            Add AI disclaimer watermark
          </p>
          <p className="text-sm text-zinc-300 mt-1 leading-relaxed">
            Burns a tiny, semi-transparent line of text into the bottom-right
            corner of every exported JPEG:
          </p>
          <p className="text-sm text-yellow-300 italic font-mono mt-1.5 leading-snug">
            &ldquo;{AI_DISCLAIMER_WATERMARK}&rdquo;
          </p>
          <p className="text-sm text-zinc-300 mt-1.5 leading-relaxed">
            Use this when the photo is going to a customer-facing listing —
            it&apos;s your honest disclosure that the image was cleaned up by AI.
          </p>
        </div>
      </label>

      {/* ── Single PRO export button ── */}
      {/* Collage export (the purple "Collage export — 1024 long edge"
          button) used to sit beside this one in a 2-col grid. Moved
          below the Create-Branded-Collage card so the marketing-layout
          collage is the visual focal point. */}
      <button
        onClick={handleExport}
        disabled={!canExport}
        className={`
          inline-flex py-3 px-6 rounded-lg font-semibold text-sm uppercase tracking-[0.12em] border-2 transition-all
          ${canExport
            ? "border-green-500 bg-green-600 hover:bg-green-500 text-white"
            : "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"}
        `}
      >
        {isExporting
          ? "Resizing & generating previews…"
          : !isSaved
            ? "Save project first"
            : !hasAssets
              ? "No assets queued"
              : previewItems.length > 0
                ? `Re-resize ${allAssets.length} image${allAssets.length !== 1 ? "s" : ""} (PRO)`
                : `PRO export — 1024×731 (${allAssets.length})`}
      </button>

      {/* ── Create branded collage ── */}
      {/* Composes the first 5 queued images into the marketing-layout
          collage (1 hero + 4 thumb strip on the right, 1024×540, ≤99 KB
          JPEG). Equipment-type pick is required so the operator can't
          accidentally publish a collage labelled as the wrong category. */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
        <div className="space-y-1">
          <h3 className="text-base font-bold text-white uppercase tracking-[0.12em]">
            Create branded collage
          </h3>
          <p className="text-sm text-zinc-300 leading-relaxed">
            Composes your first 5 queued images into the marketing-layout
            collage — one hero shot on the left, four thumbnails stacked on
            the right. 1024 px long edge, ≤99 KB JPEG.
          </p>
        </div>

        {/* Equipment-type gate — the user must affirmatively pick what
            kind of unit this collage represents before the button is
            clickable. Defaults to nothing so the choice is deliberate.
            Two visually distinct clusters (warehouse forks vs aerial)
            with a wider gap between them so the operator's eye lands
            on the right group instantly instead of scanning all
            seven labels. */}
        <div className="space-y-2">
          <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-100">
            What kind of equipment is this?
          </span>
          {/* Toggle-card style matching the Enhance equipment picker +
              the Advanced emphasis toggles (blue selected / dark
              unselected, radio-dot). Warehouse-forks vs aerial clusters
              stay separated by the wider gap-x-6. */}
          <div className="flex flex-wrap items-stretch gap-x-6 gap-y-2">
            {EQUIPMENT_GROUPS.map((group) => (
              <div
                key={group.label ?? group.members.join("-")}
                className="flex flex-wrap gap-2"
                role="group"
                aria-label={group.label}
              >
                {group.members.map((id) => {
                  const selected = collageEquipmentType === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setCollageEquipmentType(id)}
                      aria-pressed={selected}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border-2 text-left transition-colors ${
                        selected
                          ? "bg-blue-950 border-blue-500 text-white"
                          : "bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-500"
                      }`}
                    >
                      <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${selected ? "border-blue-400" : "border-zinc-600"}`}>
                        {selected && <span className="w-2 h-2 rounded-full bg-blue-400" />}
                      </span>
                      <span className="text-sm uppercase tracking-[0.12em] font-bold">
                        {EQUIPMENT_TYPE_LABELS[id]}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={handleCreateBrandedCollage}
          disabled={
            !collageEquipmentType ||
            allAssets.length < 5 ||
            !isSaved ||
            isCreatingCollage ||
            isExporting ||
            isExportingCollage
          }
          className={`
            inline-flex py-3 px-6 rounded-lg font-bold text-base uppercase tracking-[0.12em] border-2 transition-all
            ${collageEquipmentType && allAssets.length >= 5 && isSaved && !isCreatingCollage && !isExporting && !isExportingCollage
              ? "border-green-500 bg-green-600 hover:bg-green-500 text-white"
              : "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"}
          `}
        >
          {isCreatingCollage
            ? "Composing collage…"
            : !isSaved
              ? "Save project first"
              : !collageEquipmentType
                ? "Pick equipment type to continue"
                : allAssets.length < 5
                  ? `Need 5 images (have ${allAssets.length})`
                  : collagePreviewUrl
                    ? "Re-compose collage"
                    : "Create image collage"}
        </button>
      </section>

      {/* ── Branded-collage preview + actions ── */}
      {/* Shown after a successful compose. Displays the composed JPEG
          inline so the operator can review BEFORE deciding to download
          and/or save to history. */}
      {collagePreviewUrl && collageBlob && collageFilename && (
        <section className="rounded-xl border-2 border-emerald-600 bg-emerald-950/30 p-5 space-y-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="text-lg font-bold text-emerald-100 uppercase tracking-[0.12em]">
              Collage preview
            </h3>
            <span className="text-sm font-mono text-emerald-200 tabular-nums">
              {(collageSizeBytes / 1024).toFixed(1)} KB · {collageFilename}
            </span>
          </div>

          {collageSizeWarning && (
            <p className="text-sm text-amber-300 bg-amber-950/40 border border-amber-800 rounded-lg px-3 py-2">
              ⚠ The encoder couldn&apos;t hit ≤99 KB at acceptable quality.
              This file is the closest it could get — inspect it before publishing.
            </p>
          )}

          <div className="rounded-lg overflow-hidden border border-emerald-800 bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element -- blob URL, no Next/Image needed */}
            <img
              src={collagePreviewUrl}
              alt="Composed marketing collage preview"
              className="block w-full h-auto"
            />
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleDownloadCollage}
              className="inline-flex py-3 px-5 rounded-lg font-bold text-base text-white border-2 border-blue-500 bg-blue-600 hover:bg-blue-500 transition-colors"
            >
              ⬇ Download collage
            </button>
            <button
              onClick={handleSaveCollageToHistory}
              disabled={collageSavingToHistory || collageSavedToHistory}
              className={`inline-flex py-3 px-5 rounded-lg font-bold text-base border-2 transition-colors ${
                collageSavedToHistory
                  ? "border-green-700 bg-green-700 text-white cursor-default"
                  : collageSavingToHistory
                    ? "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"
                    : "border-green-500 bg-green-600 hover:bg-green-500 text-white"
              }`}
            >
              {collageSavedToHistory
                ? "✓ Saved to Your Photo Library"
                : collageSavingToHistory
                  ? "Saving to Your Photo Library…"
                  : "💾 Save to Your Photo Library"}
            </button>
          </div>

          <button
            onClick={handleDiscardCollagePreview}
            className="text-sm font-bold uppercase tracking-[0.14em] text-zinc-300 hover:text-white transition-colors border border-zinc-700 hover:border-zinc-400 rounded px-3 py-1.5"
          >
            Discard preview
          </button>
        </section>
      )}

      {/* ── Collage export (1024 long edge, no crop, ≤99 KB) ── */}
      {/* Single-image rescale path. Different from the branded-collage
          composer above — this one takes each upstream asset as-is,
          just downsizes to fit the long edge. Sits below the branded
          collage so the marketing-layout option is the focal point. */}
      <button
        onClick={handleExportCollage}
        disabled={!canExportCollage}
        className={`
          inline-flex py-3 px-6 rounded-lg font-semibold text-sm uppercase tracking-[0.12em] border-2 transition-all
          ${canExportCollage
            ? "border-green-500 bg-green-600 hover:bg-green-500 text-white"
            : "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"}
        `}
        title="Collage preset: 1024px long edge, no crop, ≤99 KB JPEG. Use for pre-composed multi-image listing collages."
      >
        {isExportingCollage
          ? "Resizing collage(s)…"
          : !isSaved
            ? "Save project first"
            : !hasAssets
              ? "No assets queued"
              : `Collage export — 1024 long edge (${allAssets.length})`}
      </button>

      {/* ── Streaming progress ── */}
      {isExporting && (
        <section
          className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 space-y-2"
          aria-live="polite"
        >
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-[0.18em] text-zinc-300">
              {progressTotal === 0
                ? "Downloading…"
                : progressCurrent >= progressTotal && progressTotal > 0
                  ? "Bundling ZIP…"
                  : `Resizing ${progressCurrent} of ${progressTotal}`}
            </span>
            <span className="font-mono tabular-nums text-zinc-500">
              {progressTotal > 0
                ? `${Math.round((progressCurrent / progressTotal) * 100)}%`
                : "…"}
            </span>
          </div>

          {/* Progress bar */}
          <div
            className="h-2 w-full bg-zinc-900 rounded-full overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progressTotal || 100}
            aria-valuenow={progressCurrent}
          >
            <div
              className="h-full bg-blue-500 transition-all duration-300 ease-out"
              style={{
                // Before `started` event lands, show a 5% sliver so the
                // bar isn't completely empty during the captioning phase.
                width: progressTotal === 0
                  ? "5%"
                  : `${Math.round((progressCurrent / progressTotal) * 100)}%`,
              }}
            />
          </div>

          {progressFilename && (
            <p className="text-[11px] font-mono text-zinc-600 truncate" title={progressFilename}>
              {progressFilename}
            </p>
          )}
        </section>
      )}

      {/* ── Preview grid ── */}
      {previewItems.length > 0 && (
        <section className="space-y-3">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">
                Resized previews ({previewItems.length})
              </h3>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Every tile renders at its exact pixel dimensions — if a tile&apos;s aspect doesn&apos;t match the 7:5 frame, the export is wrong.
              </p>
            </div>
            {zipUrl && (
              <a
                href={zipUrl}
                download="cleanshot_pro_export.zip"
                className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-lg shadow-lg shadow-blue-900/40 transition-colors inline-flex items-center gap-2"
              >
                Download ZIP
                <span className="text-[10px] font-mono opacity-80">{formatBytes(zipSizeBytes)}</span>
              </a>
            )}
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {previewItems.map((item) => {
              const aspectOk = item.width === 1024 && item.height === 731;
              const dimensionsLabel = `${item.width}×${item.height}`;
              return (
                <figure
                  key={item.assetId}
                  className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden"
                >
                  {/*
                    No object-fit on the img — we want to render at its
                    intrinsic size so the operator can spot any wrong
                    aspect ratio coming from the backend. The wrapping div
                    has a 7:5 reference frame (with a thin border) so the
                    eye has a comparator: if the image overflows or
                    underfills the frame, the export is broken.
                  */}
                  <div
                    className="relative bg-black mx-auto"
                    style={{ aspectRatio: "1024 / 731", width: "100%" }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.url}
                      alt={`Resized: ${item.filename}`}
                      className="absolute inset-0 w-full h-full"
                      style={{ objectFit: "fill" }}
                    />
                    {/* Bottom-left: dimensions + size badge */}
                    <div className="absolute bottom-2 left-2 flex items-center gap-1">
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                          aspectOk
                            ? "bg-black/70 text-green-400"
                            : "bg-red-950/90 text-red-300 border border-red-700"
                        }`}
                        title={aspectOk ? "Dimensions match spec" : "Wrong dimensions — letterboxing or wrong aspect"}
                      >
                        {dimensionsLabel}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                          item.sizeWarning
                            ? "bg-amber-950/90 text-amber-300 border border-amber-700"
                            : "bg-black/70 text-zinc-300"
                        }`}
                        title={item.sizeWarning ? "Couldn't compress under 99 KB" : ""}
                      >
                        {formatBytes(item.sizeBytes)}
                      </span>
                    </div>
                  </div>
                  <figcaption className="flex items-center justify-between px-3 py-2 border-t border-zinc-800">
                    <span className="text-xs text-zinc-400 truncate" title={item.filename}>
                      {item.filename}
                    </span>
                    <a
                      href={item.url}
                      download={item.filename}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium shrink-0"
                    >
                      Download
                    </a>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
