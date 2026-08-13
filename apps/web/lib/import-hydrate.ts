// apps/web/lib/import-hydrate.ts
// Maps server-side session assets into the Enhance grid's UploadFile shape.
//
// This is THE hydration path for imported photos, not a fallback. It runs
// identically whether the operator just arrived from media-auditor or reloaded
// an hour later: the handoff record is TTL'd, but the assets are permanently in
// the session, so the session read is the source of truth and the handoff
// poller only ever says *when* to re-read.
//
// Consequence worth stating: hydration works with NO handoff id at all. That's
// the reload-after-TTL case, and it is the reason the design reads the session
// rather than draining the poller.
//
// Deliberately free of any lib/api import — lib/api imports lib/handoff, and a
// mapper that reached back into lib/api would close a cycle. Signed URLs are
// passed in; fetching them is the caller's job.

import type { UploadFile } from "./types";

/**
 * The subset of FastAPI's AssetRecord we consume. The BFF at
 * /api/sessions/[id] forwards the payload untransformed, so these are
 * snake_case on the wire.
 */
export interface ServerAsset {
  id: string;
  session_id: string;
  operation: string;
  gcs_uri: string;
  content_hash: string;
  created_at: string;
  source_ref?: string | null;
}

export interface ServerSessionState {
  assets?: ServerAsset[];
}

/**
 * Recover the display filename from the GCS object path.
 *
 * `mint_upload_url` builds `session/{session_id}/{uuid4}/{filename}`, so the
 * basename IS the original filename — there is no separate filename column on
 * the asset row to read instead.
 */
export function filenameFromGcsUri(gcsUri: string): string {
  const base = gcsUri.split("/").pop();
  return base && base.trim() ? decodeURIComponent(base) : "imported photo";
}

/**
 * Which session assets belong in the SOURCE grid.
 *
 * Two filters, both load-bearing:
 *
 *  1. `operation === "upload"` — the session also holds enhance / modify / erase
 *     outputs. Those are variants, not sources; they must never appear in the
 *     upload grid.
 *
 *  2. `source_ref` present — restricts hydration to assets the handoff copied
 *     in. This keeps `origin: "import"` honest: an asset the operator uploaded
 *     from this browser is not an import, and resurrecting those on reload
 *     would be a behaviour change nobody asked for (today they simply don't
 *     come back). The cost is that a browser upload made inside an imported
 *     session still doesn't survive reload — accepted, and unchanged from
 *     today.
 */
export function selectImportableAssets(state: ServerSessionState): ServerAsset[] {
  return (state.assets ?? []).filter(
    (a) => a.operation === "upload" && !!a.source_ref,
  );
}

/**
 * One server asset → one grid row.
 *
 * `status: "done"` because the bytes are already in GCS: there is nothing to
 * compress and nothing to upload. That is what routes these rows down the
 * assetId enqueue path (isEnhanceable / handleReEnhance) instead of the upload
 * pipeline, which would hand convertToJpeg an undefined `file`.
 *
 * `id` is a fresh client-side uuid, exactly as a picked file gets, so grid
 * keying and the removeFile lookup behave identically for both origins.
 */
export function mapImportedAsset(
  asset: ServerAsset,
  previewUrl: string,
  id: string,
): UploadFile {
  return {
    id,
    origin: "import",
    // No `file`: these bytes never touched this browser.
    filename: filenameFromGcsUri(asset.gcs_uri),
    previewUrl,
    status: "done",
    progress: 100,
    assetId: asset.id,
    gcsUri: asset.gcs_uri,
    sourceRef: asset.source_ref ?? undefined,
  };
}

/**
 * Reconcile a freshly-read import set against what the grid currently holds.
 *
 * THE READ IS AUTHORITATIVE. Rows that came from the server are replaced
 * wholesale by what the server just said exists — so an item that ingest never
 * produced (crop yielded fewer than the handoff expected) is reconciled away
 * rather than left as a permanent skeleton, and a re-read can't duplicate rows.
 *
 * Upload-origin rows are untouched: the operator's in-flight picks are theirs,
 * and the server has no opinion about them.
 */
export function reconcileImports(
  current: UploadFile[],
  hydrated: UploadFile[],
): UploadFile[] {
  const keptUploads = current.filter((f) => f.origin === "upload");
  // Preserve any preview URL we already refreshed for an asset we still hold,
  // so reconciling doesn't hand a known-expired URL back to the <img>.
  const previousByAssetId = new Map(
    current
      .filter((f) => f.origin === "import" && f.assetId)
      .map((f) => [f.assetId as string, f]),
  );
  const imports = hydrated.map((h) => {
    const prev = h.assetId ? previousByAssetId.get(h.assetId) : undefined;
    return prev ? { ...h, id: prev.id, previewUrl: prev.previewUrl } : h;
  });
  // Imports first: they arrived before anything the operator has picked since.
  return [...imports, ...keptUploads];
}
