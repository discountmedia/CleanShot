// apps/web/components/workspace/TipBanner.tsx
// Reusable explanatory banner — used at the top of each tab to give the
// operator a plain-language summary of what the tab does and what to do
// next. Written for someone who has never used the tool before; same
// "5-year-old can follow this" target as the rest of the UI copy.
//
// Two visual tones:
//   • info  — blue (default). Use for general "here's what this tab is."
//   • warn  — amber. Use when there's a gotcha worth flagging.
//
// Collapsible accordion (2026-05-27): when `collapsible` (default true),
// the banner is a click-to-toggle accordion. Its DEFAULT open/closed
// state is driven by the app-wide visit count — expanded for visits 1-3
// (operator still learning), collapsed for visit 4+ (operator knows the
// tool). The operator can always toggle it manually regardless.

"use client";

import { useState, type ReactNode } from "react";
import { useVisitCount, shouldDefaultExpand } from "@/lib/useVisitCount";

interface TipBannerProps {
  title:    string;
  tone?:    "info" | "warn";
  /** Optional step list — rendered as a numbered ordered-list under the prose. */
  steps?:   ReactNode[];
  /** Optional dismiss handler — when set, an ✕ button is shown top-right. */
  onDismiss?: () => void;
  /**
   * When true (default), the banner is a collapsible accordion whose
   * default open state follows the visit-count policy. Pass false to
   * force it always-open with no toggle (rare — only for banners that
   * must stay visible).
   */
  collapsible?: boolean;
  children: ReactNode;
}

const TONE: Record<NonNullable<TipBannerProps["tone"]>, {
  border: string;
  bg:     string;
  iconBg: string;
  icon:   string;
  title:  string;
}> = {
  // Info is neutral with a lime icon — the old blue tone is gone with the
  // rest of the blue, and lime is the brand/helper colour. Warn is red,
  // which is this palette's only attention colour (there is no amber).
  info: {
    border: "border-line",
    bg:     "bg-panel",
    iconBg: "bg-panel border-line",
    icon:   "text-accent",
    title:  "text-ink",
  },
  warn: {
    border: "border-danger-ink",
    bg:     "bg-panel",
    iconBg: "bg-panel border-danger-ink",
    icon:   "text-danger-ink",
    title:  "text-danger-ink",
  },
};

export function TipBanner({
  title,
  tone = "info",
  steps,
  onDismiss,
  collapsible = true,
  children,
}: TipBannerProps) {
  const t = TONE[tone];

  const visitCount = useVisitCount();
  // Initial expansion: non-collapsible banners are always open; collapsible
  // ones follow the visit-count policy (expanded 1-3, collapsed 4+).
  const [expanded, setExpanded] = useState<boolean>(
    () => !collapsible || shouldDefaultExpand(visitCount),
  );

  const Icon = (
    <span
      className={`w-9 h-9 rounded-full border flex items-center justify-center shrink-0 ${t.iconBg}`}
      aria-hidden="true"
    >
      <svg
        className={`w-5 h-5 ${t.icon}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        {tone === "warn" ? (
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
          />
        ) : (
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        )}
      </svg>
    </span>
  );

  const titleEl = (
    <h3 className={`font-display text-base uppercase tracking-[0.12em] ${t.title}`}>
      {title}
    </h3>
  );

  return (
    <section
      className={`rounded-xl border ${t.border} ${t.bg} px-5 py-4`}
      role="note"
      aria-label={title}
    >
      <div className="flex items-start gap-4">
        {Icon}

        <div className="flex-1 min-w-0">
          {collapsible ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="w-full flex items-center justify-between gap-3 text-left group"
            >
              {titleEl}
              <span className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}>
                <svg className={`w-4 h-4 ${t.icon}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </span>
            </button>
          ) : (
            titleEl
          )}

          {expanded && (
            <div className="space-y-2 mt-2">
              <div className="text-sm text-ink leading-relaxed space-y-2">
                {children}
              </div>
              {steps && steps.length > 0 && (
                <ol className="space-y-1.5 text-sm text-ink leading-relaxed list-decimal pl-5 pt-1 marker:text-ink-soft marker:font-semibold">
                  {steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>

        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss tip"
            className="text-ink-faint hover:text-ink text-lg leading-none px-1 shrink-0"
          >
            ×
          </button>
        )}
      </div>
    </section>
  );
}
