/**
 * Shared types for the CleanShot frontend.
 *
 * These mirror the Phase 2 v2.4.1 backend schema. In Phase 4 these should
 * be replaced by codegen from the FastAPI OpenAPI schema (see
 * packages/api-types/ in the monorepo). For now they're hand-maintained;
 * any drift between this file and the backend response shape is a bug.
 */

// ---------- Sessions & Assets ----------

export type Session = {
  session_id: string;
};

export type UploadUrlResponse = {
  asset_id: string;
  upload_url: string;        // V4 signed PUT URL
  upload_headers: Record<string, string>;  // headers the browser must send
  expires_in_seconds: number;
};

export type AssetPreviewResponse = {
  preview_url: string;       // signed GET URL, ~15min TTL
  expires_in_seconds: number;
};

// ---------- Enhance ----------

export type EnhanceIntensity = "light" | "moderate" | "heavy";

export type EnhanceBrandToggles = {
  apply_fork_paint: boolean;     // forks red with yellow tips
  apply_tire_shine: boolean;     // shiny tires (skipped on cushion units)
  apply_rust_removal: boolean;   // remove rust/corrosion/scratches
};

export type EnhanceResolution = "1K" | "2K" | "4K";

export type EnhanceRequest = {
  session_id: string;
  asset_id: string;
  intensity: EnhanceIntensity;
  brand: EnhanceBrandToggles;
  extra_instructions?: string;
  resolution?: EnhanceResolution;  // defaults to '1K' on the backend
};

// Result-of-enhance, surfaced in the job hash under result_uri/model_used
export type EnhanceModelUsed = "pro" | "flash-2.5";

// ---------- Scan (triple-provider voting) ----------

export type ScanVerdict = "PASS" | "REVIEW" | "FAIL";
export type ScanAgreement = "full" | "majority" | "split";
export type ScanCheckStatus = "ok" | "warn" | "bad" | "skip";

export type ScanCheck = {
  status: ScanCheckStatus;
  note: string;
};

export type ScanCheckKey =
  | "limb_count"
  | "finger_detail"
  | "face_anatomy"
  | "forklift_forks"
  | "forklift_mast"
  | "operator_seat"
  | "wheel_count"
  | "duplicate_objects"
  | "text_legibility"
  | "lighting_shadows"
  | "background_coherence"
  | "proportions";

export type ScanResult = {
  verdict: ScanVerdict;
  confidence: number;             // 0-100
  agreement: ScanAgreement;
  summary: string;
  issues: string[];
  checks: Record<ScanCheckKey, ScanCheck>;
  source: string;                 // "triple" | "dual_<a>_<b>" | "<provider>_only"
  warnings?: string[];
  individual?: {
    gemini?: unknown;
    openai?: unknown;
    anthropic?: unknown;
  };
};

export type ScanRequest = {
  session_id: string;
  asset_id: string;
};

// ---------- Resize ----------

export type ResizePreset =
  | "marketplace_1024"
  | "marketplace_1200"
  | "hero_1920_1080"
  | "square_1080";

export type ResizeFormat = "webp" | "jpeg" | "avif";

export type ResizeRequest = {
  session_id: string;
  asset_id: string;
  preset?: ResizePreset;
  width?: number;
  height?: number;
  format: ResizeFormat;
  quality?: number;               // 1-100, defaults backend-side
};

// ---------- Jobs ----------

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type JobOperation = "enhance" | "scan" | "resize";

/**
 * Job hash as returned by GET /api/v1/jobs/{id}.
 *
 * Polymorphic on `operation`:
 *  - enhance jobs carry result_uri (gs:// path) and model_used
 *  - scan jobs carry scan_result (parsed ScanResult)
 *  - resize jobs carry result_uri only
 *
 * The frontend reads whichever field is present for the job type.
 */
export type Job = {
  job_id: string;
  operation: JobOperation;
  status: JobStatus;
  progress: number;               // 0-100
  message: string;
  asset_id_in: string;
  created_at: string;             // ISO 8601
  updated_at: string;
  // operation-specific:
  result_uri?: string;            // enhance, resize
  model_used?: EnhanceModelUsed;  // enhance only
  scan_result?: ScanResult;       // scan only
  error?: string;
};

// ---------- API errors ----------

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
