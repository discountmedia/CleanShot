// =============================================================================
//  EnhanceJobCard — renders ONE enhance job (one asset, one submission).
//
//  Owns its own polling via useJob. While pending, shows progress bar.
//  When done, shows side-by-side original/result with regenerate, scan,
//  download actions. When failed, shows an alert.
//
//  Multiple cards can exist for the same asset — that's regenerate by design
//  (new attempts append rather than replace, so users can compare outputs).
// =============================================================================

import { AlertTriangle, ScanLine, RotateCcw } from 'lucide-react';

import { useJob } from '../hooks/useJob';
import { useStore } from '../lib/store';
import { ProgressBar } from './ProgressBar';

import type { UploadedAsset, EnhancementLevel } from '../lib/types';

const INTENSITY_LABELS: Record<EnhancementLevel, string> = {
  light: 'Light',
  moderate: 'Moderate',
  heavy: 'Heavy',

interface EnhanceJobCardProps {
  job_id: string;
  sourceAsset: UploadedAsset;
  intensity: EnhancementLevel;
  onRegenerate: () => void;     // re-submit this asset with current toggles
}

export function EnhanceJobCard({
  job_id,
  sourceAsset,
  intensity,
  onRegenerate,
}: EnhanceJobCardProps) {
  const job = useJob(job_id);
  const setEnhanceJob = useStore((s) => s.setEnhanceJob);
  const prefillScan = useStore((s) => s.prefillScan);

  // Mirror the latest status into the global store so the thumbnail grid's
  // status chip reflects this job. setEnhanceJob is idempotent on identical
  // payloads, but React 18+ batches state writes so this is cheap.
  if (job.job) {
    setEnhanceJob(sourceAsset.asset_id, {
      job_id,
      asset_id: sourceAsset.asset_id,
      status: job.status,
      progress: job.progress,
      message: job.message,
      result_url: job.job.download_url ?? undefined,
    });
  }

  // ===========================================================================
  // PENDING
  // ===========================================================================
  if (!job.isTerminal) {
    return (
      <div className="card">
        <div className="row between" style={{ marginBottom: 'var(--space-3)' }}>
          <div className="col" style={{ gap: 'var(--space-1)' }}>
            <span className="label">{sourceAsset.filename}</span>
            <span className="muted" style={{ fontSize: 11 }}>
              Job {job_id.slice(-8)} · {INTENSITY_LABELS[intensity]}
            </span>
          </div>
          <span className="label">{job.progress}%</span>
        </div>
        <ProgressBar percent={job.progress} variant="yellow" height={6} />
        <div className="muted" style={{ marginTop: 'var(--space-3)', fontSize: 11 }}>
          {job.message || 'Calling Gemini…'}
        </div>
      </div>
    );
  }

  // ===========================================================================
  // FAILED
  // ===========================================================================
  if (job.status === 'failed') {
    return (
      <div className="alert">
        <AlertTriangle size={20} className="alert-icon" />
        <div className="alert-content">
          <div className="alert-title">{sourceAsset.filename} — failed</div>
          <div className="alert-body">{job.message || 'Unknown error'}</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onRegenerate}>
          <RotateCcw size={12} /> Retry
        </button>
      </div>
    );
  }

  // ===========================================================================
  // DONE
  // ===========================================================================
  const downloadUrl = job.job?.download_url;
  if (!downloadUrl) {
    // Done but no URL — shouldn't happen, but render a fallback so we don't
    // silently swallow the success.
    return (
      <div className="alert alert-warning">
        <AlertTriangle size={20} className="alert-icon" />
        <div className="alert-content">
          <div className="alert-title">{sourceAsset.filename} — done, no URL</div>
          <div className="alert-body">
            Job marked complete but no download URL was returned. Try Regenerate.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="col" style={{ gap: 'var(--space-1)' }}>
          <span className="section-title">{sourceAsset.filename}</span>
          <span className="muted" style={{ fontSize: 11 }}>
            Job {job_id.slice(-8)} · {INTENSITY_LABELS[intensity]}
          </span>
        </div>
        <div className="row" style={{ gap: 'var(--space-3)' }}>
          <button className="btn btn-ghost btn-sm" onClick={onRegenerate}>
            <RotateCcw size={12} /> Regenerate
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => prefillScan(sourceAsset.asset_id)}
          >
            <ScanLine size={12} /> Scan this image
          </button>
          <a
            className="btn btn-primary btn-sm"
            href={downloadUrl}
            download={sourceAsset.filename}
          >
            Download
          </a>
        </div>
      </div>
      <div className="grid-2">
        <div className="col" style={{ gap: 'var(--space-2)' }}>
          <span className="label">Original</span>
          <img
            src={sourceAsset.preview_url}
            alt="Original"
            style={{ borderRadius: 4, width: '100%' }}
          />
        </div>
        <div className="col" style={{ gap: 'var(--space-2)' }}>
          <span className="label">Enhanced · {INTENSITY_LABELS[intensity]}</span>
          <img
            src={downloadUrl}
            alt="Enhanced"
            style={{ borderRadius: 4, width: '100%' }}
          />
        </div>
      </div>
    </div>
  );
}
