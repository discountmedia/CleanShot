"use client";
// apps/web/components/ui/InfoTip.tsx
//
// A small (i) button that explains the control beside it.
//
// Not a `title` attribute, which is what the rest of the app uses: a title
// never appears on a tablet, never appears for a keyboard user, and shows after
// a delay in a system font. This opens on hover, on keyboard focus, and on tap,
// and closes on Escape, on a second tap, or on a tap anywhere else.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

interface InfoTipProps {
  /** Accessible name for the button, e.g. "About equipment type". */
  label: string;
  title: string;
  children: ReactNode;
}

export function InfoTip({ label, title, children }: InfoTipProps) {
  const tipId = useId();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const open = pinned || hovered || focused;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setPinned(false); setHovered(false); setFocused(false); }
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <span
      ref={root}
      className="relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        /* A tap also focuses the button, so closing has to clear focus and
           hover too, or the second tap would leave it open. */
        onClick={() => {
          if (pinned) { setPinned(false); setFocused(false); setHovered(false); }
          else setPinned(true);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`inline-flex items-center justify-center w-6 h-6 rounded-full border-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          open ? "border-accent text-accent bg-panel-hi" : "border-line text-ink-soft hover:border-ink-faint hover:text-ink"
        }`}
      >
        {/* A bold letter, not a stroked glyph: the 24px "i" path rendered as a
            two-pixel tick at this size and did not read as an icon. */}
        <span className="text-[13px] font-bold leading-none" aria-hidden="true">i</span>
      </button>
      {open && (
        <span
          id={tipId}
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-2 w-[22rem] max-w-[calc(100vw-2.5rem)] rounded-lg border border-line bg-panel-hi px-4 py-3 shadow-lg normal-case tracking-normal text-left"
        >
          <span className="block text-sm font-bold text-ink mb-1.5">{title}</span>
          <span className="block text-sm text-ink-soft leading-relaxed font-normal space-y-2">
            {children}
          </span>
        </span>
      )}
    </span>
  );
}
