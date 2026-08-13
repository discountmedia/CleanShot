"use client";
// apps/web/lib/useHandoffPoller.ts
// Progress poller for a media-auditor photo import.
//
// Deliberately NOT built on useJobPoller. That hook is load-bearing for every
// enhance variant and has no total-duration cap — it loops until terminal or
// unmount, which is correct for a job the user is watching but wrong for an
// import that can silently stop producing. Growing a timeout into it would
// change behaviour for the enhance path too. So: separate hook.
//
// This poller does NOT own grid state. Its whole job is to say "re-read now" as
// photos land, and to go terminal. The session read is the authoritative source
// for what exists — see lib/import-hydrate. That split is what lets hydration
// work on a reload with no handoff at all.

import { useEffect, useRef, useState } from "react";

import { getHandoffStatus } from "./api";
import type { HandoffStatus } from "./import-hydrate";

// Copies are an HTTP GET plus a GCS write — a couple of seconds each, dispatched
// at 10/s. Poll fast enough that photos visibly trickle in.
const TICK_MS = 2_000;
// One retry cadence for a transient blip. Distinct from TICK_MS so a degraded
// upstream doesn't get hammered at the same rate as a healthy one.
const ERROR_TICK_MS = 5_000;
/**
 * Total wall-clock cap. Past this we stop and surface it rather than polling a
 * stalled import forever.
 *
 * 5 minutes is generous for the realistic worst case (150 photos, the schema
 * cap, at 10 dispatches/second with retries) and PICKED, NOT MEASURED — nobody
 * has watched a real import yet. Revisit after the first prod run.
 */
const MAX_DURATION_MS = 5 * 60_000;
/** Consecutive transient failures before we give up and surface it. */
const MAX_CONSECUTIVE_ERRORS = 3;

export type HandoffPollOutcome =
  /** Every photo reached a terminal state. Normal finish. */
  | "complete"
  /** Hit MAX_DURATION_MS with photos still pending. */
  | "timeout"
  /** The status endpoint kept failing, or the handoff is gone (404). */
  | "unavailable";

export interface HandoffProgress {
  status: HandoffStatus | null;
  /** Set once polling has stopped. Null while still in flight. */
  outcome: HandoffPollOutcome | null;
}

/**
 * Poll one handoff until terminal.
 *
 * @param handoffId  null disables the poller entirely (no import in play).
 * @param onProgress Called on every response whose landed-count CHANGED, and
 *                   once more when polling stops. This is the "re-read now"
 *                   signal — the callback should re-read the session, not trust
 *                   this hook for asset data.
 */
export function useHandoffPoller(
  handoffId: string | null,
  onProgress: (status: HandoffStatus, outcome: HandoffPollOutcome | null) => void,
): HandoffProgress {
  const [progress, setProgress] = useState<HandoffProgress>({
    status: null,
    outcome: null,
  });

  // Same ref-stashing pattern useJobPoller uses, for the same reason: callers
  // pass inline arrows, so depending on the callback identity would restart the
  // loop on every render while the previous one was still mid-flight.
  const cbRef = useRef(onProgress);
  useEffect(() => {
    cbRef.current = onProgress;
  });

  useEffect(() => {
    if (!handoffId) return;

    const abort = new AbortController();
    let cancelled = false;
    // Wall-clock start captured here, in an effect rather than at component
    // scope — Date.now() in a component-scoped callback trips React Compiler's
    // purity rule (hard-won lesson #9).
    const startedAt = Date.now();
    let consecutiveErrors = 0;
    let lastLandedCount = -1;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        abort.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });

    const stop = (status: HandoffStatus | null, outcome: HandoffPollOutcome) => {
      if (cancelled) return;
      setProgress({ status, outcome });
      if (status) cbRef.current(status, outcome);
    };

    void (async () => {
      while (!cancelled) {
        let status: HandoffStatus;
        try {
          status = await getHandoffStatus(handoffId, abort.signal);
          consecutiveErrors = 0;
        } catch {
          if (cancelled) return;
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            // No status object to hand back — the caller keeps whatever the
            // last successful read produced, so landed photos stay on screen.
            setProgress((p) => ({ ...p, outcome: "unavailable" }));
            return;
          }
          await sleep(ERROR_TICK_MS);
          continue;
        }
        if (cancelled) return;

        const landed = status.statusCounts.landed ?? 0;

        // Re-read only when something actually changed. Without this the grid
        // would re-mint a signed URL per asset every 2 seconds for the whole
        // import.
        if (landed !== lastLandedCount) {
          lastLandedCount = landed;
          setProgress({ status, outcome: null });
          cbRef.current(status, null);
        }

        if (status.complete) {
          // Terminal. Note this is reachable with failures present — 'complete'
          // means nothing is still pending, not that everything succeeded. That
          // is what stops a failed copy spinning forever.
          stop(status, "complete");
          return;
        }

        if (Date.now() - startedAt > MAX_DURATION_MS) {
          stop(status, "timeout");
          return;
        }

        await sleep(TICK_MS);
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [handoffId]);

  return progress;
}
