/**
 * CleanShot API client.
 *
 * All calls go through the same fetch wrapper, which:
 *   - prepends NEXT_PUBLIC_API_URL
 *   - injects the X-Api-Key header
 *   - throws ApiError on non-2xx responses
 *
 * This file is consumed only by 'use client' components. Server Components
 * should NOT call this directly — they have no API key context. If you find
 * yourself wanting to fetch from a Server Component, the right answer is
 * either (a) move the fetch into a 'use client' child, or (b) introduce a
 * route handler under app/api/ that proxies server-side (Phase 3.5 upgrade).
 */

import type {
  ApiError as _ApiErrorType,
  AssetPreviewResponse,
  EnhanceRequest,
  Job,
  ResizeRequest,
  ScanRequest,
  Session,
  UploadUrlResponse,
} from "./types";
import { ApiError } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL;
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

if (!API_URL || !API_KEY) {
  // Surfaced at build time on Vercel; fail loudly rather than ship a bundle
  // pointing at undefined.
  // eslint-disable-next-line no-console
  console.warn(
    "[api] Missing NEXT_PUBLIC_API_URL or NEXT_PUBLIC_API_KEY. " +
      "Set both in .env.local or Vercel environment variables.",
  );
}

type FetchOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
};

async function call<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = opts;
  const url = `${API_URL ?? ""}${path}`;

  const headers: Record<string, string> = {
    "X-Api-Key": API_KEY ?? "",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
    // No credentials — auth is via X-Api-Key, not cookies.
    credentials: "omit",
  });

  if (!res.ok) {
    let code = "http_error";
    let message = res.statusText;
    try {
      const data = (await res.json()) as { code?: string; message?: string };
      if (data.code) code = data.code;
      if (data.message) message = data.message;
    } catch {
      // body wasn't JSON; keep statusText
    }
    throw new ApiError(res.status, code, message);
  }

  // Some endpoints (rare) return 204; guard against empty body
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------- session ----------

export function createSession(): Promise<Session> {
  return call<Session>("/api/v1/sessions", { method: "POST", body: {} });
}

// ---------- assets ----------

export function requestUploadUrl(args: {
  session_id: string;
  filename: string;
  mime_type: string;
}): Promise<UploadUrlResponse> {
  return call<UploadUrlResponse>("/api/v1/assets/upload-url", {
    method: "POST",
    body: args,
  });
}

export function getAssetPreviewUrl(asset_id: string): Promise<AssetPreviewResponse> {
  return call<AssetPreviewResponse>(`/api/v1/assets/${asset_id}/preview-url`);
}

// ---------- jobs ----------

export function getJob(job_id: string, signal?: AbortSignal): Promise<Job> {
  return call<Job>(`/api/v1/jobs/${job_id}`, { signal });
}

// ---------- enhance ----------

export function enqueueEnhance(req: EnhanceRequest): Promise<{ job_id: string }> {
  return call<{ job_id: string }>("/api/v1/enhance", { method: "POST", body: req });
}

// ---------- scan ----------

export function enqueueScan(req: ScanRequest): Promise<{ job_id: string }> {
  return call<{ job_id: string }>("/api/v1/scan", { method: "POST", body: req });
}

// ---------- resize ----------

export function enqueueResize(req: ResizeRequest): Promise<{ job_id: string }> {
  return call<{ job_id: string }>("/api/v1/resize", { method: "POST", body: req });
}

// ---------- batch download (server-streamed ZIP) ----------

export async function downloadZip(args: {
  session_id: string;
  asset_ids: string[];
}): Promise<Blob> {
  const url = `${API_URL}/api/v1/download/zip`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Api-Key": API_KEY ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    credentials: "omit",
  });
  if (!res.ok) {
    throw new ApiError(res.status, "zip_failed", res.statusText);
  }
  return res.blob();
}
