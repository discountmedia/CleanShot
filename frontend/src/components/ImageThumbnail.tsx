// =============================================================================
//  ImageThumbnail — clickable preview tile. Optional status chip overlays the
//  top-right corner. Used in all three tabs' image grids.
// =============================================================================

import type { UploadedAsset } from '../lib/types';

interface ImageThumbnailProps {
  asset: UploadedAsset;
  selected?: boolean;
  onClick?: () => void;
  status?: { label: string; color?: 'green' | 'yellow' | 'red' | 'blue' };
}

export function ImageThumbnail({
  asset,
  selected = false,
  onClick,
  status,
}: ImageThumbnailProps) {
  return (
    <div
      className={`thumb ${selected ? 'selected' : ''}`}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <img src={asset.preview_url} alt={asset.filename} />
      {status && (
        <div
          className="thumb-status"
          style={status.color ? { color: `var(--status-${status.color})` } : undefined}
        >
          {status.label}
        </div>
      )}
      {!asset.uploaded && !asset.upload_error && (
        <div className="thumb-status" style={{ color: 'var(--text-muted)' }}>
          Uploading
        </div>
      )}
      {asset.upload_error && (
        <div className="thumb-status" style={{ color: 'var(--status-red)' }}>
          Failed
        </div>
      )}
    </div>
  );
}
