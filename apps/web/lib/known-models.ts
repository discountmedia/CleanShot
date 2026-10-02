// apps/web/lib/known-models.ts
//
// The known Make + Model list behind the Make and Model dropdowns, fetched
// once per page and shared by every component that asks (the Enhance details
// card and the export form both show it).
//
// Seeded from the inventory CSV and the forklift catalog (~1,150 pairs); an
// "Other" pair joins it when the project is saved (FastAPI does that, not the
// browser). Picking a known pair fills NO
// other field, by Stephen's decision of 2 Oct 2026.
//
// A pair is matched the way the server matches it (services/known_models.py
// match_key): uppercased, all whitespace removed. "Lift Hero" and "LIFT HERO"
// are the same make. Keep the two rules identical.

import { useEffect, useState } from "react";

export interface KnownModel {
  id: string;
  make: string;
  model: string;
}

export const nameKey = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").toUpperCase();

let current: KnownModel[] = [];
let inflight: Promise<void> | null = null;
const listeners = new Set<(m: KnownModel[]) => void>();

function load(): Promise<void> {
  inflight = fetch("/api/known-models", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((j: { models: KnownModel[] }) => {
      current = j.models ?? [];
      listeners.forEach((l) => l(current));
    })
    // A failed load leaves the dropdowns with Other only. Typing still works,
    // so the operator is never blocked by the list being unavailable.
    .catch(() => { inflight = null; });
  return inflight;
}

/** The list, loading it on first use. `refresh` re-fetches (after a save). */
export function useKnownModels(): { models: KnownModel[]; refresh: () => void } {
  const [models, setModels] = useState<KnownModel[]>(current);
  useEffect(() => {
    listeners.add(setModels);
    if (!inflight) void load();
    return () => { listeners.delete(setModels); };
  }, []);
  return { models, refresh: () => { void load(); } };
}

/** Distinct makes, each in the first spelling the list holds, A to Z. */
export function makesOf(models: readonly KnownModel[]): string[] {
  const seen = new Map<string, string>();
  for (const m of models) if (!seen.has(nameKey(m.make))) seen.set(nameKey(m.make), m.make);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Models listed under a make (matched by key), A to Z. */
export function modelsFor(models: readonly KnownModel[], make: string | null | undefined): string[] {
  const k = nameKey(make);
  if (!k) return [];
  return models.filter((m) => nameKey(m.make) === k).map((m) => m.model)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

/** Whether `value` is one of `options`, by key. */
export const isListed = (options: readonly string[], value: string | null | undefined) =>
  !!nameKey(value) && options.some((o) => nameKey(o) === nameKey(value));
