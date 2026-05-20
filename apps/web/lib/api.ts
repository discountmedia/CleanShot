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
   * "flux" routes through Black Forest Labs FLUX 2 [PRO]. */
  provider?: "gemini" | "openai" | "flux";
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
