// =============================================================================
//  Shared types — frontend mirror of the v2.4 backend response shapes
// =============================================================================

// ---- Session & assets ----

export interface SessionResponse {
  session_id: string;
}

export interface UploadUrlResponse {
  asset_id: string;
  signed_put_url: string;
  expires_at: string;
}

// ---- Enhance ----

export type EnhancementLevel = 'light' | 'moderate' | 'heavy';

export interface EnhanceRequest {
  session_id: string;
  asset_id: string;
  enhancement_level: EnhancementLevel;
  apply_fork_paint?: boolean;
  apply_tire_shine?: boolean;
  apply_rust_removal?: boolean;
  extra_instructions?: string;
}

export interface EnhanceResponse {
  job_id: string;
  status: string;
}

// ---- Resize ----

export interface ResizeRequest {
  session_id: string;
  asset_id: string;
  width?: number;
  height?: number;
  preset?: string;
  format: 'jpeg' | 'png' | 'webp';
  quality?: number;
}

export interface ResizeResponse {
  job_id: string;
  status: string;
}

// ---- Job polling (Enhance + Resize) ----

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'unknown';

export interface JobStatusResponse {
  job_id: string;
  status: JobStatus;
  progress: number;
  message?: string;
  operation?: string;
  asset_id_in?: string;
  result_uri?: string;
  download_url?: string;
  scan_result?: ScanResult | null;  // present only for legacy queued scans
}

// ---- Scan (synchronous) ----

export type Verdict = 'PASS' | 'REVIEW' | 'FAIL';
export type CheckStatus = 'ok' | 'warn' | 'bad' | 'skip';
export type Agreement = 'full' | 'majority' | 'split';
export type ProviderName = 'gemini' | 'openai' | 'anthropic';

export interface CheckResult {
  status: CheckStatus;
  note: string;
}

export const CHECK_CATEGORIES = [
  'limb_count',
  'finger_detail',
  'face_anatomy',
  'forklift_forks',
  'forklift_mast',
  'operator_seat',
  'wheel_count',
  'duplicate_objects',
  'text_legibility',
  'lighting_shadows',
  'background_coherence',
  'proportions',
] as const;

export type CheckCategory = (typeof CHECK_CATEGORIES)[number];

export interface IndividualProviderResult {
  verdict?: Verdict;
  confidence?: number;
  summary?: string;
  issues?: string[];
  checks?: Record<CheckCategory, CheckResult>;
  error?: string;
}

export interface ScanResult {
  verdict: Verdict;
  confidence: number;
  agreement: Agreement;
  summary: string;
  issues: string[];
  checks: Record<CheckCategory, CheckResult>;
  source: string;       // "triple" | "dual_X_Y" | "X_only"
  individual: Partial<Record<ProviderName, IndividualProviderResult>>;
  warnings: string[];
  elapsed_seconds: number;
}

// ---- Front-end-local types ----

export interface UploadedAsset {
  asset_id: string;
  session_id: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  preview_url: string;   // browser-side URL.createObjectURL
  uploaded: boolean;
  upload_error?: string;
}

export interface EnhanceJobLocal {
  job_id: string;
  asset_id: string;
  status: JobStatus;
  progress: number;
  message?: string;
  result_url?: string;
}

export interface ScanJobLocal {
  asset_id: string;
  pending: boolean;
  result?: ScanResult;
  error?: string;
}

// Friendly display names for the 12 categories
export const CHECK_LABELS: Record<CheckCategory, string> = {
  limb_count: 'Limb Count',
  finger_detail: 'Finger Detail',
  face_anatomy: 'Face Anatomy',
  forklift_forks: 'Forks',
  forklift_mast: 'Mast',
  operator_seat: 'Operator Seat',
  wheel_count: 'Wheel Count',
  duplicate_objects: 'Duplicates',
  text_legibility: 'Text Legibility',
  lighting_shadows: 'Lighting / Shadows',
  background_coherence: 'Background',
  proportions: 'Proportions',
};
