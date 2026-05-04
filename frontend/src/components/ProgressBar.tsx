// =============================================================================
//  ProgressBar — linear fill, supports status color overrides
// =============================================================================

interface ProgressBarProps {
  percent: number;            // 0-100
  variant?: 'default' | 'green' | 'yellow' | 'red';
  height?: number;
}

export function ProgressBar({ percent, variant = 'default', height = 4 }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="progress" style={{ height }}>
      <div
        className={`progress-fill ${variant === 'default' ? '' : variant}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
