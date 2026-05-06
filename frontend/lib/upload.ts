/**
 * Direct-to-GCS upload helper.
 *
 * Flow (Phase 3 v3.4 / Phase 4 v4.2):
 *   1. POST /api/v1/assets/upload-url  → backend mints a V4 signed PUT URL
 *      with SignedHeaders=content-type;host
 *   2. Browser PUTs file bytes directly to GCS, sending the canonical
 *      Content-Type that the backend used when signing
 *   3. Backend's GCS Object Finalize Pub/Sub notification (Phase 4) triggers
 *      any post-upload pipeline; the frontend just needs the asset_id
 *
 * Bytes never round-trip through the API service.
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

  // 2. PUT directly to GCS via XHR (fetch has no upload-progress API).
  //    The signed URL was minted with SignedHeaders=content-type;host,
  //    so we MUST send Content-Type matching the value the backend used
  //    when signing — otherwise GCS rejects the PUT with a 403 signature
  //    mismatch. Use minted.mime_type (backend-canonical) rather than
  //    file.type directly in case the backend normalized it.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", minted.signed_put_url, true);
    xhr.setRequestHeader("Content-Type", minted.mime_type);

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
    mime_type: minted.mime_type,
    uploaded_at: new Date().toISOString(),
  };
}