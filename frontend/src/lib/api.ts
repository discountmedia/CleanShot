// =============================================================================
//  API client — typed fetch wrappers for the v2.4 backend
//
//  Reads VITE_API_URL and VITE_API_KEY at build time.
//
//  VITE_API_URL handling is idempotent:
//    - In dev with vite.config proxying /api → localhost:8000, leave it
//      unset (or empty) and the relative '/api/v1' will route through Vite's
//      dev server.
//    - In production, set it to either the bare host
//      (https://forklift-api-xxxx-uc.a.run.app) or with the prefix already
//      appended — both resolve to the same final URL.
// =============================================================================

import type {
  SessionResponse,
  UploadUrlResponse,
  EnhanceRequest,
  EnhanceResponse,
  ResizeRequest,
  ResizeResponse,
  JobStatusResponse,
  ScanResult,
} from './types';

// Strip trailing slash, then strip trailing /api/v1 if someone already added
// it, then append /api/v1. Idempotent: works whether the env var includes
// the prefix or not, with or without a trailing slash.
const RAW = import.meta.env.VITE_API_URL ?? '';
const API_URL = RAW.replace(/\/$/, '').replace(/\/api\/v1$/, '') + '/api/v1';

const API_KEY = import.meta.env.VITE_API_KEY ?? '';

export class ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`API ${status}: ${detail}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Generic fetch wrapper. Adds X-Api-Key, JSON content-type, and unwraps
 * non-2xx responses into thrown ApiErrors with the server message attached.
 *
 * Reads the response body exactly once as text, then tries to parse JSON
 * on the way out. Avoids the "body stream already read" pitfall when the
 * server returns non-JSON error pages.
 */
async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(API_KEY ? { 'X-Api-Key': API_KEY } : {}),
    ...(init.headers ?? {}),
  };

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch (err) {
    // Network-layer failure (CORS, DNS, offline, etc.)
    throw new ApiError(0, `Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Read the body once, regardless of status
  const bodyText = await response.text();

  if (!response.ok) {
    let detail = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      detail = parsed.detail ?? bodyText;
    } catch {
      // body was not JSON — keep the raw text as detail
    }
    throw new ApiError(response.status, detail || response.statusText);
  }

  // 204 No Content
  if (response.status === 204 || bodyText.length === 0) {
    return undefined as T;
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new ApiError(response.status, `Server returned non-JSON response: ${bodyText.slice(0, 200)}`);
  }
}

// =============================================================================
//  Endpoint wrappers
// =============================================================================

export const api = {
  createSession(): Promise<SessionResponse> {
    return apiFetch<SessionResponse>('/sessions', { method: 'POST' });
  },

  requestUploadUrl(session_id: string, mime_type: string): Promise<UploadUrlResponse> {
    return apiFetch<UploadUrlResponse>('/assets/upload-url', {
      method: 'POST',
      body: JSON.stringify({ session_id, mime_type }),
    });
  },

  /**
   * Direct PUT to GCS via signed URL. Bytes never touch the API service.
   * Returns the upload Response so callers can inspect status if needed.
   */
  async putToGCS(signedUrl: string, file: File): Promise<void> {
    let response: Response;
    try {
      response = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
    } catch (err) {
      throw new ApiError(0, `GCS upload network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(
        response.status,
        `GCS upload failed: ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`,
      );
    }
  },

  postEnhance(request: EnhanceRequest): Promise<EnhanceResponse> {
    return apiFetch<EnhanceResponse>('/enhance', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  postResize(request: ResizeRequest): Promise<ResizeResponse> {
    return apiFetch<ResizeResponse>('/resize', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  getJob(job_id: string): Promise<JobStatusResponse> {
    return apiFetch<JobStatusResponse>(`/jobs/${job_id}`, { method: 'GET' });
  },

  /**
   * Synchronous scan. Returns the full merged result inline; typical wall-
   * clock 6-25s. The frontend should show a "Calling Gemini + OpenAI +
   * Anthropic" pending state while awaiting this.
   */
  postScan(session_id: string, asset_id: string): Promise<ScanResult> {
    return apiFetch<ScanResult>('/scan', {
      method: 'POST',
      body: JSON.stringify({ session_id, asset_id }),
    });
  },
};