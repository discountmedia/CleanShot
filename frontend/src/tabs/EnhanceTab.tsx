// =============================================================================
//  EnhanceTab — image enhancement with brand rule toggles.
//
//  Flow:
//    1. Upload images via dropzone
//    2. Pick intensity (light / moderate / heavy), brand rules, extra notes
//    3. Click "Enhance selected" → POST /enhance per asset, returns job_id
//    4. useJob polls each job until done
//    5. Result: side-by-side viewer + "Scan this image" link to Scan tab
// =============================================================================

import { useState } from 'react';
import { AlertTriangle, ScanLine, Sparkles, RotateCcw } from 'lucide-react';

import { useStore } from '../lib/store';
import { useUpload } from '../hooks/useUpload';
import { useJob } from '../hooks/useJob';
import { api, ApiError } from '../lib/api';

import { Dropzone } from '../components/Dropzone';
import { ImageThumbnail } from '../components/ImageThumbnail';
import { ProgressBar } from '../components/ProgressBar';
import { Toggle } from '../components/Toggle';

import type { EnhancementLevel, EnhanceJobLocal } from '../lib/types';

const INTENSITY_LABELS: Record<EnhancementLevel, string> = {
  light: 'Light',
  moderate: 'Moderate',
  heavy: 'Heavy',
};

export function EnhanceTab() {
  const session_id = useStore((s) => s.session_id);
  const assets = useStore((s) => s.assets);
  const selection = useStore((s) => s.enhance_selection);
  const toggleSelection = useStore((s) => s.toggleEnhanceSelection);
  const enhanceJobs = useStore((s) => s.enhance_jobs);
  const setEnhanceJob = useStore((s) => s.setEnhanceJob);
  const prefillScan = useStore((s) => s.prefillScan);

  const { upload, isUploading, uploadError } = useUpload();

  // Per-tab controls
  const [intensity, setIntensity] = useState<EnhancementLevel>('moderate');
  const [forkPaint, setForkPaint] = useState(true);
  const [tireShine, setTireShine] = useState(true);
  const [rustRemoval, setRustRemoval] = useState(true);
  const [extras, setExtras] = useState('');

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

    // Submit all selected assets in parallel; track the first job for the
    // active progress display. Future iteration: per-asset job tracking.
    try {
      const responses = await Promise.all(
        selection.map((asset_id) =>
          api.postEnhance({
            session_id,
            asset_id,
            enhancement_level: intensity,
            apply_fork_paint: forkPaint,
            apply_tire_shine: tireShine,
            apply_rust_removal: rustRemoval,
            extra_instructions: extras.trim() || undefined,
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
        setEnhanceJob(selection[i], localJob);
      });

      if (responses.length > 0) setActiveJobId(responses[0].job_id);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.detail : String(err));
    }
  };

  const renderResultPanel = () => {
    if (!job.job || job.status !== 'done') return null;
    const completedAssetId = job.job.asset_id_in;
    const sourceAsset = completedAssetId ? assets[completedAssetId] : null;
    const downloadUrl = job.job.download_url;
    if (!sourceAsset || !downloadUrl) return null;

    return (
      <div className="card">
        <div className="row between" style={{ marginBottom: 'var(--space-4)' }}>
          <span className="section-title">Result</span>
          <div className="row" style={{ gap: 'var(--space-3)' }}>
            <button className="btn btn-ghost btn-sm" onClick={handleSubmit}>
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
            <img src={sourceAsset.preview_url} alt="Original" style={{ borderRadius: 4 }} />
          </div>
          <div className="col" style={{ gap: 'var(--space-2)' }}>
            <span className="label">Enhanced · {INTENSITY_LABELS[intensity]}</span>
            <img src={downloadUrl} alt="Enhanced" style={{ borderRadius: 4 }} />
          </div>
        </div>
      </div>
    );
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
              onClick={handleSubmit}
              disabled={selection.length === 0 || job.status === 'running'}
            >
              <Sparkles size={14} /> Enhance {selection.length || ''}
            </button>
          </div>
        </div>
      )}

      {/* ---- Active job progress ---- */}
      {job.job && !job.isTerminal && (
        <div className="card">
          <div className="row between" style={{ marginBottom: 'var(--space-3)' }}>
            <span className="label">Processing</span>
            <span className="label">{job.progress}%</span>
          </div>
          <ProgressBar percent={job.progress} variant="yellow" height={6} />
          <div className="muted" style={{ marginTop: 'var(--space-3)', fontSize: 11 }}>
            {job.message || 'Calling Gemini…'}
          </div>
        </div>
      )}

      {/* ---- Result ---- */}
      {renderResultPanel()}

      {job.job?.status === 'failed' && (
        <div className="alert">
          <AlertTriangle size={20} className="alert-icon" />
          <div className="alert-content">
            <div className="alert-title">Enhance failed</div>
            <div className="alert-body">{job.message}</div>
          </div>
        </div>
      )}
    </div>
  );
}
