// apps/web/lib/types.ts
// Canonical type definitions for CleanShot frontend.
// Matches Phase 2 v2.5 backend schema exactly.
// Drop-in ready for OpenAI and Anthropic scan providers when credentials are added.

// ─── Enums ────────────────────────────────────────────────────────────────────

export type JobStatus = "queued" | "processing" | "complete" | "failed" | "cancelled";
export type Operation = "upload" | "enhance" | "scan" | "cleanup" | "export";
export type ScanProvider = "gemini" | "openai" | "anthropic";
export type ScanVerdict = "pass" | "fail";
export type ConsensusVerdict = "pass" | "fail" | "split";

// ─── Forklift metadata (Enhance tab optional fields) ─────────────────────────

/** Equipment categories the prompt builder branches on. Pinned to the
 *  backend `EquipmentType` Literal in
 *  apps/api/src/cleanshot_api/workers/prompts.py. */
export type EquipmentType =
  | "forklift"
  | "rough_terrain"
  | "scissor_lift"
  | "telehandler"
  | "reach_truck"
  | "turret_truck"
  | "articulated_forklift"
  | "order_picker"
  | "pallet_jack"
  | "walkie_stacker";

// Display order: warehouse fork-based units first (size descending so
// the most common picks land at the start of the chip strip), then
// aerial / construction equipment grouped at the end. Operator-driven
// grouping decision 2026-05-27 — picking equipment is faster when
// related categories sit next to each other instead of interleaved.
export const EQUIPMENT_TYPES: readonly EquipmentType[] = [
  // ── Forklifts (warehouse + outdoor / rough-terrain) ──
  "forklift",
  "rough_terrain",
  "reach_truck",
  "turret_truck",
  "articulated_forklift",
  "order_picker",
  "walkie_stacker",
  "pallet_jack",
  // ── Aerial / construction ──
  "telehandler",
  "scissor_lift",
] as const;

// Structured grouping so the UI can render each cluster as its own
// segmented control with a visual gap between them. Without this the
// chip strip is just "7 buttons in a row" — the warehouse-vs-aerial
// distinction isn't legible at a glance. Driving the buttons from
// this array (instead of the flat EQUIPMENT_TYPES list) gives the
// operator an obvious "these five go together; these two go together"
// visual cue without making them read the labels.
export interface EquipmentGroup {
  /** Short label shown above the group of chips (optional — falls back to no header). */
  label?: string;
  /** Member equipment types, displayed left-to-right inside this group. */
  members: readonly EquipmentType[];
}
export const EQUIPMENT_GROUPS: readonly EquipmentGroup[] = [
  {
    label:   "Forklifts",
    members: ["forklift", "rough_terrain", "reach_truck", "turret_truck", "articulated_forklift", "order_picker", "walkie_stacker", "pallet_jack"],
  },
  {
    label:   "Aerial",
    members: ["telehandler", "scissor_lift"],
  },
] as const;

export const EQUIPMENT_TYPE_LABELS: Record<EquipmentType, string> = {
  forklift:       "Forklift",
  rough_terrain:  "Rough Terrain",
  reach_truck:    "Reach Truck",
  turret_truck:   "Turret Truck (VNA)",
  articulated_forklift: "Articulated (Bendi)",
  telehandler:    "Telehandler",
  scissor_lift:   "Scissor Lift",
  order_picker:   "Order Picker",
  pallet_jack:    "Pallet Jack",
  walkie_stacker: "Walkie Stacker",
};

export interface ForkliftMeta {
  make: string;
  model: string;
  year: string;       // string so form input stays simple; validated before send
  tireType: string;
  capacity: string;
  fuelType: string;
  /**
   * Equipment category — drives the per-type anatomy block in the
   * backend's enhance prompt. Optional; backend defaults to "forklift"
   * if omitted. Stored on the same `meta` object so the existing
   * Workspace → EnhancePanel → ResizePanel plumbing carries it for free.
   */
  equipmentType?: EquipmentType;
}

// ─── Enhance toggles ─────────────────────────────────────────────────────────
// Toggles are optional emphasis on top of the hardcoded standard treatment
// (paint refresh, decals, rust, tires, lighting) that the worker always
// applies. The 5 "core" toggles emphasize a base item; remove_people,
// remove_background_signage, and paint_forks_red_yellow_tips add new
// actions the base doesn't perform.

export interface EnhanceToggles {
  newPaintJob: boolean;
  removeRust: boolean;
  restoreDecals: boolean;
  removePeople: boolean;
  removeBackgroundSignage: boolean;
  paintForksRedYellowTips: boolean;
  shineTires: boolean;
  improveLighting: boolean;
  /**
   * When true, the backend's STANDARD TREATMENT includes a RENTAL-FLEET
   * BRANDING block that strips third-party rental decals (Sunbelt,
   * United Rentals, etc.) while preserving OEM manufacturer decals.
   * Default ON because most batches are ex-rental units.
   */
  removeRentalBranding: boolean;
  /**
   * When true, the prompt's SHOWROOM / STUDIO FLOOR block kicks in —
   * cleans tape marks, scuffs, footprints, and floor-to-backdrop seams
   * from solid-colour studio floors. No-op if the photo isn't a studio
   * shot. Off by default because applying it to outdoor / yard photos
   * would over-clean a real ground surface.
   */
  showroomFloor: boolean;
  /**
   * TOTAL BACKGROUND REMOVAL — a real transparent cutout, for the
   * new-equipment site that puts units on no backdrop at all.
   *
   * NOT a prompt fragment, unlike every other toggle here. It runs a
   * matting pass (services/cutout.py) over the FINISHED enhance output
   * and only computes an alpha channel, so the machine's pixels are
   * exactly what the operator approved. Asking an image model for a
   * transparent background instead would re-draw the machine and make
   * it guess where the mast lattice and fork gaps end — the one thing
   * this repo's findings say it gets wrong most.
   *
   * Consequences worth knowing before enabling it:
   *  - The export comes out as PNG, not JPEG (JPEG has no alpha), and
   *    carries NO disclaimer watermark — a cutout goes into a product
   *    page composite where a burnt-in caption lands on the layout.
   *  - It supersedes showroomFloor: replacing a floor that is about to
   *    be deleted is wasted work.
   */
  transparentBackground: boolean;
  /**
   * A/B ONLY — routes the matting pass through Photoroom instead of fal
   * BiRefNet. Does NOT request a cutout on its own: it picks the engine, so
   * it is a no-op unless transparentBackground is also on.
   *
   * Exists because BiRefNet is a salient-object detector (it returned a
   * potted plant and a wall banner alongside the forklift) while Photoroom is
   * trained on product photography. Which is better on mast lattice is
   * unmeasured — that is the point of the toggle.
   *
   * WARNING: Photoroom's free tier is TEN IMAGES TOTAL and nothing in this
   * app meters it. A batch of 8 with this on spends 8 of them.
   */
  cutoutPhotoroom: boolean;
  /**
   * Identity-preservation flag for 3-wheel (single-rear-pivot-wheel)
   * forklifts. When ON, the prompt asserts the unit has ONE rear wheel
   * and tells the generator not to hallucinate a second one. UI only
   * surfaces this toggle when equipmentType === "forklift" (see the
   * filter in EnhancePanel) — irrelevant for telehandlers / scissor
   * lifts / pallet jacks etc.
   */
  threeWheel: boolean;
}

/**
 * Default toggle state. Operator decision 2026-05-26: every landing
 * on the Enhance page (initial mount), every "Reset" click, and every
 * auto-reset after a terminal batch all converge here — all-off,
 * forcing the operator to explicitly opt in to every emphasis on each
 * run. Previously the defaults baked in newPaintJob / paintForksTips /
 * removeRentalBranding as "the most common asks," but those were
 * silently repeating across batches and producing unwanted edits when
 * the source photo didn't need them.
 */
export const DEFAULT_TOGGLES: EnhanceToggles = {
  newPaintJob: false,
  removeRust: false,
  restoreDecals: false,
  removePeople: false,
  removeBackgroundSignage: false,
  paintForksRedYellowTips: false,
  shineTires: false,
  improveLighting: false,
  removeRentalBranding: false,
  showroomFloor: false,
  transparentBackground: false,
  cutoutPhotoroom: false,
  threeWheel: false,
};

/**
 * The ONLY toggles rendered in the Enhance UI (2026-08-21).
 *
 * The tool is now prompt-first — the operator's typed prompt does the heavy
 * lifting, so the toggle wall was shrunk to the four that still earn their
 * space. Everything else is HIDDEN, NOT DELETED: the keys stay in
 * EnhanceToggles, in DEFAULT_TOGGLES, in TOGGLE_LABELS/DESCRIPTIONS, in the
 * panel's state, and in the backend prompt-injection path. A hidden toggle
 * simply keeps its DEFAULT_TOGGLES value (all currently false), so nothing is
 * silently forced on.
 *
 * To restore one, add its key back to this list — that is the whole change.
 */
export const VISIBLE_TOGGLES: ReadonlyArray<keyof EnhanceToggles> = [
  "removeRentalBranding",
  "showroomFloor",
  "removePeople",
  "shineTires",
  "transparentBackground",
  "cutoutPhotoroom",
] as const;

export const TOGGLE_LABELS: Record<keyof EnhanceToggles, string> = {
  newPaintJob: "New Paint Job",
  removeRust: "Remove Rust",
  restoreDecals: "Restore Decals",
  removePeople: "Remove People",
  removeBackgroundSignage: "Remove Background Signage",
  paintForksRedYellowTips: "Paint Forks Red w/ Yellow Tips",
  shineTires: "Shine Tires",
  improveLighting: "Improve Lighting",
  removeRentalBranding: "Remove Rental-Fleet Branding",
  showroomFloor: "Perfect Showroom Floor",
  transparentBackground: "Remove Background Entirely",
  cutoutPhotoroom: "— use Photoroom (A/B)",
  threeWheel: "3-Wheel",
};

export const TOGGLE_DESCRIPTIONS: Record<keyof EnhanceToggles, string> = {
  newPaintJob: "Extra emphasis on paint refresh on this image",
  removeRust: "Extra emphasis on rust / corrosion cleanup on this image",
  restoreDecals: "Extra emphasis on decal restoration on this image",
  removePeople: "Remove any people or bystanders from the frame",
  removeBackgroundSignage: "Remove exit signs, company logos, posters, and other background signage (OEM decals on the unit stay intact)",
  paintForksRedYellowTips: "Paint the forks red with yellow tips per OSHA convention; load back rest (LBR) stays black (forklifts + telehandlers)",
  shineTires: "Extra emphasis on tire dressing on this image",
  improveLighting: "Extra emphasis on exposure / lighting correction on this image",
  removeRentalBranding: "Strip third-party rental decals (Sunbelt, United Rentals, Herc, etc.) — preserves all OEM manufacturer decals + capacity plates",
  showroomFloor: "Studio / showroom shots only — replaces the floor with a perfect, shiny, middle-gray polished-concrete finish. Preserves the unit's contact shadow. No-op for outdoor / yard photos",
  transparentBackground: "Cuts the unit out completely — no floor, no walls, no sky. Exports as a transparent PNG with no watermark, for the new-equipment site. Overrides Perfect Showroom Floor",
  cutoutPhotoroom: "A/B test only — does the background removal with Photoroom instead of the default engine. Only does anything when Remove Background Entirely is also on. ⚠️ Free tier is 10 images TOTAL, and a batch of 8 spends 8 of them.",
  threeWheel: "This is a 3-wheel forklift (single rear pivot/steer wheel under the counterweight) — tells the AI to preserve the single-rear-wheel layout instead of hallucinating a second rear wheel. Forklift only.",
};

// ─── Upload ───────────────────────────────────────────────────────────────────

/**
 * "importing" is the media-auditor equivalent of compressing/uploading: the
 * bytes are being copied server-side and the grid is showing a placeholder.
 *
 * It is deliberately NOT "pending". "pending" means "the operator picked this
 * and the Enhance button should upload it" — `handleEnhanceAll` filters on it
 * and `pendingCount` drives the button label. An in-flight import that looked
 * pending would inflate that count and make the button promise work it cannot
 * do. It is also not "done", so `isEnhanceable` excludes it until the bytes
 * actually land.
 */
export type UploadStatus =
  | "pending"
  | "compressing"
  | "uploading"
  | "importing"
  | "done"
  | "error";

/**
 * Where a grid item came from.
 *
 *   "upload" — the operator picked it in the browser. Carries a real `File`
 *              and a `blob:` previewUrl.
 *   "import" — it was copied into this session server-side by the
 *              media-auditor handoff. There is NO `File` (the bytes never
 *              touched this browser) and previewUrl is a signed GCS GET URL.
 *
 * This is an EXPLICIT field rather than something inferred from
 * `file === undefined`, because three separate behaviours key off it — the
 * object-URL revoke guards, the batch auto-reset carve-out, and the hard
 * guard on the upload path — and a named predicate survives refactoring in a
 * way that an incidental undefined check does not.
 */
export type UploadOrigin = "upload" | "import";

export interface UploadFile {
  id: string;              // client-side UUID — assigned for BOTH origins (grid key + removeFile lookup)
  origin: UploadOrigin;
  /**
   * The ORIGINAL file the operator picked; preserved for the thumbnail.
   * Present ONLY when origin === "upload" — an imported asset's bytes live in
   * GCS and were never in this browser. Read `filename` instead of
   * `file.name` for anything user-visible.
   */
  file?: File;
  /** Display name. Always populated: `file.name` for uploads, the server-side object name for imports. */
  filename: string;
  /**
   * Thumbnail source.
   *   origin "upload" → `blob:` object URL (must be revoked; never expires)
   *   origin "import" → signed GCS GET URL (must NOT be revoked; expires in 1h,
   *                     refreshed once on <img> error — see ThumbnailCard)
   */
  previewUrl: string;
  status: UploadStatus;
  progress: number;        // 0–100
  error?: string;
  assetId?: string;        // populated after successful upload; present from the start on imports
  gcsUri?: string;
  compressedSize?: number; // bytes after compression (if applied)
  uploadedFilename?: string; // populated after JPEG conversion + rename; what actually hit GCS
  /**
   * Provenance for imported assets — the source unit's stock number, joined
   * through at ingest. Never set for origin === "upload". Display only.
   */
  sourceRef?: string;
}

/**
 * A grid item can be handed to the enhance queue iff it has a server-side
 * assetId.
 *
 * INVARIANT — `previewUrl` is deliberately NOT part of this test. An imported
 * asset whose signed preview URL has expired is still perfectly enhanceable,
 * because the enqueue path sends `assetId` and never touches the preview. If
 * you are about to add a previewUrl check here, you are about to make an
 * expired thumbnail block real work. Don't.
 */
export function isEnhanceable(f: UploadFile): boolean {
  return f.status === "done" && !!f.assetId;
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export interface JobRecord {
  id: string;
  sessionId: string;
  operation: Operation;
  status: JobStatus;
  inputAssetId: string;
  outputAssetId?: string;
  /** >0 while the provider call is being re-run. Drives the "Retrying" badge. */
  retryCount?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Assets ──────────────────────────────────────────────────────────────────

export interface AssetRecord {
  id: string;
  sessionId: string;
  projectId?: string;
  operation: Operation;
  gcsUri: string;
  contentHash: string;
  createdAt: string;
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

export interface AnomalyItem {
  type: string;
  location: string;
  severity: "low" | "medium" | "high";
  description: string;
}

export interface ProviderScanResult {
  provider: ScanProvider;
  verdict: ScanVerdict;
  confidence: number;      // 0.0–1.0
  anomalies: AnomalyItem[];
  summary: string;
  latencyMs: number;
  // Populated after regen attempt
  regenJobId?: string;
  regenStatus?: JobStatus;
  regenOutputAssetId?: string;
}

export interface ImageScanState {
  assetId: string;
  inputJobId: string;        // the enhance job whose output we're scanning
  filename: string;
  thumbnailUrl: string;      // signed GCS GET URL
  outputUrl?: string;        // signed GCS GET URL for enhanced version
  providerResults: ProviderScanResult[];
  consensusVerdict?: ConsensusVerdict;
  consensusConfidence?: number;
  // Per-image regen
  regenPrompt?: string;      // auto-generated from anomalies
  regenJobId?: string;
  regenStatus?: JobStatus;
}

// ─── Resize ───────────────────────────────────────────────────────────────────

export interface ResizeResult {
  assetId: string;
  filename: string;
  signedUrl: string;         // final 1024×731 JPEG ≤99 kb
  originalUrl: string;       // before resize, for comparison
}

// ─── Session ─────────────────────────────────────────────────────────────────

export interface SessionState {
  sessionId: string;
  uploadFiles: UploadFile[];
  forkliftMeta: Partial<ForkliftMeta>;
  toggles: EnhanceToggles;
  enhanceJobs: JobRecord[];
  scanStates: ImageScanState[];
  resizeResults: ResizeResult[];
}
