// =============================================================================
//  Zustand store — shared application state across the three tabs.
//
//  Sessions and assets are global. Jobs and selection are partitioned by tab.
//  Switching tabs preserves selection so users don't lose their work.
// =============================================================================

import { create } from 'zustand';
import type {
  UploadedAsset,
  EnhanceJobLocal,
  ScanJobLocal,
} from './types';

export type TabId = 'enhance' | 'scan' | 'resize';

interface AppState {
  // ---- Session ----
  session_id: string | null;

  // ---- Assets (global; uploaded via any tab can be reused by any other) ----
  assets: Record<string, UploadedAsset>;

  // ---- Tab routing ----
  active_tab: TabId;
  scan_prefill_asset_id: string | null;   // 'Scan this image' from Enhance result

  // ---- Per-tab selection ----
  enhance_selection: string[];
  resize_selection: string[];
  scan_selection: string[];

  // ---- Per-tab jobs ----
  enhance_jobs: Record<string, EnhanceJobLocal>;   // keyed by asset_id
  resize_jobs: Record<string, EnhanceJobLocal>;    // same shape as enhance
  scan_jobs: Record<string, ScanJobLocal>;         // keyed by asset_id

  // ---- Actions ----
  setSession: (session_id: string) => void;
  setActiveTab: (tab: TabId) => void;

  registerAsset: (asset: UploadedAsset) => void;
  markAssetUploaded: (asset_id: string) => void;
  setAssetError: (asset_id: string, error: string) => void;

  toggleEnhanceSelection: (asset_id: string) => void;
  toggleResizeSelection: (asset_id: string) => void;
  toggleScanSelection: (asset_id: string) => void;
  clearSelection: (tab: TabId) => void;

  setEnhanceJob: (asset_id: string, job: EnhanceJobLocal) => void;
  setResizeJob: (asset_id: string, job: EnhanceJobLocal) => void;
  setScanJob: (asset_id: string, job: ScanJobLocal) => void;

  prefillScan: (asset_id: string) => void;
  clearScanPrefill: () => void;
}

export const useStore = create<AppState>((set) => ({
  session_id: null,
  assets: {},
  active_tab: 'enhance',
  scan_prefill_asset_id: null,
  enhance_selection: [],
  resize_selection: [],
  scan_selection: [],
  enhance_jobs: {},
  resize_jobs: {},
  scan_jobs: {},

  setSession: (session_id) => set({ session_id }),

  setActiveTab: (active_tab) => set({ active_tab }),

  registerAsset: (asset) =>
    set((state) => ({
      assets: { ...state.assets, [asset.asset_id]: asset },
    })),

  markAssetUploaded: (asset_id) =>
    set((state) => ({
      assets: state.assets[asset_id]
        ? { ...state.assets, [asset_id]: { ...state.assets[asset_id], uploaded: true } }
        : state.assets,
    })),

  setAssetError: (asset_id, error) =>
    set((state) => ({
      assets: state.assets[asset_id]
        ? { ...state.assets, [asset_id]: { ...state.assets[asset_id], upload_error: error } }
        : state.assets,
    })),

  toggleEnhanceSelection: (asset_id) =>
    set((state) => ({
      enhance_selection: state.enhance_selection.includes(asset_id)
        ? state.enhance_selection.filter((id) => id !== asset_id)
        : [...state.enhance_selection, asset_id],
    })),

  toggleResizeSelection: (asset_id) =>
    set((state) => ({
      resize_selection: state.resize_selection.includes(asset_id)
        ? state.resize_selection.filter((id) => id !== asset_id)
        : [...state.resize_selection, asset_id],
    })),

  toggleScanSelection: (asset_id) =>
    set((state) => ({
      scan_selection: state.scan_selection.includes(asset_id)
        ? state.scan_selection.filter((id) => id !== asset_id)
        : [...state.scan_selection, asset_id],
    })),

  clearSelection: (tab) =>
    set(() => {
      if (tab === 'enhance') return { enhance_selection: [] };
      if (tab === 'resize') return { resize_selection: [] };
      return { scan_selection: [] };
    }),

  setEnhanceJob: (asset_id, job) =>
    set((state) => ({ enhance_jobs: { ...state.enhance_jobs, [asset_id]: job } })),

  setResizeJob: (asset_id, job) =>
    set((state) => ({ resize_jobs: { ...state.resize_jobs, [asset_id]: job } })),

  setScanJob: (asset_id, job) =>
    set((state) => ({ scan_jobs: { ...state.scan_jobs, [asset_id]: job } })),

  prefillScan: (asset_id) =>
    set({ active_tab: 'scan', scan_prefill_asset_id: asset_id, scan_selection: [asset_id] }),

  clearScanPrefill: () => set({ scan_prefill_asset_id: null }),
}));
