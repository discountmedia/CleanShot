/**
 * useJobPolling — poll GET /api/v1/jobs/{id} every 2 seconds.
 *
 * Per Phase 3 v3.4 design: polling, not SSE. Polling is debuggable in
 * DevTools, survives mobile network drops cleanly, and avoids Cloud Run's
 * long-stream timeout edge cases past 15 minutes.
 *
 * The hook stops polling automatically when the job reaches a terminal
 * state (succeeded | failed). It also stops on unmount and on a fresh
 * job_id change (which resets state).
 *
 * Cadence: 2 seconds for both Enhance and Scan jobs. Scan jobs typically
 * take 10–25s (waiting on the slowest of three providers); a 2s cadence
 * shows progress without hammering the API.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { getJob } from "./api";
import type { Job } from "./types";

export type PollingState = {
  job: Job | null;
  error: string | null;
  isPolling: boolean;
};

const POLL_INTERVAL_MS = 2000;

export function useJobPolling(job_id: string | null): PollingState {
  const [state, setState] = useState<PollingState>({
    job: null,
    error: null,
    isPolling: false,
  });

  // Use a ref to hold the abort controller so the effect cleanup can cancel
  // an in-flight fetch without racing with React's render cycle.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!job_id) {
      setState({ job: null, error: null, isPolling: false });
      return;
    }

    let cancelled = false;
    setState({ job: null, error: null, isPolling: true });

    async function tick() {
      if (cancelled || !job_id) return;
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const job = await getJob(job_id, ac.signal);
        if (cancelled) return;
        setState({ job, error: null, isPolling: !isTerminal(job.status) });
        if (!isTerminal(job.status)) {
          window.setTimeout(tick, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        // AbortError is expected on cleanup — don't surface it
        if (err instanceof DOMException && err.name === "AbortError") return;
        const msg = err instanceof Error ? err.message : "poll_failed";
        setState((prev) => ({ ...prev, error: msg, isPolling: false }));
      }
    }

    void tick();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [job_id]);

  return state;
}

function isTerminal(status: Job["status"]): boolean {
  return status === "succeeded" || status === "failed";
}
