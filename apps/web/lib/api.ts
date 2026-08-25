// apps/web/lib/api.ts
// Typed fetch wrappers for all BFF Route Handler calls.
// The browser NEVER calls FastAPI directly — all requests go through Next.js Route Handlers.
// FASTAPI_INTERNAL_KEY is server-only and never in this file.

import { HANDOFF_EXCHANGE_TIMEOUT_MS, type HandoffExchangeResult } from "./handoff";
import type { HandoffStatus, ServerSessionState } from "./import-hydrate";
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

/**
 * Full session state — assets, jobs, scan results. The BFF forwards FastAPI's
 * payload untransformed, so the shape is snake_case (see ServerSessionState).
 *
 * This is the hydration source for imported photos in the Enhance grid, and the
 * validity probe for a resumed session id. Throws on 404 (unknown session) and
 * on the ownership 404 — callers treat both as "clear the stored id and start
 * fresh", which is the expected case for a purged session, not an error worth
 * showing anyone.
 */
export async function getSessionState(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ServerSessionState> {
  return get(`/api/sessions/${sessionId}`, signal);
}

// ─── Handoff (media-auditor import) ───────────────────────────────────────────

/**
 * Exchange a single-use handoff token for the session ingest already created.
 *
 * Deliberately does NOT throw on rejection — the caller's whole job is to
 * degrade to a normal session, so a refused import is an expected outcome, not
 * an exception. Returns a discriminated union instead. The only unbounded
 * failure mode (a hung upstream) is capped by
 * HANDOFF_EXCHANGE_TIMEOUT_MS, since the operator is behind a gate for the
 * entire call.
 *
 * The token is passed in the request body and is never logged, thrown, or
 * echoed into an error message.
 */
/**
 * Per-photo import status. Drives the progress poller.
 *
 * Throws on any non-OK so the poller can classify — it treats a 404 as terminal
 * (the handoff is gone, nothing more will ever land) and a transient error as
 * worth one more tick.
 */
export async function getHandoffStatus(
  handoffId: string,
  signal?: AbortSignal,
): Promise<HandoffStatus> {
  return get(`/api/handoff/${handoffId}`, signal);
}

export async function exchangeHandoffToken(
  token: string,
): Promise<HandoffExchangeResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HANDOFF_EXCHANGE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/handoff/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
      signal: abort.signal,
    });
    if (!res.ok) {
      // Status class only — the route collapses upstream detail to a fixed
      // string, so there is nothing more specific to learn here by design.
      return { ok: false, reason: res.status >= 500 ? "unavailable" : "rejected" };
    }
    const data = (await res.json()) as {
      sessionId: string;
      handoffId: string;
      expectedCount: number;
    };
    return {
      ok: true,
      sessionId: data.sessionId,
      handoffId: data.handoffId,
      expectedCount: data.expectedCount,
    };
  } catch {
    // Network error or our own timeout abort. Both mean "no answer", not
    // "refused" — the import itself may be perfectly fine.
    return { ok: false, reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
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
  /** Image generation provider. Default = "gemini" (gemini-3.1-flash-image-preview).
   * "openai"   routes through gpt-5 + the image_generation tool.
   * "grok"     routes through xAI Grok image-edit.
   * "kontext"  routes through BFL Flux Kontext Max via the RunComfy proxy.
   * "ideogram" routes through Ideogram 3.0 /v1/edit (typography-strong).
   * Flux 2 Max is no longer a generator — see enqueueErase() for the mask-based erase tool. */
  provider?: "gemini" | "openai" | "grok" | "kontext" | "ideogram" | "reve";
  /** Equipment category — drives the backend's per-type anatomy block.
   * Defaults to "forklift" server-side if omitted. */
  equipmentType?: "forklift" | "rough_terrain" | "scissor_lift" | "telehandler" | "reach_truck" | "turret_truck" | "articulated_forklift" | "order_picker" | "pallet_jack" | "walkie_stacker";
  /** When provided + non-empty, the worker uses this prompt verbatim and ignores toggles. */
  customPrompt?: string;
  /**
   * Which parts of the fork are in frame in THIS source photo. Per-image, not
   * per-batch — whether the tips got cropped is a property of one camera
   * angle. Omit for fully-visible, which is the pre-existing behaviour.
   */
  forkVisibility?: { verticalVisible: boolean; tipsVisible: boolean };
  /**
   * True when `customPrompt` was rebuilt from fragments and already carries the
   * fork framing. Stops the worker appending its own note on top of wording
   * that's already there.
   */
  forkFramingInPrompt?: boolean;
  idempotencyKey: string;
}): Promise<{ jobId: string }> {
  return post("/api/enhance", params);
}

// ─── Enhance: auto-pick "best of N" judge ──────────────────────────────────

export interface JudgeRanking {
  provider: string;
  assetId: string;
  verdict: "pass" | "fail";
  /** 0-100 listing-readiness. Higher is better. */
  score: number;
  reason: string;
}

export interface JudgeResult {
  winnerProvider: string;
  winnerAssetId: string;
  /** True when EVERY candidate passed the rubric. */
  allPass: boolean;
  anyPass: boolean;
  rankings: JudgeRanking[];
}

/**
 * Rank the completed enhance variants for one source image and return the
 * winner. Synchronous on the backend (a single Claude vision call), so this
 * resolves with the ranking directly rather than a job to poll.
 */
export async function judgeVariants(params: {
  sessionId: string;
  /** The original pre-enhance photo — enables differential judging. */
  originalAssetId?: string;
  candidates: Array<{ provider: string; assetId: string }>;
  equipmentType?: string;
  make?: string;
}): Promise<JudgeResult> {
  return post("/api/enhance/judge", params);
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
  /** Optional equipment context from the Scan-tab meta fields. */
  equipmentType?: string;
  make?: string;
  /**
   * Optional map of { enhanced assetId → original (pre-enhance) assetId }.
   * When present for an asset, the worker runs a differential (before/after)
   * scan against the original instead of the isolated single-image scan.
   */
  originalAssetIds?: Record<string, string>;
  /** Optional whitelist of edits the enhance step was asked to make. */
  intendedEdits?: string[];
}): Promise<{ batchId: string; jobIds: string[] }> {
  return post("/api/scan/batch", params);
}

// ─── Saved prompts ────────────────────────────────────────────────────────────

export interface SavedPrompt {
  id:        string;
  title:     string;
  body:      string;
  /** Who wrote it. Display name when they have one, else their email local-part. */
  authorName:  string;
  authorEmail: string;
  /** True when the signed-in user wrote it — drives a "yours" hint, nothing more. */
  authorIsMe:  boolean;
  /** Admin-ness, not ownership: deleting removes a template for everyone. */
  canDelete: boolean;
  /** Distinct users who have upvoted it. */
  voteCount: number;
  /** Whether the signed-in user is one of them. */
  votedByMe: boolean;
  /** Times it has been loaded into the prompt box. */
  useCount:  number;
  createdAt: string;
  updatedAt: string;
}

/** How the template list is ordered. All three sort the same fetched array. */
export type TemplateSort = "recent" | "top" | "used";

/**
 * Pull FastAPI's `detail` out of a BFF error body so the UI can show the real
 * reason ("Only an admin can delete…") instead of a JSON blob. Falls back to
 * the raw text when the body isn't the shape we expect.
 */
function detailOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === "string") {
      // The BFF wraps FastAPI's body as {detail: "<raw text>"}, so `detail`
      // is sometimes itself a JSON string carrying the real one. Unwrap once.
      try {
        const inner = JSON.parse(parsed.detail) as { detail?: unknown };
        if (typeof inner.detail === "string") return inner.detail;
      } catch {
        /* not nested — the outer detail is the message */
      }
      return parsed.detail;
    }
  } catch {
    /* not JSON */
  }
  return text;
}

/**
 * Thrown when a save collides with a title that already exists ANYWHERE in the
 * shared library. Carries a distinct type rather than a message match so the
 * caller can branch on it.
 *
 * There is no overwrite branch: titles are permanent, so the only resolution
 * is a different title. `mine` only changes the wording — "you already have
 * one called that" reads differently from "Dana does".
 */
export class PromptTitleConflictError extends Error {
  constructor(
    public readonly title: string,
    public readonly mine: boolean = true,
    detail?: string,
  ) {
    super(detail ?? `A template titled "${title}" already exists.`);
    this.name = "PromptTitleConflictError";
  }
}

export async function listSavedPrompts(signal?: AbortSignal): Promise<SavedPrompt[]> {
  return get("/api/prompts", signal);
}

/**
 * Save a new template. Always an insert — a template is written once and never
 * edited, because its votes and use count are ratings of that exact text.
 * Throws PromptTitleConflictError on 409.
 */
export async function saveSavedPrompt(params: {
  title: string;
  body: string;
}): Promise<SavedPrompt> {
  const res = await fetch("/api/prompts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    if (res.status === 409) {
      const detail = detailOf(text);
      // "You already have…" vs "<someone> already has…" — wording only.
      throw new PromptTitleConflictError(
        params.title,
        /^you already have/i.test(detail),
        detail,
      );
    }
    throw new Error(`POST /api/prompts → ${res.status}: ${detailOf(text)}`);
  }
  return (await res.json()) as SavedPrompt;
}

/** Admin-only. Removes the template, and its votes, for everyone. */
export async function deleteSavedPrompt(id: string): Promise<void> {
  const res = await fetch(`/api/prompts/${id}`, {
    method: "DELETE",
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(detailOf(text));
  }
}

/**
 * Toggle the signed-in user's upvote. Returns the authoritative count, which
 * the caller writes over its optimistic guess — two people voting at the same
 * moment means the local +1 is often not the whole story.
 */
export async function voteSavedPrompt(
  id: string,
  voted: boolean,
): Promise<{ voteCount: number; voted: boolean }> {
  const res = await fetch(`/api/prompts/${id}/vote`, {
    method: voted ? "POST" : "DELETE",
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(detailOf(text));
  }
  return (await res.json()) as { voteCount: number; voted: boolean };
}

/**
 * Count one use of a template, for the "most used" sort.
 *
 * Fire-and-forget: the insert into the prompt box has already happened
 * locally, so a failed beacon must not surface as an error for something the
 * operator would rightly consider done. Callers `void` this.
 */
export async function recordSavedPromptUse(id: string): Promise<number | null> {
  try {
    const res = await fetch(`/api/prompts/${id}/use`, {
      method: "POST",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { useCount: number };
    return data.useCount;
  } catch {
    return null;
  }
}

/** Order a fetched template list. Ties fall back to recency so the order is
 *  stable rather than whatever the sort algorithm happened to do. */
export function sortSavedPrompts(
  prompts: SavedPrompt[],
  sort: TemplateSort,
): SavedPrompt[] {
  const byRecent = (a: SavedPrompt, b: SavedPrompt) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  return [...prompts].sort((a, b) => {
    if (sort === "top")  return b.voteCount - a.voteCount || byRecent(a, b);
    if (sort === "used") return b.useCount  - a.useCount  || byRecent(a, b);
    return byRecent(a, b);
  });
}

// ─── Asset signed GET URL ─────────────────────────────────────────────────────

export async function getAssetUrl(assetId: string): Promise<{ url: string; expiresAt: string }> {
  return get(`/api/assets/${assetId}/url`);
}

// ─── Modify (darkroom: brightness / contrast / saturation, batch) ────────────

export interface ModifyAdjustments {
  /** 0..3.0 — 1.0 = neutral. Frontend slider -100..+100 maps to 0.5..1.5. */
  brightness: number;
  contrast:   number;
  saturation: number;
  /** Rotation in degrees, -15..+15. 0 = no rotation. Wedges are auto-cropped server-side. */
  rotationDeg: number;
  /** "free" = no crop; otherwise smart-crop to this aspect ratio. */
  cropAspect: "free" | "1:1" | "4:3" | "7:5" | "16:9";
  /** 0.5..1.0 — fraction of source area kept on crop. 1.0 = full source area. */
  cropZoom: number;
}

export interface ModifyBatchItem {
  assetId:  string;
  filename: string;
  url:      string;
  width:    number;
  height:   number;
}

export interface ModifyBatchResponse {
  items: ModifyBatchItem[];
}

/**
 * POST /api/modify/batch — apply the default adjustments to every
 * assetId. If `perAsset[assetId]` is set, that override REPLACES the
 * default for that specific asset (per-image mode).
 *
 * Backend pyvips renders each one, uploads as a new asset row
 * (operation=modify), and returns a preview-URL list in the same
 * order as the input.
 */
export async function applyModifyBatch(params: {
  sessionId:   string;
  assetIds:    string[];
  adjustments: ModifyAdjustments;
  perAsset?:   Record<string, ModifyAdjustments>;
}): Promise<ModifyBatchResponse> {
  return post("/api/modify/batch", params);
}

// ─── Erase (mask-based object removal — Flux or Ideogram backend) ────────────

export async function enqueueErase(params: {
  sessionId: string;
  /** Asset to erase from — typically the outputAssetId of a completed enhance variant. */
  assetId: string;
  /** Base64 PNG of the mask. White (>= 128) marks the area to erase.
   * (The server inverts this for Ideogram, which uses the opposite convention.) */
  maskPngBase64: string;
  /** Optional natural-language hint for what should fill the erased region. */
  instruction?: string;
  /** Vendor backend — "flux" (BFL flux-tools/erase-v1, default) or
   *  "ideogram" (Ideogram 3.0 inpaint — stronger on typography/decals). */
  tool?: "flux" | "ideogram";
  idempotencyKey: string;
}): Promise<{ jobId: string }> {
  return post("/api/enhance/erase", params);
}

// ─── Tweak (text-guided variant refinement — Gemini or Ideogram backend) ─────

export async function enqueueTweak(params: {
  sessionId: string;
  /** Asset to tweak — typically the outputAssetId of a completed enhance variant. */
  assetId: string;
  /** Natural-language instruction describing the targeted change. 3-600 chars. */
  instruction: string;
  /** Vendor backend — "gemini" (Flash Image, default) or "ideogram"
   *  (/v1/edit — typography-strong, better for decal restoration). */
  tool?: "gemini" | "ideogram";
  idempotencyKey: string;
}): Promise<{ jobId: string }> {
  return post("/api/enhance/tweak", params);
}

// ─── Regen (single image from Scan tab) ──────────────────────────────────────

export async function enqueueRegen(params: {
  sessionId: string;
  assetId: string;
  regenPrompt: string;
  idempotencyKey: string;
  /** Operator-selected provider for the regen pass. Backend defaults to gemini. */
  provider?: "gemini" | "openai" | "grok" | "kontext" | "ideogram" | "reve";
}): Promise<{ jobId: string }> {
  return post("/api/enhance/regen", params);
}

// ─── Save project (precondition for any /api/export/* endpoint) ─────────────

export interface SaveProjectInput {
  sessionId: string;
  title: string;
  make: string;
  /** Optional and NOT defaulted. null means "unknown", which is a real answer. */
  year: number | null;
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
  /** Meta-derived ZIP filename, e.g. "Toyota_8FGU25_2019.zip". */
  zipFilename:    string;
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
    /**
     * Asset ids of the pre-enhance ORIGINALS behind this export. Saved into
     * the project alongside the exported files so the library keeps the
     * before as well as the after. Duplicates are fine — the backend
     * de-duplicates, since several exported variants can share one source.
     *
     */
    originalAssetIds?: string[];
    /**
     * Burn the AI-disclaimer watermark into every exported JPEG. Defaults to
     * true server-side, matching the UI checkbox, so omitting it does not
     * quietly drop the disclaimer.
     */
    aiDisclaimer?: boolean;
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
            zipFilename:    (event.zip_filename as string) ?? "cleanshot_pro_export.zip",
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
