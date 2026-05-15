"use client";
// apps/web/components/scan/ApproveAllButton.tsx
//
// "Approve All" button on the Scan tab.
//
// On click:
//   1. POST /api/approvals  → FastAPI saves all scan-tab images to
//      GCS path: approved/{email}/{YYYY-MM-DD}_{make}_{model}/{filename}
//      and creates an approval_set row in Postgres.
//   2. On success → calls onApproved() which moves images to the Resize tab.
//
// The backend associates the approval set with the authenticated user's email
// (read from the Better Auth session via X-Api-Key + session cookie forwarded).

import { useState } from "react";
import type { ImageScanState } from "@/lib/types";

interface ApproveAllButtonProps {
  sessionId: string;
  scanStates: ImageScanState[];
  projectMeta: {
    make: string;
    model: string;
    year: string;
  };
  onApproved: (approvalSetId: string) => void;
  disabled?: boolean;
}

export function ApproveAllButton({
  sessionId,
  scanStates,
  projectMeta,
  onApproved,
  disabled = false,
}: ApproveAllButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const handleApprove = async () => {
    if (scanStates.length === 0) return;
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          assetIds: scanStates.map((s) => s.assetId),
          projectMeta: {
            make:  projectMeta.make  || "unknown",
            model: projectMeta.model || "unknown",
            year:  projectMeta.year  || "",
          },
        }),
        cache: "no-store",
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `Approval failed (${res.status})`);
      }

      const { approvalSetId } = await res.json();
      onApproved(approvalSetId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Approval failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        onClick={handleApprove}
        disabled={disabled || loading || scanStates.length === 0}
        className={`
          w-full py-3 px-6 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2
          ${!disabled && !loading && scanStates.length > 0
            ? "bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-900/40"
            : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}
        `}
        aria-busy={loading}
      >
        {loading ? (
          <>
            <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            Saving to your library…
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Approve All & Send to Resize
            {scanStates.length > 0 && (
              <span className="bg-green-800/60 text-green-300 text-xs px-2 py-0.5 rounded-full">
                {scanStates.length}
              </span>
            )}
          </>
        )}
      </button>

      {error && (
        <p className="text-xs text-red-400 text-center" role="alert">{error}</p>
      )}
    </div>
  );
}
