"use client";

/**
 * GUIDES tab — the operator documentation, rendered in-page.
 *
 * WHY IT LOOKS LIKE THIS
 * ----------------------
 * The guide markup is compiled INTO this chunk (guide-html.generated.ts) and
 * painted into a shadow root. No iframe, no fetch, no URL.
 *
 * The first version used an <iframe src="/guides/…">. It rendered blank, twice,
 * for two different invisible reasons: `X-Frame-Options: DENY` applied to every
 * route, and the auth proxy's static-asset allowlist had no `.html`, so a
 * cookie-less load would have framed the login page. Both are fixed — but both
 * were silent failures that looked identical from the outside, and neither was
 * visible without a browser. A string import has no such failure mode.
 *
 * The shadow root is what an iframe was buying: the guides carry a complete
 * stylesheet of their own, with generic class names (.page, .block, .callout)
 * that would collide with the app's in either direction. A shadow boundary
 * isolates them with none of the loading, sizing or header problems.
 *
 * The prose still lives in exactly one place — docs/guides/*.html.
 * scripts/build_guides.py produces both this module and the standalone pages
 * under public/guides/ that the "open in a new tab" link points at.
 */

import { useEffect, useRef, useState } from "react";

import { GUIDE_HTML } from "./guide-html.generated";

interface GuideMeta {
  /** Matches the `id` in guide-html.generated.ts (the source filename stem). */
  id: string;
  /** One line: who it's for and what it answers. */
  blurb: string;
  /** Standalone page for printing or sharing outside the app. */
  file: string;
}

const META: GuideMeta[] = [
  {
    id: "enhance-tab",
    blurb:
      "Every control in the order you use it, how to write a prompt that works, and how to read the quality check.",
    file: "/guides/enhance-tab.html",
  },
  {
    id: "prompt-templates",
    blurb:
      "The shared template library — using one, saving one, shortening a long one, and the rules that can't be undone.",
    file: "/guides/prompt-templates.html",
  },
];

/** Ordered by META, so the switcher order is editorial rather than alphabetical. */
const GUIDES = META.map((m) => {
  const content = GUIDE_HTML.find((g) => g.id === m.id);
  return content ? { ...m, title: content.title, html: content.html } : null;
}).filter((g): g is GuideMeta & { title: string; html: string } => g !== null);

export function GuidesPanel() {
  const [activeId, setActiveId] = useState(GUIDES[0]?.id ?? "");
  const hostRef = useRef<HTMLDivElement>(null);

  const active = GUIDES.find((g) => g.id === activeId) ?? GUIDES[0];

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    // attachShadow throws if called twice on the same element, and the ref is
    // stable across guide switches, so reuse whatever is already there.
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    // Build-time content from our own repo, not user input, and <script> tags
    // inserted this way do not execute in any case.
    root.innerHTML = active.html;
    // The guide's internal anchors are same-document links. Inside a shadow
    // root the browser won't resolve them against the host page, so wire them
    // up by hand — otherwise the contents list at the top does nothing.
    const onClick = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const link = target?.closest?.("a[href^='#']") as HTMLAnchorElement | null;
      if (!link) return;
      const id = link.getAttribute("href")?.slice(1);
      if (!id) return;
      e.preventDefault();
      root.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [active]);

  if (!active) {
    return (
      <p className="text-base text-ink">
        No guides are bundled. Run <strong>python scripts/build_guides.py</strong>.
      </p>
    );
  }

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-line bg-well/60 overflow-hidden">
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="text-base font-semibold uppercase tracking-[0.14em] text-ink">
              Guides
            </h2>
            <a
              href={active.file}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-bold text-accent hover:underline"
            >
              Open in a new tab ↗
            </a>
          </div>

          {/* Two guides today, so a row of buttons beats a sidebar. Past about
              five, move it to a left rail. */}
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Guides">
            {GUIDES.map((g) => {
              const isActive = g.id === active.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveId(g.id)}
                  className={`text-sm uppercase tracking-[0.14em] font-bold px-4 py-2.5 rounded-lg border-2 transition-colors ${
                    isActive
                      ? "border-accent bg-accent text-header-bg"
                      : "border-line bg-panel text-ink hover:bg-panel-hi"
                  }`}
                >
                  {g.title}
                </button>
              );
            })}
          </div>

          <p className="text-sm text-ink-soft leading-relaxed max-w-3xl">
            {active.blurb}
          </p>
        </div>

        {/* Shadow host. The guide brings its own complete stylesheet; the
            boundary stops it and the app's Tailwind from reaching each other. */}
        <div className="border-t border-line bg-bg">
          <div ref={hostRef} />
        </div>
      </div>

      <p className="text-sm text-ink-soft leading-relaxed">
        Something here wrong or out of date?{" "}
        <strong className="text-ink">Say so</strong> — these are written against
        the code, and when the code changes ahead of them they become worse than
        nothing.
      </p>
    </section>
  );
}
