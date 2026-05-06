/**
 * Direct-to-GCS upload helper.
 *
 * Flow (Phase 3 v3.4 / Phase 4 v4.2):
 *   1. POST /api/v1/assets/upload-url  → backend mints a V4 signed PUT URL
 *   2. Browser PUTs file bytes directly to GCS
 *   3. Backend's GCS Object Finalize Pub/Sub notification (Phase 4) triggers
 *      any post-upload pipeline; the frontend just needs the asset_id.
 *
 * Bytes never round-trip through the API service. Large forklift photos
 * (often 8–25 MB raw) would otherwise blow Cloud Run memory at concurrency.
 */

"use client";

import { requestUploadUrl } from "./api";
import type { AssetRecord } from "./store";

export type UploadProgress = {
  loaded: number;
  total: number;
};

export type UploadResult = AssetRecord;

export async function uploadFile(args: {
  session_id: string;
  file: File;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<UploadResult> {
  const { session_id, file, onProgress, signal } = args;

  // 1. Mint a signed URL
  const minted = await requestUploadUrl({
    session_id,
    filename: file.name,
    mime_type: file.type || "application/octet-stream",
  });

  // 2. PUT directly to GCS. We use XHR rather than fetch() because fetch
  //    has no upload-progress API in browsers as of 2026; XHR's upload
  //    .onprogress is the only portable way to drive a progress bar.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", minted.upload_url, true);
    for (const [k, v] of Object.entries(minted.upload_headers ?? {})) {
      xhr.setRequestHeader(k, v);
    }

    xhr.upload.onprogress = (ev) => {
      if (onProgress && ev.lengthComputable) {
        onProgress({ loaded: ev.loaded, total: ev.total });
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`gcs_upload_failed_${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("gcs_upload_network_error"));
    xhr.onabort = () => reject(new Error("gcs_upload_aborted"));

    if (signal) {
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(file);
  });

  return {
    asset_id: minted.asset_id,
    filename: file.name,
    mime_type: file.type || "application/octet-stream",
    uploaded_at: new Date().toISOString(),
  };
}
