// Shared TypeScript types — CleanShot
// These are consumed by apps/web via @cleanshot/types path alias

export type JobStatus = 'queued' | 'processing' | 'complete' | 'failed'

export interface JobRecord {
  id: string
  session_id: string
  status: JobStatus
  created_at: string
  updated_at: string
  result_url?: string
  error?: string
}

export interface SessionState {
  session_id: string
  created_at: string
  jobs: JobRecord[]
  project?: ProjectRecord
}

export interface ProjectRecord {
  id: string
  session_id: string
  name: string
  saved_at: string
}

export interface EnhanceRequest {
  session_id: string
  asset_id: string
  toggles: EnhanceToggles
}

export interface EnhanceToggles {
  paint_upgrade: boolean
  rust_removal: boolean
  decal_restoration: boolean
  remove_people: boolean
  hide_third_party_branding: boolean
  paint_forks_red_yellow: boolean
  shiny_wet_tires: boolean
  clean_grey_floor: boolean
  studio_background: boolean
  general_improvements: boolean
}

export interface ScanResult {
  asset_id: string
  verdict: 'pass' | 'warn' | 'fail'
  confidence: number
  anomalies: string[]
}

export interface QueueStatus {
  depth: number
  position: number
  eta_seconds: number
}
