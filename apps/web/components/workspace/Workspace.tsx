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
import { ModifyPanel } from "@/components/modify/ModifyPanel";

import { createSession } from "@/lib/api";
import type { ForkliftMeta, ResizeResult } from "@/lib/types";

// Cross-panel asset shape. Each panel emits these as its output.
interface PipelineAsset {
  assetId: string;
  filename: string;
  thumbnailUrl: string;
  outputUrl?: string;
  /**
   * Which AI provider produced this enhance output. Carried through
   * the Scan and Resize pipelines so duplicate variants of the same
   * source image (one per provider) can be distinguished by name +
   * baked into the export filename.
   */
  provider?: string;
}

// `filename` lives in the UI as "Toyota_8FGU25_2019_01.jpg" today. When
// the same source image is enhanced through 2+ providers and sent to
// Scan, every variant ends up with the same filename — confusing. This
// helper suffixes the basename with the provider so the operator can
// tell them apart in the Scan / Resize lists:
//
//   "Toyota_8FGU25_2019_01.jpg" + "gemini" → "Toyota_8FGU25_2019_01_Gemini.jpg"
function providerSuffixedFilename(name: string, provider?: string): string {
  if (!provider) return name;
  const cap = provider.charAt(0).toUpperCase() + provider.slice(1);
  const idx = name.lastIndexOf(".");
  if (idx < 0) return `${name}_${cap}`;
  return `${name.slice(0, idx)}_${cap}${name.slice(idx)}`;
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

  // Auto-advance toggle — defaults OFF (per product owner: power-user
  // shortcut, not the first-run experience). Lives in Workspace so the
  // header chip and EnhancePanel's auto-send effect share one source of
  // truth. Intentionally session-scoped: not persisted to localStorage,
  // so a page reload returns to the "explicit hand-off" default.
  const [autoAdvance, setAutoAdvance] = useState(false);

  // Mirror of `files.length` inside EnhancePanel. Lifted so the
  // BatchContextStrip (which lives above the tab body, in Workspace) can
  // show the current batch size without having to live inside EnhancePanel.
  // Set via the `onFileCountChange` callback prop.
  const [enhanceFileCount, setEnhanceFileCount] = useState(0);

  // Bumped every time the cross-panel pipeline gets cleared (by
  // EnhancePanel's auto-reset on a new batch, by any tab's "Clear all"
  // button, etc.). Used as the React `key` on ScanPanel and ResizePanel
  // so they remount with fresh local state — otherwise their internal
  // scanStates / uploads / previewItems would survive the workspace
  // queue clear and the operator would still see ghost cards from the
  // previous batch.
  const [pipelineGeneration, setPipelineGeneration] = useState(0);

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
    { id: "modify"  as const, label: "Modify",  count: resizeAssets.length || undefined },
    { id: "resize"  as const, label: "Resize",  count: resizeAssets.length || undefined },
    { id: "history" as const, label: "Your Photo Library" },
  ];

  // Explicit user action: "Send to Scan" (per-row) or "Send all to Scan tab"
  // (batch). Auto-handoff was removed at the user's request — enhance completion
  // alone does NOT push to Scan; the user clicks the button when ready.
  const handleSendToScan = (items: Array<{
    jobId: string;
    outputAssetId: string;
    filename: string;
    outputUrl: string;
    provider?: string;
  }>) => {
    setEnhancedAssets((prev) => {
      // Duplicates are now allowed by design — the same source image
      // can land in Scan multiple times if the operator wants to scan
      // each provider's variant separately, or re-run a scan on the
      // same item. Filenames carry a provider suffix so the operator
      // can tell variants apart in the Scan tab list.
      const additions = items.map((it): PipelineAsset => ({
        assetId:      it.outputAssetId,
        filename:     providerSuffixedFilename(it.filename, it.provider),
        thumbnailUrl: it.outputUrl,
        outputUrl:    it.outputUrl,
        provider:     it.provider,
      }));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
    // Switch to the Scan tab so the user sees the result of their action.
    setActiveTab("scan");
  };

  // Called by EnhancePanel or ScanPanel when the user clicks their own
  // "Clear all" — wipes the downstream pipeline state at the workspace
  // level so old assets don't keep getting rescanned or re-listed.
  // Also bumps pipelineGeneration, which forces ScanPanel + ResizePanel
  // to remount with empty local state on the next render. Without that
  // remount their internal scanStates / preview lists would still show
  // ghost rows from the cleared batch.
  const handleClearPipeline = () => {
    setEnhancedAssets([]);
    setResizeAssets([]);
    setResizeResults([]);
    setPipelineGeneration((g) => g + 1);
  };

  // Explicit user action from the Scan tab. Mirror of handleSendToScan,
  // but feeds the resizeAssets pipeline + switches to the Resize tab.
  // Duplicates are intentionally allowed — the operator may want to
  // resize the same source image through multiple providers' variants
  // and download them all (filenames carry provider suffixes so the
  // ZIP entries are distinguishable).
  const handleSendToResize = (items: PipelineAsset[]) => {
    setResizeAssets((prev) => {
      return items.length > 0 ? [...prev, ...items] : prev;
    });
    setActiveTab("resize");
  };

  // Modify-tab Apply callback. The Modify panel takes the same
  // resizeAssets pool as the Resize tab and replaces each item with
  // the server-rendered modified version. Phase 1 is batch-only —
  // every asset gets the same brightness/contrast/saturation. We
  // overwrite resizeAssets wholesale (same length, same order) so
  // the Resize tab picks up the modified versions automatically.
  const handleModifyApplied = (next: PipelineAsset[]) => {
    setResizeAssets(next);
  };

  // Shortcut path: send straight from Enhance to Resize, skipping the
  // Scan tab entirely. Used by operators who already trust the
  // enhance output and just want to crop + export. Same shape /
  // provider-suffix logic as handleSendToScan — only the destination
  // tab differs.
  const handleEnhanceToResize = (items: Array<{
    jobId: string;
    outputAssetId: string;
    filename: string;
    outputUrl: string;
    provider?: string;
  }>) => {
    setResizeAssets((prev) => {
      const additions = items.map((it): PipelineAsset => ({
        assetId:      it.outputAssetId,
        filename:     providerSuffixedFilename(it.filename, it.provider),
        thumbnailUrl: it.outputUrl,
        outputUrl:    it.outputUrl,
        provider:     it.provider,
      }));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
    setActiveTab("resize");
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <Header
        bypassed={bypassed}
        isAdmin={isAdmin}
        autoAdvance={autoAdvance}
        onAutoAdvance={setAutoAdvance}
      />

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
                onSendToResize={handleEnhanceToResize}
                onClearPipeline={handleClearPipeline}
                autoAdvance={autoAdvance}
                onFileCountChange={setEnhanceFileCount}
              />
            )}
          </PanelSlot>

          <PanelSlot active={activeTab === "scan"}>
            {sessionId && (
              <ScanPanel
                // key bumps when handleClearPipeline runs, forcing a fresh
                // mount so internal scanStates/uploads don't outlive the
                // workspace queue clear.
                key={pipelineGeneration}
                sessionId={sessionId}
                enhancedAssets={enhancedAssets}
                onClearPipeline={handleClearPipeline}
                onSendToResize={handleSendToResize}
                autoAdvance={autoAdvance}
                equipmentType={meta.equipmentType ?? "forklift"}
              />
            )}
          </PanelSlot>

          <PanelSlot active={activeTab === "modify"}>
            {sessionId && (
              <ModifyPanel
                key={pipelineGeneration}
                sessionId={sessionId}
                resizeAssets={resizeAssets}
                onModifyApplied={handleModifyApplied}
              />
            )}
          </PanelSlot>

          <PanelSlot active={activeTab === "resize"}>
            {sessionId && (
              <ResizePanel
                // key bumps when handleClearPipeline runs — see ScanPanel above.
                key={pipelineGeneration}
                sessionId={sessionId}
                // ResizePanel's prop is named enhancedAssets for historic
                // reasons; semantically it now receives the curated
                // resizeAssets list (images user explicitly sent to Resize
                // from the Scan tab).
                enhancedAssets={resizeAssets}
                resizeResults={resizeResults}
                onResizeComplete={setResizeResults}
                onClearPipeline={handleClearPipeline}
                meta={meta}
                userEmail={userEmail}
              />
            )}
          </PanelSlot>

          <PanelSlot active={activeTab === "history"}>
            <HistoryList userEmail={userEmail} active={activeTab === "history"} />
          </PanelSlot>

          {!sessionId && !sessionError && activeTab !== "history" && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-6 py-12 text-center text-sm text-zinc-500">
              Starting a workspace session…
            </div>
          )}
        </div>
      </main>

      {/* App-wide attribution footer — intentionally low-contrast.
          Visible on every tab below the active panel content. */}
      <footer className="px-6 py-6 text-center">
        <p className="text-[10px] text-zinc-950 select-none">
          Developed by Stephen Cunningham © AI App Integrations LLC 2026
        </p>
      </footer>
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
