// apps/web/components/workspace/TipBanner.tsx
// Reusable explanatory banner — used at the top of each tab to give the
// operator a plain-language summary of what the tab does and what to do
// next. Written for someone who has never used the tool before; same
// "5-year-old can follow this" target as the rest of the UI copy.
//
// Two visual tones:
//   • info  — blue (default). Use for general "here's what this tab is."
//   • warn  — amber. Use when there's a gotcha worth flagging.

"use client";

import { useEffect, useState, type ReactNode } from "react";

interface TipBannerProps {
  title:    string;
  tone?:    "info" | "warn";
  /** Optional step list — rendered as a numbered ordered-list under the prose. */
  steps?:   ReactNode[];
  /** Optional dismiss handler — when set, an ✕ button is shown top-right. */
  onDismiss?: () => void;
  children: ReactNode;
}

const TONE: Record<NonNullable<TipBannerProps["tone"]>, {
  border: string;
  bg:     string;
  iconBg: string;
  icon:   string;
  title:  string;
}> = {
  info: {
    border: "border-blue-900",
    bg:     "bg-blue-950/30",
    iconBg: "bg-blue-900/60 border-blue-700",
    icon:   "text-blue-300",
    title:  "text-blue-100",
  },
  warn: {
    border: "border-amber-900",
    bg:     "bg-amber-950/30",
    iconBg: "bg-amber-900/60 border-amber-700",
    icon:   "text-amber-300",
    title:  "text-amber-100",
  },
};

export function TipBanner({
  title,
  tone = "info",
  steps,
  onDismiss,
  children,
}: TipBannerProps) {
  const t = TONE[tone];

  // Defer the numbered step list one paint after mount so the initial
  // visible content is just the icon + title + short prose body — a
  // smaller LCP candidate that paints sooner. The steps list (often
  // 4-6 items, can be the biggest visual block on the tab) snaps in
  // a frame later. Effectively a free LCP improvement that doesn't
  // change the final visible state. Real Experience Score fix
  // 2026-05-27.
  const [showSteps, setShowSteps] = useState(false);
  useEffect(() => {
    setShowSteps(true);
  }, []);

  return (
    <section
      className={`rounded-xl border ${t.border} ${t.bg} px-5 py-4 flex items-start gap-4`}
      role="note"
      aria-label={title}
    >
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

      <div className="flex-1 min-w-0 space-y-2">
        <h3 className={`text-base font-semibold uppercase tracking-[0.12em] ${t.title}`}>
          {title}
        </h3>
        <div className="text-sm text-zinc-200 leading-relaxed space-y-2">
          {children}
        </div>
        {showSteps && steps && steps.length > 0 && (
          <ol className="space-y-1.5 text-sm text-zinc-200 leading-relaxed list-decimal pl-5 pt-1 marker:text-zinc-400 marker:font-semibold">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        )}
      </div>

      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss tip"
          className="text-zinc-500 hover:text-zinc-200 text-lg leading-none px-1"
        >
          ×
        </button>
      )}
    </section>
  );
}
