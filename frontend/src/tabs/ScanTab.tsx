// =============================================================================
//  ScanTab — Triple-provider artifact detection display.
//
//  Architecture (synchronous):
//    1. User uploads image (or arrives via "Scan this image" prefill from Enhance)
//    2. User clicks Scan → useScan.runScan() awaits POST /scan
//    3. While pending, "Calling Gemini + OpenAI + Anthropic (10-25s)" indicator
//    4. Result lands → display verdict banner + agreement bar + provider row +
//       12-check grid. Click any check to expand all 3 providers' notes.
//    5. Warning banner if any provider failed (degraded mode)
// =============================================================================

import { useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw, AlertOctagon } from 'lucide-react';

import { useStore } from '../lib/store';
import { useUpload } from '../hooks/useUpload';
import { useScan } from '../hooks/useScan';

import { Dropzone } from '../components/Dropzone';
import { ImageThumbnail } from '../components/ImageThumbnail';
import { ProgressBar } from '../components/ProgressBar';
import { StatusBadge, TrafficLight } from '../components/StatusBadge';

import {
  CHECK_CATEGORIES,
  CHECK_LABELS,
  type CheckCategory,
  type ProviderName,
  type ScanResult,
} from '../lib/types';

const PROVIDERS: ProviderName[] = ['gemini', 'openai', 'anthropic'];
const PROVIDER_DISPLAY: Record<ProviderName, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

export function ScanTab() {
  const assets = useStore((s) => s.assets);
  const selection = useStore((s) => s.scan_selection);
  const toggleSelection = useStore((s) => s.toggleScanSelection);
  const prefillId = useStore((s) => s.scan_prefill_asset_id);
  const clearPrefill = useStore((s) => s.clearScanPrefill);

  const { upload, isUploading, uploadError } = useUpload();
  const { runScan, pending, result, error, reset } = useScan();

  const [expandedCheck, setExpandedCheck] = useState<CheckCategory | null>(null);

  // Handle "Scan this image" prefill from Enhance tab
  useEffect(() => {
    if (prefillId && assets[prefillId]) {
      // Selection is already set via prefillScan(); auto-run if uploaded
      if (assets[prefillId].uploaded) {
        runScan(prefillId);
      }
      clearPrefill();
    }
  }, [prefillId, assets, runScan, clearPrefill]);

  const selectedAsset = selection.length === 1 ? assets[selection[0]] : null;

  const handleFiles = async (files: File[]) => {
    const ids = await upload(files);
    if (ids.length > 0) {
      // Auto-select the first uploaded image; user can still pick a different one
      ids.forEach((id) => toggleSelection(id));
    }
  };

  const handleScan = () => {
    if (!selectedAsset) return;
    setExpandedCheck(null);
    runScan(selectedAsset.asset_id);
  };

  const handleReset = () => {
    setExpandedCheck(null);
    reset();
  };

  // ===========================================================================
  // RENDER
  // ===========================================================================

  return (
    <div className="col" style={{ gap: 'var(--space-6)' }}>
      <div className="section-header">
        <span className="section-title">Scan</span>
        <span className="section-meta">
          Triple-provider artifact detection · Detection only — does not modify images
        </span>
      </div>

      {/* ---- Empty state: dropzone ---- */}
      {Object.keys(assets).length === 0 && (
        <Dropzone
          onFiles={handleFiles}
          primaryText="Drop images to scan"
          secondaryText="Three providers (Gemini, OpenAI, Anthropic) vote on every image. Detection only — Scan does not modify images."
          disabled={isUploading}
        />
      )}

      {uploadError && (
        <div className="alert">
          <AlertTriangle size={20} className="alert-icon" />
          <div className="alert-content">
            <div className="alert-title">Upload failed</div>
            <div className="alert-body">{uploadError}</div>
          </div>
        </div>
      )}

      {/* ---- Asset grid + scan controls ---- */}
      {Object.keys(assets).length > 0 && (
        <div className="col" style={{ gap: 'var(--space-4)' }}>
          <div className="row between">
            <span className="label">{Object.keys(assets).length} image(s) uploaded</span>
            <div className="row" style={{ gap: 'var(--space-3)' }}>
              <Dropzone
                onFiles={handleFiles}
                primaryText="+ Add more"
                disabled={isUploading || pending}
              />
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 'var(--space-3)',
            }}
          >
            {Object.values(assets).map((asset) => (
              <ImageThumbnail
                key={asset.asset_id}
                asset={asset}
                selected={selection.includes(asset.asset_id)}
                onClick={() => !pending && toggleSelection(asset.asset_id)}
              />
            ))}
          </div>

          <div className="row between" style={{ marginTop: 'var(--space-3)' }}>
            <span className="label">
              {selection.length === 0
                ? 'Select an image to scan'
                : selection.length === 1
                ? 'Ready to scan'
                : 'Select exactly one image to scan'}
            </span>
            <button
              className="btn btn-primary btn-lg"
              onClick={handleScan}
              disabled={selection.length !== 1 || pending || !selectedAsset?.uploaded}
            >
              {pending ? 'Scanning…' : 'Run scan'}
            </button>
          </div>
        </div>
      )}

      {/* ---- Pending indicator ---- */}
      {pending && (
        <div className="card">
          <div className="row between" style={{ marginBottom: 'var(--space-3)' }}>
            <span className="label">Calling Gemini + OpenAI + Anthropic</span>
            <span className="label">10-25s</span>
          </div>
          <ProgressBar percent={45} variant="yellow" height={6} />
          <div className="muted" style={{ marginTop: 'var(--space-3)', fontSize: 11 }}>
            All three providers run in parallel. Wall-clock = max(provider latencies).
          </div>
        </div>
      )}

      {/* ---- Error state ---- */}
      {error && !pending && (
        <div className="alert">
          <AlertOctagon size={20} className="alert-icon" />
          <div className="alert-content">
            <div className="alert-title">Scan failed</div>
            <div className="alert-body">{error}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={handleReset}>
            <RotateCcw size={12} /> Retry
          </button>
        </div>
      )}

      {/* ---- Result display ---- */}
      {result && !pending && (
        <ScanResultPanel
          result={result}
          expandedCheck={expandedCheck}
          onExpandCheck={(cat) =>
            setExpandedCheck((prev) => (prev === cat ? null : cat))
          }
          onReset={handleReset}
        />
      )}
    </div>
  );
}

// =============================================================================
//  ScanResultPanel — verdict + agreement + providers + 12-check grid
// =============================================================================

interface ScanResultPanelProps {
  result: ScanResult;
  expandedCheck: CheckCategory | null;
  onExpandCheck: (category: CheckCategory) => void;
  onReset: () => void;
}

function ScanResultPanel({
  result,
  expandedCheck,
  onExpandCheck,
  onReset,
}: ScanResultPanelProps) {
  const verdictClass = result.verdict.toLowerCase(); // pass | review | fail
  const failedProviders = PROVIDERS.filter(
    (p) => result.individual[p]?.error !== undefined,
  );

  return (
    <div className="col" style={{ gap: 'var(--space-5)' }}>
      {/* ---- Degraded-mode warning ---- */}
      {failedProviders.length > 0 && (
        <div className="alert alert-warning">
          <AlertTriangle size={20} className="alert-icon" />
          <div className="alert-content">
            <div className="alert-title">
              Degraded scan: {failedProviders.length} of {PROVIDERS.length} provider
              {failedProviders.length === 1 ? '' : 's'} unavailable
            </div>
            <div className="alert-body">
              {result.warnings.join(' · ')}
              {' '}— verdict reflects the {PROVIDERS.length - failedProviders.length} provider
              {PROVIDERS.length - failedProviders.length === 1 ? '' : 's'} that responded.
            </div>
          </div>
        </div>
      )}

      {/* ---- Verdict banner ---- */}
      <div className={`verdict-banner ${verdictClass}`}>
        <div>
          <div className="label" style={{ marginBottom: 'var(--space-2)' }}>
            Verdict · source: {result.source}
          </div>
          <div className="display verdict-label">{result.verdict}</div>
          <div className="muted" style={{ marginTop: 'var(--space-3)', fontSize: 12 }}>
            {result.summary}
          </div>
          <div className="provider-row">
            {PROVIDERS.map((p) => {
              const ind = result.individual[p];
              const failed = ind?.error !== undefined;
              const verdict = ind?.verdict;
              const cls = failed
                ? 'error'
                : verdict === 'PASS'
                ? 'pass'
                : verdict === 'REVIEW'
                ? 'review'
                : verdict === 'FAIL'
                ? 'fail'
                : 'error';
              return (
                <span
                  key={p}
                  className={`provider-pill ${cls}`}
                  title={failed ? ind?.error : ind?.summary}
                >
                  <span className={`dot dot-${
                    failed ? 'muted' :
                    verdict === 'PASS' ? 'green' :
                    verdict === 'REVIEW' ? 'yellow' :
                    verdict === 'FAIL' ? 'red' : 'muted'
                  }`} />
                  {PROVIDER_DISPLAY[p]}
                </span>
              );
            })}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="display verdict-confidence">{result.confidence}%</div>
          <div className="verdict-confidence-label">Confidence</div>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <StatusBadge variant={
              result.agreement === 'full' ? 'green' :
              result.agreement === 'majority' ? 'yellow' : 'red'
            }>
              {result.agreement} agreement
            </StatusBadge>
          </div>
        </div>
      </div>

      {/* ---- Agreement bar ---- */}
      <div className="agreement">
        <span className="label" style={{ minWidth: 100 }}>Agreement</span>
        <div className="agreement-bar">
          <div
            className={`agreement-bar-fill ${result.agreement}`}
            style={{
              width:
                result.agreement === 'full' ? '100%' :
                result.agreement === 'majority' ? '66%' : '33%',
            }}
          />
        </div>
        <span className="label" style={{ minWidth: 80, textAlign: 'right' }}>
          {result.agreement === 'full' && 'All three agree'}
          {result.agreement === 'majority' && '2 of 3 agree'}
          {result.agreement === 'split' && 'No majority'}
        </span>
      </div>

      {/* ---- 12-check grid ---- */}
      <div className="col" style={{ gap: 'var(--space-3)' }}>
        <div className="row between">
          <span className="section-title">Detail · 12 checks</span>
          <button className="btn btn-ghost btn-sm" onClick={onReset}>
            <RotateCcw size={12} /> Scan another
          </button>
        </div>

        <div className="check-grid">
          {CHECK_CATEGORIES.map((cat) => {
            const merged = result.checks[cat];
            const isExpanded = expandedCheck === cat;
            return (
              <div key={cat} style={{ display: 'contents' }}>
                <div
                  className={`check-row ${isExpanded ? 'expanded' : ''}`}
                  onClick={() => onExpandCheck(cat)}
                >
                  <TrafficLight status={merged.status} />
                  <div className={`check-name ${merged.status === 'skip' ? 'skip' : ''}`}>
                    {CHECK_LABELS[cat]}
                  </div>
                  <div className="check-note">
                    {merged.status === 'skip' ? '—' : merged.note || merged.status}
                  </div>
                </div>

                {isExpanded && (
                  <div className="check-detail">
                    {PROVIDERS.map((p) => {
                      const ind = result.individual[p];
                      if (!ind || ind.error) {
                        return (
                          <div className="check-detail-row" key={p}>
                            <span className="check-detail-provider">{PROVIDER_DISPLAY[p]}</span>
                            <span className="muted" style={{ fontSize: 11 }}>
                              {ind?.error ? `Failed: ${ind.error}` : 'No response'}
                            </span>
                          </div>
                        );
                      }
                      const check = ind.checks?.[cat];
                      return (
                        <div className="check-detail-row" key={p}>
                          <span className="check-detail-provider">{PROVIDER_DISPLAY[p]}</span>
                          <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                            <TrafficLight status={check?.status ?? 'skip'} />
                            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                              {check?.note || check?.status || '—'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---- Issues list ---- */}
      {result.issues.length > 0 && (
        <div className="card">
          <div className="label" style={{ marginBottom: 'var(--space-3)' }}>
            Issues raised ({result.issues.length})
          </div>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {result.issues.map((issue, i) => (
              <li
                key={i}
                style={{
                  padding: 'var(--space-2) 0',
                  borderBottom: i < result.issues.length - 1 ? '1px solid var(--border)' : 'none',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                }}
              >
                <span style={{ color: 'var(--status-red)', marginRight: 'var(--space-2)' }}>•</span>
                {issue}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- Footer meta ---- */}
      <div className="row between" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        <span>
          Elapsed: {result.elapsed_seconds}s · Source: {result.source}
        </span>
        <span>
          Confidence reduced for non-full agreement (×0.85 majority, ×0.65 split)
        </span>
      </div>
    </div>
  );
}
