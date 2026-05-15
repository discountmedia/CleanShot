"use client";
// apps/web/components/resize/ResizePanel.tsx
//
// Resize tab — Phase 2 v2.5
//
// Per spec:
//   • Auto 7×5 aspect ratio (1024×731 px)
//   • Zoom-to-fill (crop NOT letterbox) — unit takes up most of frame
//   • Auto-crop so the forklift occupies most of frame
//   • Each image compressed to ≤99 kb JPEG
//
// This tab calls the backend's PRO export endpoint:
//   POST /api/v1/export/pro → pyvips crops to 1024×731, JPEG ≤100 kb
// The frontend polls for completion then fetches signed GET URLs.

import { useState } from "react";
import type { ResizeResult } from "../../lib/types";

async function requestProExport(params: {
  sessionId: string;
  assetIds: string[];
}): Promise<void> {
  const res = await fetch("/api/export/pro", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
}

// ─── Before/After card ────────────────────────────────────────────────────────

function ResizeCard({ result }: { result: ResizeResult }) {
  const [showOriginal, setShowOriginal] = useState(false);

  return (
    <article
      className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden"
      aria-label={`Resize result for ${result.filename}`}
    >
      {/* Image comparison */}
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={showOriginal ? result.originalUrl : result.signedUrl}
          alt={showOriginal ? `Original: ${result.filename}` : `Resized: ${result.filename}`}
          className="w-full object-cover"
          style={{ aspectRatio: "1024/731" }}
        />

        {/* Original/Result toggle */}
        <div className="absolute bottom-2 right-2 flex gap-1">
          <button
            onMouseDown={() => setShowOriginal(true)}
            onMouseUp={() => setShowOriginal(false)}
            onTouchStart={() => setShowOriginal(true)}
            onTouchEnd={() => setShowOriginal(false)}
            className="bg-black/70 hover:bg-black/90 text-white text-[11px] px-2 py-1 rounded border border-white/20 select-none"
            aria-label="Hold to see original"
          >
            Hold: Original
          </button>
        </div>

        {/* Spec badge */}
        <div className="absolute top-2 left-2 bg-black/70 text-green-400 text-[10px] font-mono px-2 py-0.5 rounded">
          1024×731 · ≤99 KB · 7:5
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-zinc-800">
        <p className="text-xs text-zinc-400 truncate">{result.filename}</p>
        <a
          href={result.signedUrl}
          download
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
          aria-label={`Download ${result.filename}`}
        >
          Download
        </a>
      </div>
    </article>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export interface ResizePanelProps {
  sessionId: string;
  enhancedAssets: Array<{ assetId: string; filename: string; thumbnailUrl: string }>;
  resizeResults: ResizeResult[];
  onResizeComplete: (results: ResizeResult[]) => void;
}

export function ResizePanel({
  sessionId,
  enhancedAssets,
  resizeResults,
  onResizeComplete,
}: ResizePanelProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError]               = useState<string | null>(null);

  const handleResize = async () => {
    if (enhancedAssets.length === 0) return;
    setError(null);
    setIsProcessing(true);

    try {
      await requestProExport({
        sessionId,
        assetIds: enhancedAssets.map((a) => a.assetId),
      });
      // Backend returns a ZIP or individual file; for the BFF route handler
      // we parse it and resolve signed URLs.
      // TODO: poll the export job and resolve signed URLs once backend wires up.
      // For now we show a success state.
      onResizeComplete([]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Resize failed";
      setError(msg);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-6">

      {/* Spec summary */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-2">
        <h3 className="text-sm font-semibold text-zinc-200">Resize Spec</h3>
        <ul className="text-xs text-zinc-400 space-y-1" role="list">
          <li>• <strong className="text-zinc-300">1024 × 731 px</strong> — 7:5 aspect ratio</li>
          <li>• <strong className="text-zinc-300">Zoom to fill</strong> — no letterboxing, smart-crop to subject</li>
          <li>• <strong className="text-zinc-300">≤ 99 KB</strong> per image — JPEG quality iterated to target</li>
          <li>• Forklift unit centred and maximised in frame</li>
        </ul>
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3" role="alert">
          {error}
        </p>
      )}

      {/* Process button */}
      {resizeResults.length === 0 && (
        <button
          onClick={handleResize}
          disabled={enhancedAssets.length === 0 || isProcessing}
          className={`
            w-full py-3 px-6 rounded-xl font-semibold text-sm transition-all
            ${enhancedAssets.length > 0 && !isProcessing
              ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40"
              : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}
          `}
        >
          {isProcessing
            ? "Resizing…"
            : enhancedAssets.length > 0
              ? `Resize ${enhancedAssets.length} Image${enhancedAssets.length !== 1 ? "s" : ""} to 1024×731`
              : "Enhance images first"}
        </button>
      )}

      {/* Results grid */}
      {resizeResults.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">
              {resizeResults.length} image{resizeResults.length !== 1 ? "s" : ""} resized
            </h3>
            <a
              href="/api/export/zip"
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
            >
              Download all as ZIP
            </a>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {resizeResults.map((r) => (
              <ResizeCard key={r.assetId} result={r} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
