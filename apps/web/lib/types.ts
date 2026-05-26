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

/** Equipment categories the prompt builder branches on. */
export type EquipmentType = "forklift" | "scissor_lift" | "telehandler";

export const EQUIPMENT_TYPES: readonly EquipmentType[] = [
  "forklift",
  "scissor_lift",
  "telehandler",
] as const;

export const EQUIPMENT_TYPE_LABELS: Record<EquipmentType, string> = {
  forklift:     "Forklift",
  scissor_lift: "Scissor lift",
  telehandler:  "Telehandler",
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

export const DEFAULT_TOGGLES: EnhanceToggles = {
  newPaintJob: true,             // default ON — the single most common ask
  removeRust: false,
  restoreDecals: false,
  removePeople: false,
  removeBackgroundSignage: false,
  paintForksRedYellowTips: true, // default ON — Discount Forklift signature treatment
  shineTires: false,
  improveLighting: false,
  removeRentalBranding: true,    // default ON — most batches are ex-rental units
  showroomFloor: false,          // off — operator opts in for actual studio shots
};

/**
 * All-off toggle set. Auto-applied after a batch reaches a fully terminal
 * state so the next run starts clean — the operator opts back into each
 * emphasis explicitly rather than accidentally repeating last batch's
 * settings. Distinct from DEFAULT_TOGGLES (which the manual "Reset"
 * button restores).
 */
export const ALL_OFF_TOGGLES: EnhanceToggles = {
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
  showroomFloor: "Studio / showroom shots only — cleans tape marks, scuffs, footprints, and floor-to-backdrop seams from solid-colour studio floors. No-op for outdoor / yard photos",
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
