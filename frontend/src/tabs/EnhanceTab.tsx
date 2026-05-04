// =============================================================================
//  EnhanceTab — image enhancement with brand rule toggles.
//
//  v2 (per-asset progress):
//    - Submit fires N parallel POST /enhance, one per selected asset
//    - Each submission gets its own EnhanceJobCard with independent polling
//    - Regenerate appends a new card (so users can compare attempts)
//    - Thumbnails reflect the latest job's status per asset
// =============================================================================

import { useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';

import { useStore } from '../lib/store';
import { useUpload } from '../hooks/useUpload';
import { api, ApiError } from '../lib/api';

import { Dropzone } from '../components/Dropzone';
import { ImageThumbnail } from '../components/ImageThumbnail';
import { Toggle } from '../components/Toggle';
import { EnhanceJobCard } from '../components/EnhanceJobCard';

import type { EnhancementLevel, EnhanceJobLocal } from '../lib/types';

const INTENSITY_LABELS: Record<EnhancementLevel, string> = {
  light: 'Light',
  moderate: 'Moderate',
  heavy: 'Heavy',
};

interface SubmittedJob {
  job_id: string;
  asset_id: string;
  intensity: EnhancementLevel;
  submitted_at: number;   // for sorting newest-first
}

export function EnhanceTab() {
  const session_id = useStore((s) => s.session_id);
  const assets = useStore((s) => s.assets);
  const selection = useStore((s) => s.enhance_selection);
  const toggleSelection = useStore((s) => s.toggleEnhanceSelection);
  const enhanceJobs = useStore((s) => s.enhance_jobs);
  const setEnhanceJob = useStore((s) => s.setEnhanceJob);

  const { upload, isUploading, uploadError } = useUpload();

  // Per-tab controls
  const [intensity, setIntensity] = useState<EnhancementLevel>('moderate');
  const [forkPaint, setForkPaint] = useState(true);
  const [tireShine, setTireShine] = useState(true);
  const [rustRemoval, setRustRemoval] = useState(true);
  const [extras, setExtras] = useState('');

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedJobs, setSubmittedJobs] = useState<SubmittedJob[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleFiles = async (files: File[]) => {
    setSubmitError(null);
    const ids = await upload(files);
    ids.forEach((id) => toggleSelection(id));
  };

  /** Submit a single asset for enhance. Used by both batch submit and regenerate. */
  const submitOne = async (asset_id: string): Promise<SubmittedJob | null> => {
    if (!session_id) return null;
    try {
      const response = await api.postEnhance({
        session_id,
        asset_id,
        enhancement_level: intensity,
        apply_fork_paint: forkPaint,
        apply_tire_shine: tireShine,
        apply_rust_removal: rustRemoval,
        extra_instructions: extras.trim() || undefined,
      });
      const localJob: EnhanceJobLocal = {
        job_id: response.job_id,
        asset_id,
        status: 'queued',
        progress: 0,
      };
      setEnhanceJob(asset_id, localJob);
      return {
        job_id: response.job_id,
        asset_id,
        intensity,
        submitted_at: Date.now(),
      };
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail : String(err);
      setSubmitError(`${asset_id}: ${msg}`);
      return null;
    }
  };

  const handleSubmitBatch = async () => {
    if (!session_id || selection.length === 0) return;
    setSubmitError(null);
    setIsSubmitting(true);

    try {
      const results = await Promise.all(selection.map((id) => submitOne(id)));
      const newJobs = results.filter((j): j is SubmittedJob => j !== null);

      // Append new jobs, dedupe by job_id (idempotent backend may return
      // a job_id that's already in our list when toggle settings unchanged)
      setSubmittedJobs((prev) => {
        const existing = new Set(prev.map((j) => j.job_id));
        const filtered = newJobs.filter((j) => !existing.has(j.job_id));
        // Newest first
        return [...filtered, ...prev];
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegenerate = async (asset_id: string) => {
    setIsSubmitting(true);
    try {
      const result = await submitOne(asset_id);
      if (result) {
        setSubmittedJobs((prev) => {
          if (prev.some((j) => j.job_id === result.job_id)) return prev;
          return [result, ...prev];
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // ===========================================================================

  return (
    <div className="col" style={{ gap: 'var(--space-6)' }}>
      <div className="section-header">
        <span className="section-title">Enhance</span>
        <span className="section-meta">
          Gemini 2.5 Flash Image · brand rule toggles · per-photo extras
        </span>
      </div>

      {/* ---- Upload + grid ---- */}
      {Object.keys(assets).length === 0 ? (
        <Dropzone
          onFiles={handleFiles}
          primaryText="Drop forklift photos to enhance"
          secondaryText="Drag-and-drop, or click to browse. JPEG, PNG, or WebP. Up to 50 files."
          disabled={isUploading}
        />
      ) : (
        <>
          <div className="row between">
            <span className="label">{Object.keys(assets).length} image(s) uploaded</span>
            <Dropzone onFiles={handleFiles} primaryText="+ Add more" disabled={isUploading} />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 'var(--space-3)',
            }}
          >
            {Object.values(assets).map((asset) => {
              const localJob = enhanceJobs[asset.asset_id];
              const status = localJob
                ? {
                    label:
                      localJob.status === 'done'
                        ? 'Done'
                        : localJob.status === 'failed'
                        ? 'Failed'
                        : `${localJob.progress}%`,
                    color:
                      localJob.status === 'done'
                        ? ('green' as const)
                        : localJob.status === 'failed'
                        ? ('red' as const)
                        : ('yellow' as const),
                  }
                : undefined;
              return (
                <ImageThumbnail
                  key={asset.asset_id}
                  asset={asset}
                  selected={selection.includes(asset.asset_id)}
                  onClick={() => toggleSelection(asset.asset_id)}
                  status={status}
                />
              );
            })}
          </div>
        </>
      )}

      {(uploadError || submitError) && (
        <div className="alert">
          <AlertTriangle size={20} className="alert-icon" />
          <div className="alert-content">
            <div className="alert-title">{uploadError ? 'Upload failed' : 'Enhance failed'}</div>
            <div className="alert-body">{uploadError ?? submitError}</div>
          </div>
        </div>
      )}

      {/* ---- Controls ---- */}
      {Object.keys(assets).length > 0 && (
        <div className="card col" style={{ gap: 'var(--space-5)' }}>
          {/* Intensity */}
          <div className="col" style={{ gap: 'var(--space-2)' }}>
            <span className="label">Intensity</span>
            <div className="pill-group" style={{ alignSelf: 'flex-start' }}>
              {(Object.keys(INTENSITY_LABELS) as EnhancementLevel[]).map((level) => (
                <button
                  key={level}
                  className={intensity === level ? 'active' : ''}
                  onClick={() => setIntensity(level)}
                >
                  {INTENSITY_LABELS[level]}
                </button>
              ))}
            </div>
          </div>

          {/* Brand rule toggles */}
          <div className="col" style={{ gap: 'var(--space-2)' }}>
            <span className="label">Brand styling rules</span>
            <div className="row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <Toggle
                label="Red forks · yellow tips"
                description="Repaint forks red with bright yellow tips. Disable if unit shouldn't be repainted."
                checked={forkPaint}
                onChange={setForkPaint}
              />
              <Toggle
                label="Shiny tires"
                description="Wet/shiny tire dressing. Auto-skips cushion or non-marking tires."
                checked={tireShine}
                onChange={setTireShine}
              />
              <Toggle
                label="Rust removal"
                description="Clean up rust and minor scratches. Realism guardrail keeps it honest."
                checked={rustRemoval}
                onChange={setRustRemoval}
              />
            </div>
          </div>

          {/* Extras */}
          <div className="col" style={{ gap: 'var(--space-2)' }}>
            <span className="label">
              Extra instructions (optional, max 1000 characters)
            </span>
            <textarea
              className="textarea"
              value={extras}
              onChange={(e) => setExtras(e.target.value.slice(0, 1000))}
              placeholder='Any specific notes for this photo? (e.g. "keep the dent on the back-rest")'
            />
            <span className="muted" style={{ fontSize: 11, alignSelf: 'flex-end' }}>
              {extras.length} / 1000
            </span>
          </div>

          <div className="row between">
            <span className="muted" style={{ fontSize: 12 }}>
              {selection.length === 0
                ? 'Select one or more images to enhance'
                : `${selection.length} image${selection.length === 1 ? '' : 's'} selected`}
            </span>
            <button
              className="btn btn-primary btn-lg"
              onClick={handleSubmitBatch}
              disabled={selection.length === 0 || isSubmitting}
            >
              <Sparkles size={14} />
              {isSubmitting ? 'Submitting…' : `Enhance ${selection.length || ''}`}
            </button>
          </div>
        </div>
      )}

      {/* ---- Job cards (one per submission, newest first) ---- */}
      {submittedJobs.length > 0 && (
        <div className="col" style={{ gap: 'var(--space-4)' }}>
          <div className="row between">
            <span className="section-title">
              Results · {submittedJobs.length} job{submittedJobs.length === 1 ? '' : 's'}
            </span>
          </div>
          {submittedJobs.map((job) => {
            const sourceAsset = assets[job.asset_id];
            if (!sourceAsset) return null;
            return (
              <EnhanceJobCard
                key={job.job_id}
                job_id={job.job_id}
                sourceAsset={sourceAsset}
                intensity={job.intensity}
                onRegenerate={() => handleRegenerate(job.asset_id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
