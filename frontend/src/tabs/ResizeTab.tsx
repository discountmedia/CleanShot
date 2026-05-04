// =============================================================================
//  ResizeTab — preset and custom resize controls.
//
//  Flow:
//    1. Upload images via dropzone
//    2. Pick preset OR custom W×H, format, quality
//    3. Click Resize → POST /resize per asset, useJob polls until done
//    4. Result: download links per asset
// =============================================================================

import { useState } from 'react';
import { AlertTriangle, Maximize2 } from 'lucide-react';

import { useStore } from '../lib/store';
import { useUpload } from '../hooks/useUpload';
import { useJob } from '../hooks/useJob';
import { api, ApiError } from '../lib/api';

import { Dropzone } from '../components/Dropzone';
import { ImageThumbnail } from '../components/ImageThumbnail';
import { ProgressBar } from '../components/ProgressBar';

import type { EnhanceJobLocal } from '../lib/types';

type Format = 'jpeg' | 'png' | 'webp';

interface Preset {
  id: string;
  label: string;
  width: number;
  height: number;
  description?: string;
}

const PRESETS: Preset[] = [
  { id: 'square_1080', label: 'Square 1080', width: 1080, height: 1080, description: 'Instagram feed' },
  { id: 'portrait_1080', label: 'Portrait 1080', width: 1080, height: 1350, description: 'Instagram portrait' },
  { id: 'landscape_1200', label: 'Landscape 1200', width: 1200, height: 630, description: 'Facebook / OG' },
  { id: 'wide_1920', label: 'Wide 1920', width: 1920, height: 1080, description: 'Web hero' },
  { id: 'thumb_400', label: 'Thumb 400', width: 400, height: 300, description: 'Listing preview' },
];

export function ResizeTab() {
  const session_id = useStore((s) => s.session_id);
  const assets = useStore((s) => s.assets);
  const selection = useStore((s) => s.resize_selection);
  const toggleSelection = useStore((s) => s.toggleResizeSelection);
  const resizeJobs = useStore((s) => s.resize_jobs);
  const setResizeJob = useStore((s) => s.setResizeJob);

  const { upload, isUploading, uploadError } = useUpload();

  const [preset, setPreset] = useState<string | null>('square_1080');
  const [customWidth, setCustomWidth] = useState<string>('');
  const [customHeight, setCustomHeight] = useState<string>('');
  const [format, setFormat] = useState<Format>('jpeg');
  const [quality, setQuality] = useState<number>(85);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const job = useJob(activeJobId);

  const handleFiles = async (files: File[]) => {
    setSubmitError(null);
    const ids = await upload(files);
    ids.forEach((id) => toggleSelection(id));
  };

  const handleSubmit = async () => {
    if (!session_id || selection.length === 0) return;
    setSubmitError(null);

    const dims = preset
      ? PRESETS.find((p) => p.id === preset)!
      : {
          width: parseInt(customWidth, 10) || 0,
          height: parseInt(customHeight, 10) || 0,
        };

    if (!dims.width || !dims.height) {
      setSubmitError('Specify a preset or both width and height.');
      return;
    }

    try {
      const responses = await Promise.all(
        selection.map((asset_id) =>
          api.postResize({
            session_id,
            asset_id,
            width: dims.width,
            height: dims.height,
            format,
            quality,
          }),
        ),
      );

      responses.forEach((r, i) => {
        const localJob: EnhanceJobLocal = {
          job_id: r.job_id,
          asset_id: selection[i],
          status: 'queued',
          progress: 0,
        };
        setResizeJob(selection[i], localJob);
      });

      if (responses.length > 0) setActiveJobId(responses[0].job_id);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.detail : String(err));
    }
  };

  // ===========================================================================

  return (
    <div className="col" style={{ gap: 'var(--space-6)' }}>
      <div className="section-header">
        <span className="section-title">Resize</span>
        <span className="section-meta">
          libvips · presets or custom · JPEG / PNG / WebP
        </span>
      </div>

      {Object.keys(assets).length === 0 ? (
        <Dropzone
          onFiles={handleFiles}
          primaryText="Drop images to resize"
          secondaryText="Multi-file. Original aspect preserved unless preset specifies."
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
              const localJob = resizeJobs[asset.asset_id];
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
            <div className="alert-title">Error</div>
            <div className="alert-body">{uploadError ?? submitError}</div>
          </div>
        </div>
      )}

      {/* ---- Controls ---- */}
      {Object.keys(assets).length > 0 && (
        <div className="card col" style={{ gap: 'var(--space-5)' }}>
          <div className="col" style={{ gap: 'var(--space-2)' }}>
            <span className="label">Preset</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={`btn btn-sm ${preset === p.id ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => {
                    setPreset(p.id);
                    setCustomWidth('');
                    setCustomHeight('');
                  }}
                  title={p.description}
                >
                  {p.label}
                </button>
              ))}
              <button
                className={`btn btn-sm ${preset === null ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setPreset(null)}
              >
                Custom
              </button>
            </div>
          </div>

          {preset === null && (
            <div className="row" style={{ gap: 'var(--space-3)' }}>
              <div className="col" style={{ gap: 'var(--space-1)', flex: 1 }}>
                <span className="label">Width (px)</span>
                <input
                  className="input"
                  type="number"
                  value={customWidth}
                  onChange={(e) => setCustomWidth(e.target.value)}
                  placeholder="1080"
                />
              </div>
              <div className="col" style={{ gap: 'var(--space-1)', flex: 1 }}>
                <span className="label">Height (px)</span>
                <input
                  className="input"
                  type="number"
                  value={customHeight}
                  onChange={(e) => setCustomHeight(e.target.value)}
                  placeholder="1080"
                />
              </div>
            </div>
          )}

          <div className="row" style={{ gap: 'var(--space-5)' }}>
            <div className="col" style={{ gap: 'var(--space-2)' }}>
              <span className="label">Format</span>
              <div className="pill-group">
                {(['jpeg', 'png', 'webp'] as Format[]).map((f) => (
                  <button
                    key={f}
                    className={format === f ? 'active' : ''}
                    onClick={() => setFormat(f)}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {format !== 'png' && (
              <div className="col" style={{ gap: 'var(--space-2)', flex: 1 }}>
                <span className="label">Quality · {quality}%</span>
                <input
                  type="range"
                  min={50}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(parseInt(e.target.value, 10))}
                  style={{ accentColor: 'var(--brand-red)' }}
                />
              </div>
            )}
          </div>

          <div className="row between">
            <span className="muted" style={{ fontSize: 12 }}>
              {selection.length === 0
                ? 'Select images to resize'
                : `${selection.length} image${selection.length === 1 ? '' : 's'} selected`}
            </span>
            <button
              className="btn btn-primary btn-lg"
              onClick={handleSubmit}
              disabled={selection.length === 0 || job.status === 'running'}
            >
              <Maximize2 size={14} /> Resize {selection.length || ''}
            </button>
          </div>
        </div>
      )}

      {/* ---- Job progress + result ---- */}
      {job.job && !job.isTerminal && (
        <div className="card">
          <div className="row between" style={{ marginBottom: 'var(--space-3)' }}>
            <span className="label">Resizing</span>
            <span className="label">{job.progress}%</span>
          </div>
          <ProgressBar percent={job.progress} variant="yellow" height={6} />
          <div className="muted" style={{ marginTop: 'var(--space-3)', fontSize: 11 }}>
            {job.message}
          </div>
        </div>
      )}

      {job.job?.status === 'done' && job.job.download_url && (
        <div className="card">
          <div className="row between">
            <span className="section-title">Resize complete</span>
            <a className="btn btn-primary btn-sm" href={job.job.download_url} download>
              Download
            </a>
          </div>
        </div>
      )}

      {job.job?.status === 'failed' && (
        <div className="alert">
          <AlertTriangle size={20} className="alert-icon" />
          <div className="alert-content">
            <div className="alert-title">Resize failed</div>
            <div className="alert-body">{job.message}</div>
          </div>
        </div>
      )}
    </div>
  );
}
