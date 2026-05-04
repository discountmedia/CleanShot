// =============================================================================
//  Dropzone — drag-and-drop file picker. Used by all three tabs.
// =============================================================================

import { useDropzone } from 'react-dropzone';
import { Upload } from 'lucide-react';

interface DropzoneProps {
  onFiles: (files: File[]) => void;
  primaryText?: string;
  secondaryText?: string;
  accept?: Record<string, string[]>;
  maxFiles?: number;
  disabled?: boolean;
}

const DEFAULT_ACCEPT: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
};

export function Dropzone({
  onFiles,
  primaryText = 'Drop images here or click to browse',
  secondaryText,
  accept = DEFAULT_ACCEPT,
  maxFiles = 50,
  disabled = false,
}: DropzoneProps) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (files: File[]) => {
      if (!disabled) onFiles(files);
    },
    accept,
    maxFiles,
    disabled,
  });

  return (
    <div
      {...getRootProps()}
      className={`dropzone ${isDragActive ? 'dragging' : ''}`}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
    >
      <input {...getInputProps()} />
      <Upload size={32} className="dropzone-icon" />
      <div className="dropzone-primary">{primaryText}</div>
      {secondaryText && <div className="dropzone-secondary">{secondaryText}</div>}
    </div>
  );
}
