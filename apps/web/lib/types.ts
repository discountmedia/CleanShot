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

export interface ForkliftMeta {
  make: string;
  model: string;
  year: string;       // string so form input stays simple; validated before send
  tireType: string;
  capacity: string;
  fuelType: string;
}

// ─── Enhance toggles (7 toggles per spec) ────────────────────────────────────

export interface EnhanceToggles {
  newPaintJob: boolean;
  removeRust: boolean;
  restoreDecals: boolean;
  removePeople: boolean;
  paintForksRedYellowTips: boolean;
  shineTires: boolean;
  improveLighting: boolean;
}

export const DEFAULT_TOGGLES: EnhanceToggles = {
  newPaintJob: false,
  removeRust: false,
  restoreDecals: false,
  removePeople: false,
  paintForksRedYellowTips: false,
  shineTires: false,
  improveLighting: false,
};

export const TOGGLE_LABELS: Record<keyof EnhanceToggles, string> = {
  newPaintJob: "New Paint Job",
  removeRust: "Remove Rust",
  restoreDecals: "Restore Decals",
  removePeople: "Remove People",
  paintForksRedYellowTips: "Paint Forks Red w/ Yellow Tips",
  shineTires: "Shine Tires",
  improveLighting: "Improve Lighting",
};

export const TOGGLE_DESCRIPTIONS: Record<keyof EnhanceToggles, string> = {
  newPaintJob: "Repaint the forklift body in its original factory colour, clean and uniform",
  removeRust: "Remove rust, corrosion, and oxidation from all surfaces",
  restoreDecals: "Restore faded or missing OEM decals, brand logos, and capacity labels",
  removePeople: "Remove any people or bystanders from the image",
  paintForksRedYellowTips: "Paint the forks red with yellow safety tips per OSHA convention",
  shineTires: "Make tires appear clean, black, and recently conditioned",
  improveLighting: "Correct exposure, reduce shadows, and balance white point for studio quality",
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
