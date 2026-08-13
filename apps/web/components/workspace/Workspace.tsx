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
import dynamic from "next/dynamic";

import { Header } from "./Header";
import { TabBar, type TabId } from "./TabBar";

// EnhancePanel is the default landing tab — keep it in the initial
// bundle so first paint never waits on a code-split chunk. The other
// four panels are code-split via next/dynamic, then additionally
// gated by `visitedTabs` (see useEffect below) so their JS chunks
// only fetch + mount when the operator first switches to that tab.
// Once a panel has been visited, it stays mounted across subsequent
// switches — same state-preservation semantics as the prior all-
// static design, but with a smaller initial JS payload.
// Real Experience Score fix 2026-05-27.
import { EnhancePanel } from "@/components/enhance/EnhancePanel";

// Each panel's loader is extracted so we can call it BOTH from the
// dynamic() wrapper (when the panel is actually rendered) AND from
// the TabBar prefetch hook (when the operator hovers/focuses the
// tab button, before they've committed to clicking). Webpack caches
// the import, so calling the loader twice is free — the first call
// queues the chunk download, the second is a no-op once resolved.
// Net effect: by the time the operator clicks a tab, the JS is
// often already parsed, eliminating the brief flash between click
// and panel-mount that the dynamic-import added.
const loadScanPanel    = () => import("@/components/scan/ScanPanel").then(m => ({ default: m.ScanPanel }));
const loadHistoryList  = () => import("@/components/history/HistoryList").then(m => ({ default: m.HistoryList }));

const ScanPanel    = dynamic(loadScanPanel,   { ssr: false });
const HistoryList  = dynamic(loadHistoryList, { ssr: false });

// TabBar hands tab id → prefetch loader. Enhance is intentionally
// missing (it's eagerly imported, no chunk to prefetch). Calling
// `loader()` schedules the chunk download with no other side effects;
// safe to invoke on every hover. Modify tab was removed 2026-06-01 —
// darkroom now lives inside Enhance below the variants grid. Resize tab
// was removed 2026-06-17 — Save + export now live inside Enhance and Scan
// (the ExportControls component).
const TAB_PREFETCH: Partial<Record<TabId, () => Promise<unknown>>> = {
  scan:    loadScanPanel,
  history: loadHistoryList,
};

import { createSession, exchangeHandoffToken, getSessionState } from "@/lib/api";
import {
  clearStoredSessionId,
  readHandoffToken,
  readStoredSessionId,
  stripHandoffToken,
  writeStoredSessionId,
  type HandoffFailureReason,
} from "@/lib/handoff";
import { getRestriction } from "@/lib/access-control";
import { AlertBanner } from "./AlertBanner";
import type { ForkliftMeta } from "@/lib/types";

/**
 * How the workspace acquired (or is acquiring) its session.
 *
 * The phase is decided ONCE, synchronously, in a lazy useState initializer
 * during the first render pass — not in an effect. There is then exactly one
 * session effect, which switches on this value. Two effects cannot race to
 * create a session because there is only one, so nothing depends on effect
 * ordering (which is not a contract).
 *
 *   "exchanging" — a handoff token was in the URL fragment on arrival; we're
 *                  trading it for the session ingest already created.
 *   "resuming"   — no token, but this tab has a stored session id. Reload after
 *                  an import: validate it, then hydrate from the server.
 *   "creating"   — neither. Normal cold load: mint an empty session. This path
 *                  is byte-for-byte today's behaviour.
 *   "ready"      — sessionId is known. Written EXACTLY ONCE, by whichever
 *                  branch won. There is never an interim session that gets
 *                  swapped out from under a mounted panel.
 *
 * PRECEDENCE: token beats stored id, unconditionally. An arriving import is an
 * explicit intent; a stored handle is ambient. A successful exchange overwrites
 * the stored id with the new session.
 *
 * HYDRATION CONSTRAINT: the initializer makes two client-only reads (the URL
 * fragment, then sessionStorage), so the server initialises to "creating" while
 * the client may initialise to "exchanging" or "resuming". That is only safe
 * because ALL THREE pre-ready phases render IDENTICAL markup — the same
 * existing "Starting a workspace session…" block. The phase changes what we
 * *do*, never what we *paint*, until "ready".
 *
 * ⚠ This constraint now binds THREE phases, not two. The next phase added here
 * is the one that will break it. If pre-ready import-specific copy is ever
 * wanted, the escape hatch is a post-mount flag — don't assume it's impossible,
 * but don't build it speculatively either.
 */
type SessionInit =
  | { phase: "exchanging"; token: string }
  | { phase: "resuming"; sessionId: string }
  | { phase: "creating" }
  | {
      phase: "ready";
      sessionId: string;
      handoffId?: string;
      expectedCount?: number;
      /**
       * True when this session pre-existed us (adopted via exchange, or resumed
       * from storage) and may therefore hold assets to hydrate. False for a
       * session we just minted — nothing to read, so no wasted round trip.
       */
      hydrate: boolean;
    };

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
  /**
   * Asset id of the ORIGINAL pre-enhance photo. Present for variants that
   * came from the Enhance tab; lets the Scan tab run a differential
   * (before/after) scan. Undefined for standalone uploads (nothing to
   * compare against — those get the isolated scan).
   */
  originalAssetId?: string;
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
  // Per-user access restriction (null = unrestricted). Active only when
  // the email is in lib/access-control's table — i.e. only when SSO is
  // on and the user is one of the locked-down accounts. Drives tab
  // gating here + the locked-model / disabled-toggles / custom-prompt-
  // only UI inside EnhancePanel. UI gating is cosmetic; the real model
  // lock is enforced server-side in /api/enhance.
  const restriction = getRestriction(userEmail);

  const [activeTab, setActiveTab] = useState<TabId>("enhance");

  // Tracks which tabs have been activated at least once. Used to gate
  // dynamic-imported panels' first mount — they don't show up until
  // the operator first switches to them, which saves the JS-chunk
  // download + initial-mount work on landing. Once a tab is in this
  // set it stays in it for the workspace's lifetime, so subsequent
  // switches behave identically to the prior all-mounted design
  // (panel state preserved across tab changes). Enhance is preseeded
  // because it's the default landing tab.
  // Real Experience Score fix 2026-05-27.
  const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(
    () => new Set<TabId>(["enhance"]),
  );
  useEffect(() => {
    setVisitedTabs((prev) => {
      if (prev.has(activeTab)) return prev;
      const next = new Set(prev);
      next.add(activeTab);
      return next;
    });
  }, [activeTab]);

  // Mirror of `files.length` inside EnhancePanel. Lifted so the
  // BatchContextStrip (which lives above the tab body, in Workspace) can
  // show the current batch size without having to live inside EnhancePanel.
  // Set via the `onFileCountChange` callback prop.
  const [enhanceFileCount, setEnhanceFileCount] = useState(0);

  // Bumped every time the cross-panel pipeline gets cleared (by
  // EnhancePanel's auto-reset on a new batch, by any tab's "Clear all"
  // button, etc.). Used as the React `key` on ScanPanel so it remounts
  // with fresh local state — otherwise its internal
  // scanStates / uploads / previewItems would survive the workspace
  // queue clear and the operator would still see ghost cards from the
  // previous batch.
  const [pipelineGeneration, setPipelineGeneration] = useState(0);

  // One session per workspace mount — either minted empty (normal load) or
  // adopted from a media-auditor handoff (import load). See SessionInit.
  //
  // The token read happens HERE, in the initializer, so the import-vs-normal
  // decision is made during the first render pass rather than in a second
  // effect that could race the session-creating one.
  const [init, setInit] = useState<SessionInit>(() => {
    const token = readHandoffToken();
    if (token) return { phase: "exchanging", token };
    const stored = readStoredSessionId();
    if (stored) return { phase: "resuming", sessionId: stored };
    return { phase: "creating" };
  });
  const [sessionError, setSessionError] = useState<string | null>(null);
  /**
   * Set when an import was attempted and did not come through. Purely
   * informational — the workspace is fully usable underneath it, because every
   * exchange failure degrades to a normal empty session rather than leaving the
   * operator behind a gate.
   */
  const [importFailure, setImportFailure] = useState<HandoffFailureReason | null>(null);

  // All the `{sessionId && <Panel …>}` gates below read this. Null until the
  // session is actually known, which is what keeps the pre-ready shell up.
  // NOTE: `handoffId` / `expectedCount` deliberately have no derived consts yet
  // — they live on `init` and get consumed by the session-read mapper and the
  // handoff poller (steps 3 and 4). Reading them from `init` at that point keeps
  // this diff free of unused locals.
  const sessionId = init.phase === "ready" ? init.sessionId : null;
  const shouldHydrate = init.phase === "ready" && init.hydrate;

  // Cross-panel pipeline state. The flow is curated by the user:
  //   Enhance → "Send to Scan" → enhancedAssets  (what Scan tab analyzes)
  // Save + export are no longer a separate tab — they live inside Enhance
  // and Scan (the ExportControls component), so there's no downstream
  // resize/export pipeline state to thread through Workspace anymore.
  const [enhancedAssets, setEnhancedAssets] = useState<PipelineAsset[]>([]);

  // Forklift metadata is owned by Workspace so it survives panel
  // switches and so Resize can pre-fill its Save Project form from
  // values the operator already entered on Enhance. Username falls out
  // of `userEmail` on the Resize tab (no separate state needed).
  const [meta, setMeta] = useState<Partial<ForkliftMeta>>({});

  /**
   * The ONE session effect. Switches on the phase decided during first render.
   *
   * Invariant: every path out of "exchanging" reaches a usable workspace —
   * either the import's session or a fresh empty one. The only way to end up
   * permanently gated is createSession() itself failing, which is exactly
   * today's `sessionError` behaviour, unchanged.
   */
  useEffect(() => {
    if (init.phase === "ready") return;

    let cancelled = false;

    /** Normal path + the tail of every degrade path. */
    const mintEmptySession = () =>
      createSession()
        .then(({ sessionId }) => {
          // Not stored: a freshly-minted empty session has nothing worth
          // resuming, and storing it would change today's behaviour (reload
          // currently gives you a clean workspace). Only sessions that hold
          // imports get a carrier.
          if (!cancelled) setInit({ phase: "ready", sessionId, hydrate: false });
        })
        .catch((err: Error) => {
          if (!cancelled) setSessionError(err.message);
        });

    if (init.phase === "creating") {
      void mintEmptySession();
      return () => {
        cancelled = true;
      };
    }

    if (init.phase === "resuming") {
      const storedId = init.sessionId;
      void (async () => {
        try {
          // The session read doubles as the validity probe — there is no cheaper
          // existence endpoint. A stale id from a purged session, or one whose
          // ownership check now refuses us, throws here.
          await getSessionState(storedId);
          if (cancelled) return;
          setInit({ phase: "ready", sessionId: storedId, hydrate: true });
        } catch {
          if (cancelled) return;
          // Expected case, NOT an exception worth surfacing: the stored handle
          // is stale. Clear it and start fresh, silently — deliberately no
          // importFailure notice, unlike a refused exchange.
          clearStoredSessionId();
          await mintEmptySession();
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // phase === "exchanging"
    const token = init.token;
    void (async () => {
      const result = await exchangeHandoffToken(token);
      if (cancelled) return;

      // Strip on BOTH outcomes. A dead token in the address bar is still a
      // token in the address bar, and it must not survive a back-navigation.
      stripHandoffToken();

      if (result.ok) {
        // Overwrite any ambient stored handle — the arriving import wins.
        writeStoredSessionId(result.sessionId);
        setInit({
          phase: "ready",
          sessionId: result.sessionId,
          handoffId: result.handoffId,
          expectedCount: result.expectedCount,
          hydrate: true,
        });
        return;
      }

      // Degrade: consumed-but-recoverable is handled server-side (the same
      // authenticated user re-presenting a spent token gets the session it
      // already created, which arrives here as ok:true). Everything that lands
      // in this branch is either terminally refused or unreachable, so fall
      // back to a normal empty session and say so.
      setImportFailure(result.reason);
      // Also drop any ambient stored handle. Without this the tab would show a
      // fresh empty session while sessionStorage still pointed at an older
      // imported one, so a reload would silently swap the workspace out from
      // under the operator. What you are looking at is what you get back.
      clearStoredSessionId();
      await mintEmptySession();
    })();

    return () => {
      cancelled = true;
    };
  }, [init]);

  const allTabs = [
    { id: "enhance" as const, label: "Enhance" },
    { id: "scan"    as const, label: "Scan",    count: enhancedAssets.length || undefined },
    { id: "history" as const, label: "Your Photo Library" },
  ];
  // Restricted users see only the Enhance tab.
  const tabs = restriction?.enhanceOnly
    ? allTabs.filter((t) => t.id === "enhance")
    : allTabs;

  // Safety net: if a restricted user somehow lands on a non-Enhance tab
  // (stale state, deep link), force them back to Enhance.
  useEffect(() => {
    if (restriction?.enhanceOnly && activeTab !== "enhance") {
      setActiveTab("enhance");
    }
  }, [restriction?.enhanceOnly, activeTab]);

  // Explicit user action: "Send to Scan" (per-row) or "Send all to Scan tab"
  // (batch). Auto-handoff was removed at the user's request — enhance completion
  // alone does NOT push to Scan; the user clicks the button when ready.
  const handleSendToScan = (items: Array<{
    jobId: string;
    outputAssetId: string;
    filename: string;
    outputUrl: string;
    provider?: string;
    sourceAssetId?: string;
  }>) => {
    setEnhancedAssets((prev) => {
      // Duplicates are now allowed by design — the same source image
      // can land in Scan multiple times if the operator wants to scan
      // each provider's variant separately, or re-run a scan on the
      // same item. Filenames carry a provider suffix so the operator
      // can tell variants apart in the Scan tab list.
      const additions = items.map((it): PipelineAsset => ({
        assetId:         it.outputAssetId,
        filename:        providerSuffixedFilename(it.filename, it.provider),
        thumbnailUrl:    it.outputUrl,
        outputUrl:       it.outputUrl,
        provider:        it.provider,
        originalAssetId: it.sourceAssetId,
      }));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
    // Switch to the Scan tab so the user sees the result of their action.
    setActiveTab("scan");
  };

  // Called by EnhancePanel or ScanPanel when the user clicks their own
  // "Clear all" — wipes the downstream pipeline state at the workspace
  // level so old assets don't keep getting rescanned or re-listed.
  // Also bumps pipelineGeneration, which forces ScanPanel to remount with
  // empty local state on the next render. Without that remount its internal
  // scanStates / preview lists would still show ghost rows from the
  // cleared batch.
  const handleClearPipeline = () => {
    setEnhancedAssets([]);
    setPipelineGeneration((g) => g + 1);
  };

  /**
   * Explicit "Clear all" only — NOT the automatic post-batch reset, which
   * deliberately keeps imports.
   *
   * Drops the stored session handle so a reload doesn't resurrect the imports
   * the operator just told us to get rid of. The session itself stays on the
   * server (assets are permanent); we simply stop remembering it, which puts
   * this tab back to normal cold-load behaviour.
   */
  const handleDiscardSession = () => {
    clearStoredSessionId();
  };

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <Header
        bypassed={bypassed}
        isAdmin={isAdmin}
      />

      {/* Tab bar */}
      <TabBar
        tabs={tabs}
        active={activeTab}
        onChange={setActiveTab}
        onPrefetch={(id) => { TAB_PREFETCH[id]?.(); }}
      />

      {/* Body */}
      <main className="flex-1 px-6 py-6 space-y-6 max-w-screen-2xl w-full mx-auto">
        {sessionError && (
          <div className="rounded-xl border border-attn bg-panel px-4 py-3 text-sm text-attn">
            Could not start a workspace session: {sessionError}
          </div>
        )}

        {/* Import degrade notice. The workspace below this is fully usable — an
            empty session was minted instead. Dismissible; never blocking. */}
        {importFailure && (
          <AlertBanner
            severity="warn"
            title={
              importFailure === "rejected"
                ? "Your photo import didn't come through"
                : "Couldn't reach the import service"
            }
            body={
              importFailure === "rejected"
                ? "The import link has expired or belongs to a different account. Started a fresh workspace instead — send the photos over again from the unit page."
                : "We couldn't confirm your import, so we started a fresh workspace. If the photos don't show up, send them over again from the unit page."
            }
          />
        )}

        {/* Active panel — panels stay mounted to preserve in-progress state
            across tab switches; only the active one is visible. */}
        <div className="relative">
          <PanelSlot active={activeTab === "enhance"}>
            {sessionId && (
              <EnhancePanel
                sessionId={sessionId}
                hydrateImports={shouldHydrate}
                meta={meta}
                onMetaChange={setMeta}
                onSendToScan={handleSendToScan}
                onClearPipeline={handleClearPipeline}
                onDiscardSession={handleDiscardSession}
                onFileCountChange={setEnhanceFileCount}
                userEmail={userEmail}
                restriction={restriction}
              />
            )}
          </PanelSlot>

          <PanelSlot active={activeTab === "scan"}>
            {sessionId && visitedTabs.has("scan") && (
              <ScanPanel
                // key bumps when handleClearPipeline runs, forcing a fresh
                // mount so internal scanStates/uploads don't outlive the
                // workspace queue clear.
                key={pipelineGeneration}
                sessionId={sessionId}
                enhancedAssets={enhancedAssets}
                onClearPipeline={handleClearPipeline}
                equipmentType={meta.equipmentType ?? "forklift"}
                meta={meta}
                onMetaChange={setMeta}
                userEmail={userEmail}
              />
            )}
          </PanelSlot>

          {/* Modify tab removed 2026-06-01 — darkroom relocated inside
              EnhancePanel below the variants grid. Resize tab removed
              2026-06-17 — Save + export now live inside Enhance and Scan
              (ExportControls). */}

          <PanelSlot active={activeTab === "history"}>
            {visitedTabs.has("history") && (
              <HistoryList userEmail={userEmail} active={activeTab === "history"} />
            )}
          </PanelSlot>

          {!sessionId && !sessionError && activeTab !== "history" && (
            <div className="rounded-xl border border-line bg-well/60 px-6 py-12 text-center text-sm text-ink-faint">
              Starting a workspace session…
            </div>
          )}
        </div>
      </main>

      {/* App-wide attribution footer — intentionally low-contrast.
          Visible on every tab below the active panel content. */}
      <footer className="px-6 py-6 text-center">
        <p className="text-[10px] text-header-bg select-none">
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
