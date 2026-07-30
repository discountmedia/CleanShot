"use client";
// apps/web/components/workspace/AlertBanner.tsx
// Red callout banner for "X items need attention" messages.
// Matches the alert banner style from the inventory dashboard screenshots.

import { useState } from "react";

type Severity = "danger" | "warn" | "info";

// The palette has ONE attention colour (purple `attn`), so danger and warn
// can no longer differ by hue — they differ by WEIGHT instead: danger gets a
// 2px rule and a raised surface, warn a hairline on the flat panel. Without
// this the two severities were byte-identical, which reads as a copy-paste
// bug to the next person in here.
const STYLES: Record<Severity, { border: string; icon: string; title: string }> = {
  danger: {
    border: "border-2 border-attn bg-panel-hi",
    icon:   "text-attn",
    title:  "text-attn",
  },
  warn: {
    border: "border-attn bg-panel",
    icon:   "text-attn",
    title:  "text-ink",
  },
  info: {
    border: "border-line bg-panel/40",
    icon:   "text-ink-soft",
    title:  "text-ink",
  },
};

interface AlertBannerProps {
  severity?: Severity;
  title: string;
  body?: React.ReactNode;
  /** When provided, renders an X close button that hides the banner */
  dismissible?: boolean;
  /** Optional right-side CTA, e.g. <a>VIEW NOW</a> */
  action?: React.ReactNode;
}

export function AlertBanner({
  severity = "danger",
  title,
  body,
  dismissible = true,
  action,
}: AlertBannerProps) {
  const [open, setOpen] = useState(true);
  const s = STYLES[severity];

  if (!open) return null;

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${s.border}`}
    >
      {/* Icon */}
      <svg
        className={`w-5 h-5 mt-0.5 shrink-0 ${s.icon}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>

      {/* Title + body */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-bold uppercase tracking-wider ${s.title}`}>
          {title}
        </p>
        {body && (
          <p className="mt-0.5 text-sm text-ink-soft leading-snug">
            {body}
          </p>
        )}
      </div>

      {/* Action + close */}
      <div className="shrink-0 flex items-center gap-3">
        {action}
        {dismissible && (
          <button
            onClick={() => setOpen(false)}
            className="text-muted hover:text-ink-soft transition-colors"
            aria-label="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
