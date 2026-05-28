"use client";
// apps/web/lib/useVisitCount.ts
// App-wide visit counter backed by localStorage. Drives the
// "expanded for new users, collapsed for veterans" default on the
// blue tooltip accordions (TipBanner) across every tab.
//
// "Visit" = one page load. A module-level guard ensures the count
// increments exactly once per load even though multiple TipBanners
// call the hook — otherwise a tab with 3 tooltips would tick the
// counter 3× per visit.

import { useEffect, useState } from "react";

const STORAGE_KEY = "cleanshot_visit_count";

// Flipped true the first time ANY component increments this page-load.
// Module scope = shared across every hook caller in the same JS context.
let incrementedThisLoad = false;

/**
 * Returns the current visit count (1-based). Reads localStorage
 * synchronously on the client to avoid a default-state flash; falls
 * back to 0 during SSR (where localStorage doesn't exist).
 */
export function useVisitCount(): number {
  const [count, setCount] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    return parseInt(localStorage.getItem(STORAGE_KEY) ?? "0", 10) || 0;
  });

  useEffect(() => {
    if (incrementedThisLoad) return;
    incrementedThisLoad = true;
    const next = (parseInt(localStorage.getItem(STORAGE_KEY) ?? "0", 10) || 0) + 1;
    localStorage.setItem(STORAGE_KEY, String(next));
    setCount(next);
  }, []);

  return count;
}

/**
 * Tooltip accordion default-expansion policy:
 *   visits 1-4  → expanded  (still learning the tool)
 *   visit  5+   → collapsed (knows their way around)
 * count === 0 (SSR / pre-resolve) defaults to expanded — the safe,
 * no-flash-for-new-users choice.
 */
export function shouldDefaultExpand(visitCount: number): boolean {
  return visitCount === 0 || visitCount <= 4;
}
