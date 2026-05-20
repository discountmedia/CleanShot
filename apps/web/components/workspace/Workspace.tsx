"use client";
// apps/web/components/workspace/Workspace.tsx
// Main client-side workspace shell. Owns:
//   • active tab state
//   • a single session_id used by all four operation panels
//   • the cross-panel pipeline state (enhanced assets → scan / resize)
//
// Layout matches the company's other internal apps:
//   Header (logo + title + user menu) → red accent stripe → optional alert
//   → KPI row → tab bar → active panel content

import { useEffect, useState } from "react";

import { Header } from "./Header";
import { TabBar, type TabId } from "./TabBar";

import { EnhancePanel } from "@/components/enhance/EnhancePanel";
import { ScanPanel } from "@/components/scan/ScanPanel";
import { ResizePanel } from "@/components/resize/ResizePanel";
import { HistoryList } from "@/components/history/HistoryList";

import { createSession } from "@/lib/api";
import type { ForkliftMeta, ResizeResult } from "@/lib/types";

// Cross-panel asset shape. Each panel emits these as its output.
interface PipelineAsset {
  assetId: string;
  filename: string;
  thumbnailUrl: string;
  outputUrl?: string;
}

interface WorkspaceProps {
  /** Email of the authenticated user. Falls back to "dev@local" in bypass mode. */
  userEmail: string;
  /** True when AUTH_ENABLED=false; affects the header chip and HistoryList behavior. */
  bypassed?: boolean;
  /** True if the user's email is in ADMIN_EMAILS — shows the Admin link in Header. */
  isAdmin?: boolean;
}

export function Workspace({ userEmail, bypassed = false, isAdmin = false }: WorkspaceProps) {
  const [activeTab, setActiveTab] = useState<TabId>("enhance");

  // One session per workspace mount. Created lazily on first render so unauthed
  // dev sessions still get a working pipeline.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Cross-panel pipeline state. The flow is curated by the user:
  //   Enhance → "Send to Scan"   → enhancedAssets  (what Scan tab analyzes)
  //   Scan    → "Send to Resize" → resizeAssets   (what Resize tab processes)
  //   Resize  → onResizeComplete → resizeResults  (sized outputs for export)
  // Each handoff is explicit so the operator can curate (e.g., only push
  // images that passed scan, or regenerated versions instead of originals).
  const [enhancedAssets, setEnhancedAssets] = useState<PipelineAsset[]>([]);
  const [resizeAssets,   setResizeAssets]   = useState<PipelineAsset[]>([]);
  const [resizeResults,  setResizeResults]  = useState<ResizeResult[]>([]);

  // Forklift metadata is owned by Workspace so it survives panel
  // switches and so Resize can pre-fill its Save Project form from
  // values the operator already entered on Enhance. Username falls out
  // of `userEmail` on the Resize tab (no separate state needed).
  const [meta, setMeta] = useState<Partial<ForkliftMeta>>({});

  useEffect(() => {
    let cancelled = false;
    createSession()
      .then(({ sessionId }) => {
        if (!cancelled) setSessionId(sessionId);
      })
      .catch((err: Error) => {
        if (!cancelled) setSessionError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tabs = [
    { id: "enhance" as const, label: "Enhance" },
    { id: "scan"    as const, label: "Scan",    count: enhancedAssets.length || undefined },
    { id: "resize"  as const, label: "Resize",  count: resizeAssets.length || undefined },
    { id: "history" as const, label: "History" },
  ];

  // Explicit user action: "Send to Scan" (per-row) or "Send all to Scan tab"
  // (batch). Auto-handoff was removed at the user's request — enhance completion
  // alone does NOT push to Scan; the user clicks the button when ready.
  const handleSendToScan = (items: Array<{
    jobId: string;
    outputAssetId: string;
    filename: string;
    outputUrl: string;
  }>) => {
    setEnhancedAssets((prev) => {
      const existing = new Set(prev.map((a) => a.assetId));
      const additions = items
        .filter((it) => !existing.has(it.outputAssetId))
        .map((it): PipelineAsset => ({
          assetId:      it.outputAssetId,
          filename:     it.filename,
          thumbnailUrl: it.outputUrl,
          outputUrl:    it.outputUrl,
        }));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
    // Switch to the Scan tab so the user sees the result of their action.
    setActiveTab("scan");
  };

  // Called by EnhancePanel or ScanPanel when the user clicks their own
  // "Clear all" — wipes the downstream pipeline state at the workspace
  // level so old assets don't keep getting rescanned or re-listed.
  const handleClearPipeline = () => {
    setEnhancedAssets([]);
    setResizeAssets([]);
    setResizeResults([]);
  };

  // Explicit user action from the Scan tab. Mirror of handleSendToScan,
  // but feeds the resizeAssets pipeline + switches to the Resize tab.
  const handleSendToResize = (items: PipelineAsset[]) => {
    setResizeAssets((prev) => {
      const existing = new Set(prev.map((a) => a.assetId));
      const additions = items.filter((it) => !existing.has(it.assetId));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
    setActiveTab("resize");
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <Header bypassed={bypassed} isAdmin={isAdmin} />

      {/* Tab bar */}
      <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {/* Body */}
      <main className="flex-1 px-6 py-6 space-y-6 max-w-screen-2xl w-full mx-auto">
        {sessionError && (
          <div className="rounded-xl border border-red-900 bg-red-950/30 px-4 py-3 text-sm text-red-300">
            Could not start a workspace session: {sessionError}
          </div>
        )}

        {/* Active panel — all four stay mounted to preserve in-progress state
            across tab switches; only the active one is visible. */}
        <div className="relative">
          <PanelSlot active={activeTab === "enhance"}>
            {sessionId && (
              <EnhancePanel
                sessionId={sessionId}
                meta={meta}
                onMetaChange={setMeta}
                onSendToScan={handleSendToScan}
                onClearPipeline={handleClearPipeline}
              />
            )}
          </PanelSlot>

          <PanelSlot active={activeTab === "scan"}>
            {sessionId && (
              <ScanPanel
                sessionId={sessionId}
                enhancedAssets={enhancedAssets}
                onClearPipeline={handleClearPipeline}
                onSendToResize={handleSendToResize}
              />
            )}
          </PanelSlot>

          <PanelSlot active={activeTab === "resize"}>
            {sessionId && (
              <ResizePanel
                sessionId={sessionId}
                // ResizePanel's prop is named enhancedAssets for historic
                // reasons; semantically it now receives the curated
                // resizeAssets list (images user explicitly sent to Resize
                // from the Scan tab).
                enhancedAssets={resizeAssets}
                resizeResults={resizeResults}
                onResizeComplete={setResizeResults}
                meta={meta}
                userEmail={userEmail}
              />
            )}
          </PanelSlot>

          <PanelSlot active={activeTab === "history"}>
            <HistoryList userEmail={userEmail} />
          </PanelSlot>

          {!sessionId && !sessionError && activeTab !== "history" && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-6 py-12 text-center text-sm text-zinc-500">
              Starting a workspace session…
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * Renders children but hides them when inactive. Keeps each panel's internal
 * state (uploads in flight, scan polling, etc.) alive across tab switches.
 */
function PanelSlot({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className={active ? "block" : "hidden"} aria-hidden={!active}>
      {children}
    </div>
  );
}
