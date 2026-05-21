// apps/web/lib/api.ts
// Typed fetch wrappers for all BFF Route Handler calls.
// The browser NEVER calls FastAPI directly — all requests go through Next.js Route Handlers.
// FASTAPI_INTERNAL_KEY is server-only and never in this file.

import type {
  EnhanceToggles,
  ForkliftMeta,
  JobRecord,
} from "./types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { cache: "no-store", signal });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`GET ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(): Promise<{ sessionId: string }> {
  return post("/api/sessions", {});
}

// ─── Upload ───────────────────────────────────────────────────────────────────

export interface SignedUploadUrlResponse {
  uploadUrl: string;
  assetId: string;
  gcsUri: string;
}

export async function getSignedUploadUrl(params: {
  sessionId: string;
  filename: string;
  contentType: string;
}): Promise<SignedUploadUrlResponse> {
  return post("/api/upload/signed-url", params);
}

/** PUT the file bytes directly to GCS using the V4 signed URL. */
export async function uploadToGcs(
  signedUrl: string,
  file: File,
  onProgress?: (pct: number) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`GCS PUT ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("GCS PUT network error"));
    xhr.send(file);
  });
}

// ─── Enhance ─────────────────────────────────────────────────────────────────

export async function enqueueEnhance(params: {
  sessionId: string;
  assetId: string;
  toggles: EnhanceToggles;
  forkliftMeta?: Partial<ForkliftMeta>;
  /** Image generation provider. Default = "gemini" (gemini-2.5-flash-image).
   * "openai" routes through gpt-image-2-2026-04-21.
   * "flux"   routes through Black Forest Labs FLUX 2 MAX.
   * "grok"   routes through xAI Grok image-edit. */
  provider?: "gemini" | "openai" | "flux" | "grok";
  /** Equipment category — drives the backend's per-type anatomy block.
   * Defaults to "forklift" server-side if omitted. */
  equipmentType?: "forklift" | "scissor_lift" | "telehandler";
  /** When provided + non-empty, the worker uses this prompt verbatim and ignores toggles. */
  customPrompt?: string;
  idempotencyKey: string;
}): Promise<{ jobId: string }> {
  return post("/api/enhance", params);
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export async function pollJob(jobId: string, signal?: AbortSignal): Promise<JobRecord> {
  return get(`/api/jobs/${jobId}`, signal);
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

export async function enqueueScanBatch(params: {
  sessionId: string;
  assetIds: string[];
  idempotencyKey: string;
}): Promise<{ batchId: string; jobIds: string[] }> {
  return post("/api/scan/batch", params);
}

// ─── Asset signed GET URL ─────────────────────────────────────────────────────

export async function getAssetUrl(assetId: string): Promise<{ url: string; expiresAt: string }> {
  return get(`/api/assets/${assetId}/url`);
}

// ─── Regen (single image from Scan tab) ──────────────────────────────────────

export async function enqueueRegen(params: {
  sessionId: string;
  assetId: string;
  regenPrompt: string;
  idempotencyKey: string;
  /** Operator-selected provider for the regen pass. Backend defaults to gemini. */
  provider?: "gemini" | "openai" | "flux" | "grok";
}): Promise<{ jobId: string }> {
  return post("/api/enhance/regen", params);
}

// ─── Save project (precondition for any /api/export/* endpoint) ─────────────

export interface SaveProjectInput {
  sessionId: string;
  title: string;
  make: string;
  year: number;
  model: string;
  tireType: string;
  capacity: string;
  fuelType: string;
  username: string;
  photoType: "auction" | "studio";
}

export async function saveProject(input: SaveProjectInput): Promise<{ projectId: string }> {
  return post("/api/projects/save", input);
}

// ─── Approvals (commit a curated set to the user's History) ──────────────────

export interface ApproveSetInput {
  sessionId: string;
  assetIds: string[];
  projectMeta: { make: string; model: string; year: string };
}

/**
 * POST /api/approvals — copies each asset to gs://…/approved/{email}/{dir}/
 * and creates an approval_set row keyed by the signed-in user's email
 * (resolved server-side from the Better Auth session). Result rows show up
 * on the History tab.
 *
 * In the current Resize flow this is called immediately after a successful
 * Save Project so a single click commits both the project metadata AND the
 * curated image set. There is no separate "Approve All" action.
 */
export async function approveSet(
  input: ApproveSetInput,
): Promise<{ approvalSetId: string }> {
  return post("/api/approvals", input);
}

// ─── Export (PRO preset: 1024×731 7:5 JPEG ≤99 KB) ───────────────────────────

export interface ExportProResult {
  blob: Blob;
  /** Filename parsed from Content-Disposition. ZIP for batches, JPEG for single. */
  filename: string;
  /** Set by FastAPI when the ≤100 KB target was unachievable on at least one image. */
  warning: string | null;
}

/**
 * POST /api/export/pro → returns the binary response as a Blob so the caller
 * can trigger a browser download. Throws on non-2xx with the response body
 * text as the error message (so save-project 403s surface cleanly).
 */
export async function exportProAsBlob(params: {
  sessionId: string;
  assetIds: string[];
}): Promise<ExportProResult> {
  const res = await fetch("/api/export/pro", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`POST /api/export/pro → ${res.status}: ${text}`);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? "cleanshot_pro_export.zip";
  const warning = res.headers.get("x-warning");
  const blob = await res.blob();
  return { blob, filename, warning };
}

// ─── Export (COLLAGE preset: 1024 long edge, no crop, JPEG ≤99 KB) ──────────

export interface ExportCollageResult {
  blob: Blob;
  /** Filename parsed from Content-Disposition. ZIP for batches, JPEG for single. */
  filename: string;
  /** Set by FastAPI when the ≤99 KB target was unachievable on at least one image. */
  warning: string | null;
}

/**
 * POST /api/export/collage → returns the binary response as a Blob so the
 * caller can trigger a browser download. Used for pre-composed multi-image
 * listing collages where the layout has already been decided upstream and
 * the operator just needs a marketing-target-sized JPEG under the listing-
 * site upload cap.
 *
 * Same shape as exportProAsBlob — the only difference is the server-side
 * resize semantics (fit-to-long-edge instead of 7:5 cover-crop).
 */
export async function exportCollageAsBlob(params: {
  sessionId: string;
  assetIds: string[];
  providers?: (string | null)[];
}): Promise<ExportCollageResult> {
  const res = await fetch("/api/export/collage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`POST /api/export/collage → ${res.status}: ${text}`);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? "cleanshot_collage_export.zip";
  const warning = res.headers.get("x-warning");
  const blob = await res.blob();
  return { blob, filename, warning };
}

// ─── Export (PRO preview: per-image signed URLs + ZIP signed URL) ───────────

export interface ExportProPreviewItem {
  assetId:     string;
  filename:    string;
  /** V4 signed GET URL to the 1024×731 JPEG in GCS. ~1-hour expiry. */
  url:         string;
  width:       number;
  height:      number;
  sizeBytes:   number;
  /** True when ≤100 kb couldn't be achieved after 10 quality iterations. */
  sizeWarning: boolean;
}

export interface ExportProPreviewResponse {
  items:          ExportProPreviewItem[];
  /** V4 signed GET URL to the bundled ZIP in GCS — drop straight into <a href>. */
  zipUrl:         string;
  zipSizeBytes:   number;
  /** Convenience flag: true if any item has sizeWarning=true. */
  anySizeWarning: boolean;
}

export interface ExportProPreviewProgress {
  current: number;
  total: number;
  filename: string;
}

export interface ExportProPreviewCallbacks {
  /** Fired once, before any progress events. Tells the UI the batch size. */
  onStarted?: (total: number) => void;
  /** Fired after each image is written to GCS — `current` is 1-indexed. */
  onProgress?: (p: ExportProPreviewProgress) => void;
  /** Fired exactly once on success with the final result. */
  onResult: (result: ExportProPreviewResponse) => void;
}

/**
 * POST /api/export/pro/preview — streams NDJSON progress events. Backend
 * captions + resizes + uploads in parallel where possible; the helper
 * here parses each NDJSON line and dispatches to the appropriate
 * callback so the UI can render a real progress bar.
 *
 * Throws if the response is non-OK OR if the stream emits an `error`
 * event before the `result` event. Callers should wrap in try/catch.
 */
export async function exportProPreviewStream(
  params: {
    sessionId: string;
    assetIds: string[];
    /**
     * Parallel list to `assetIds` — each entry is the AI provider that
     * produced the matching output asset, or null when unknown. The
     * backend uses it to suffix each ZIP filename with the model name
     * so the operator can distinguish duplicate variants of the same
     * source image (Gemini vs OpenAI vs Flux vs Grok).
     */
    providers?: (string | null)[];
  },
  callbacks: ExportProPreviewCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/export/pro/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`POST /api/export/pro/preview → ${res.status}: ${text}`);
  }
  if (!res.body) {
    throw new Error("export stream: no response body");
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let resultReceived = false;

  // Read until the stream closes. The backend emits one final event
  // (`result` or `error`) and then closes the stream.
  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += value;

    let nlIdx;
    while ((nlIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line) continue;

      let event: { event: string; [k: string]: unknown };
      try {
        event = JSON.parse(line);
      } catch (err) {
        console.error("[exportProPreviewStream] bad NDJSON line", line, err);
        continue;
      }

      switch (event.event) {
        case "started":
          callbacks.onStarted?.(event.total as number);
          break;
        case "progress":
          callbacks.onProgress?.({
            current:  event.current as number,
            total:    event.total as number,
            filename: event.filename as string,
          });
          break;
        case "result": {
          const items = (event.items as Array<Record<string, unknown>>).map((it) => ({
            assetId:     it.asset_id as string,
            filename:    it.filename as string,
            url:         it.url as string,
            width:       it.width as number,
            height:      it.height as number,
            sizeBytes:   it.size_bytes as number,
            sizeWarning: it.size_warning as boolean,
          }));
          callbacks.onResult({
            items,
            zipUrl:         event.zip_url as string,
            zipSizeBytes:   event.zip_size_bytes as number,
            anySizeWarning: event.any_size_warning as boolean,
          });
          resultReceived = true;
          break;
        }
        case "error":
          throw new Error(event.message as string ?? "export stream error");
        default:
          // Unknown event type — log but don't fail the run.
          console.warn("[exportProPreviewStream] unknown event type", event);
      }
    }

    if (done) break;
  }

  if (!resultReceived) {
    throw new Error("export stream closed without a result event");
  }
}

/** Programmatically trigger a browser download for a Blob. */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari etc. can still resolve the URL through the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
