/**
 * Global client store.
 *
 * This is intentionally small. Per Phase 3 v3.4: "Zustand for app state.
 * No Redux, no React Query in v1 (built-in fetch + setInterval is enough)."
 *
 * The store holds:
 *   - session_id (created lazily on first action)
 *   - assets uploaded in this session, by asset_id
 *   - active asset selection per tab
 *   - in-flight job ids per tab (so re-mounts don't lose progress UI)
 *
 * The store does NOT cache job results — those are read fresh on each
 * /api/v1/jobs/{id} poll. Caching belongs in the polling hook, not here.
 */

"use client";

import { create } from "zustand";

export type AssetRecord = {
  asset_id: string;
  filename: string;
  mime_type: string;
  uploaded_at: string;
};

type Tab = "enhance" | "scan" | "resize";

type State = {
  session_id: string | null;
  assets: Record<string, AssetRecord>;
  // active asset per tab — independently tracked so switching tabs doesn't
  // wipe the selection on the others
  active: Record<Tab, string | null>;
  // current in-flight job per tab
  jobs: Record<Tab, string | null>;

  // actions
  setSession: (id: string) => void;
  addAsset: (rec: AssetRecord) => void;
  setActive: (tab: Tab, asset_id: string | null) => void;
  setJob: (tab: Tab, job_id: string | null) => void;
  clearJob: (tab: Tab) => void;
};

export const useStore = create<State>((set) => ({
  session_id: null,
  assets: {},
  active: { enhance: null, scan: null, resize: null },
  jobs: { enhance: null, scan: null, resize: null },

  setSession: (id) => set({ session_id: id }),

  addAsset: (rec) =>
    set((s) => ({ assets: { ...s.assets, [rec.asset_id]: rec } })),

  setActive: (tab, asset_id) =>
    set((s) => ({ active: { ...s.active, [tab]: asset_id } })),

  setJob: (tab, job_id) =>
    set((s) => ({ jobs: { ...s.jobs, [tab]: job_id } })),

  clearJob: (tab) =>
    set((s) => ({ jobs: { ...s.jobs, [tab]: null } })),
}));
