// =============================================================================
//  API client — typed fetch wrappers for the v2.4 backend
//
//  Reads VITE_API_URL and VITE_API_KEY at build time. In dev with vite.config
//  proxying to localhost:8000, VITE_API_URL can be relative ("/api/v1"); in
//  production set it to the full Cloud Run URL.
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

const API_URL = import.meta.env.VITE_API_URL ?? '/api/v1';
const API_KEY = import.meta.env.VITE_API_KEY ?? '';

/**
 * Generic fetch wrapper. Adds X-Api-Key, JSON content-type, and unwraps
 * non-2xx responses into thrown Errors with the server message attached.
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

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.detail ?? JSON.stringify(body);
    } catch {
      detail = await response.text();
    }
    throw new ApiError(response.status, detail || response.statusText);
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

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
    const response = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!response.ok) {
      throw new ApiError(response.status, `GCS upload failed: ${response.statusText}`);
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
