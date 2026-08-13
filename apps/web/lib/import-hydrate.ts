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
  /**
   * `handoff_id` is how a RELOADED page discovers it has an import worth
   * polling. The exchange token is stripped from the address bar immediately, so
   * the URL cannot carry it, and the handoff record outlives nothing — this
   * reverse link on the session is the only durable path back to the poller.
   */
  session?: {
    id?: string;
    handoff_id?: string | null;
  };
}

/** One photo's import status, camelCased by the BFF from IngestItemStatus. */
export interface HandoffItem {
  itemId: string;
  filename: string;
  status: "pending" | "landed" | "failed";
  assetId?: string | null;
  error?: string | null;
}

export interface HandoffStatus {
  handoffId: string;
  sessionId: string;
  total: number;
  statusCounts: Record<string, number>;
  /** No item still pending. Landed AND failed both count — this is terminal. */
  complete: boolean;
  items: HandoffItem[];
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
 * A photo that hasn't landed yet, or failed to.
 *
 * `expectedCount` seeds these before the first status response arrives so the
 * grid paints N tiles immediately instead of growing from empty. Once the poller
 * answers, the item list replaces them — which is also how a SHORTFALL is
 * handled: if crop produced fewer photos than the handoff expected, the extra
 * seeded tiles simply aren't in the item list and get reconciled away.
 */
export function placeholderRow(
  id: string,
  filename: string,
  opts?: { error?: string | null },
): UploadFile {
  return {
    id,
    origin: "import",
    filename,
    // No preview to show yet; ThumbnailCard renders the status overlay instead.
    previewUrl: "",
    status: opts?.error ? "error" : "importing",
    progress: 0,
    error: opts?.error ?? undefined,
  };
}

/** N anonymous tiles for the first paint, before any per-photo detail exists. */
export function seedPlaceholders(
  count: number,
  makeId: () => string,
): UploadFile[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) =>
    placeholderRow(makeId(), `Photo ${i + 1}`),
  );
}

/**
 * Turn the poller's item list into grid rows for everything NOT yet landed.
 *
 * Landed items are deliberately excluded: those come from the session read,
 * which is the authoritative source for what exists and is the only place a
 * signed preview URL is available. This function only covers the two states the
 * session read cannot express — still copying, and failed with a reason.
 *
 * EVERY item ends up in exactly one of the three buckets, which is what
 * guarantees no tile spins forever.
 */
export function unlandedRows(
  items: HandoffItem[],
  makeId: () => string,
): UploadFile[] {
  return items
    .filter((it) => it.status !== "landed")
    .map((it) =>
      placeholderRow(makeId(), it.filename || "Imported photo", {
        error: it.status === "failed" ? it.error || "Import failed" : null,
      }),
    );
}

/**
 * Reconcile the grid against the server's current truth.
 *
 * THE READ IS AUTHORITATIVE. Import rows are rebuilt wholesale from what the
 * server just said — landed assets from the session read, plus the poller's
 * pending/failed rows — so a re-read cannot duplicate, and a seeded placeholder
 * for a photo that never existed is reconciled away rather than left spinning.
 *
 * Upload-origin rows are untouched: the operator's own picks are theirs and the
 * server has no opinion about them.
 *
 * `unlanded` is optional so the pre-poller path (a reload with no handoff, where
 * only landed assets are knowable) keeps working unchanged.
 */
export function reconcileImports(
  current: UploadFile[],
  hydrated: UploadFile[],
  unlanded: UploadFile[] = [],
): UploadFile[] {
  const keptUploads = current.filter((f) => f.origin === "upload");
  // Preserve any preview URL we already refreshed for an asset we still hold,
  // so reconciling doesn't hand a known-expired URL back to the <img>, and keep
  // the row's id stable so React doesn't remount the tile on every poll.
  const previousByAssetId = new Map(
    current
      .filter((f) => f.origin === "import" && f.assetId)
      .map((f) => [f.assetId as string, f]),
  );
  const imports = hydrated.map((h) => {
    const prev = h.assetId ? previousByAssetId.get(h.assetId) : undefined;
    return prev ? { ...h, id: prev.id, previewUrl: prev.previewUrl } : h;
  });
  // Landed first, then the ones still in flight or failed, then the operator's
  // own uploads. Landed-first keeps finished work from jumping around as the
  // remaining tiles resolve.
  return [...imports, ...unlanded, ...keptUploads];
}
