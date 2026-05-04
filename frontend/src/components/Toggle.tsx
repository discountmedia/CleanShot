// =============================================================================
//  Toggle — labeled checkbox toggle. Used for Enhance tab brand rule toggles.
// =============================================================================

import { Check } from 'lucide-react';

interface ToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ label, description, checked, onChange, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? 'checked' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      title={description}
    >
      <span className="toggle-indicator">
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      <span className="toggle-label">{label}</span>
    </button>
  );
}
