// =============================================================================
//  StatusBadge — small text pill in a status color. Used for verdict labels,
//  agreement indicators, and per-provider attribution.
// =============================================================================

import type { ReactNode } from 'react';
import type { Verdict, CheckStatus, Agreement } from '../lib/types';

type Variant = 'green' | 'yellow' | 'red' | 'blue' | 'orange' | 'neutral';

interface StatusBadgeProps {
  variant: Variant;
  children: ReactNode;
}

export function StatusBadge({ variant, children }: StatusBadgeProps) {
  const className = variant === 'neutral' ? 'badge' : `badge badge-${variant}`;
  return <span className={className}>{children}</span>;
}

// ---- Helpers to map verdicts/statuses to badge variants ----

export function verdictVariant(v: Verdict | undefined): Variant {
  if (v === 'PASS') return 'green';
  if (v === 'REVIEW') return 'yellow';
  if (v === 'FAIL') return 'red';
  return 'neutral';
}

export function checkStatusVariant(s: CheckStatus): Variant {
  if (s === 'ok') return 'green';
  if (s === 'warn') return 'yellow';
  if (s === 'bad') return 'red';
  return 'neutral';
}

export function agreementVariant(a: Agreement): Variant {
  if (a === 'full') return 'green';
  if (a === 'majority') return 'yellow';
  return 'red';
}

interface TrafficLightProps {
  status: CheckStatus;
}

export function TrafficLight({ status }: TrafficLightProps) {
  return <span className={`check-traffic-light ${status}`} aria-label={status} />;
}
