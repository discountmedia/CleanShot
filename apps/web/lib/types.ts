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
  | "scissor_lift"
  | "telehandler"
  | "reach_truck"
  | "order_picker"
  | "pallet_jack"
  | "walkie_stacker";

// Display order: warehouse fork-based units first (size descending so
// the most common picks land at the start of the chip strip), then
// aerial / construction equipment grouped at the end. Operator-driven
// grouping decision 2026-05-27 — picking equipment is faster when
// related categories sit next to each other instead of interleaved.
export const EQUIPMENT_TYPES: readonly EquipmentType[] = [
  // ── Warehouse fork lifts (size descending) ──
  "forklift",
  "reach_truck",
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
    label:   "Warehouse forks",
    members: ["forklift", "reach_truck", "order_picker", "walkie_stacker", "pallet_jack"],
  },
  {
    label:   "Aerial",
    members: ["telehandler", "scissor_lift"],
  },
] as const;

export const EQUIPMENT_TYPE_LABELS: Record<EquipmentType, string> = {
  forklift:       "Forklift",
  reach_truck:    "Reach Truck",
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
};

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
};

// ─── Upload ───────────────────────────────────────────────────────────────────

export type UploadStatus = "pending" | "compressing" | "uploading" | "done" | "error";

export interface UploadFile {
  id: string;              // client-side UUID
  file: File;              // the ORIGINAL file the user picked; preserved for thumbnail
  previewUrl: string;      // object URL for thumbnail (original)
  status: UploadStatus;
  progress: number;        // 0–100
  error?: string;
  assetId?: string;        // populated after successful upload
  gcsUri?: string;
  compressedSize?: number; // bytes after compression (if applied)
  uploadedFilename?: string; // populated after JPEG conversion + rename; what actually hit GCS
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export interface JobRecord {
  id: string;
  sessionId: string;
  operation: Operation;
  status: JobStatus;
  inputAssetId: string;
  outputAssetId?: string;
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
