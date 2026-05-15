"use client";
// apps/web/lib/polling.ts
// Adaptive polling hook — intervals match Phase 2 v2.5 Tier 1 IPM reality.
// 3s while processing, 10s while queued (matches dispatch rate), 15s after 2 min.

import { useCallback, useEffect, useRef } from "react";
import { pollJob } from "./api";
import type { JobRecord } from "./types";

const ACTIVE_MS  = 3_000;   // job is processing
const QUEUED_MS  = 10_000;  // job is queued (matches Cloud Tasks 0.1 dps)
const SLOW_MS    = 15_000;  // >2 min elapsed (large batch cleanup)
const ERROR_MS   = 5_000;   // network error — retry delay

export function useJobPoller(
  jobId: string | null,
  onUpdate:   (job: JobRecord) => void,
  onComplete: (job: JobRecord) => void,
  onError:    (job: JobRecord) => void
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<number>(Date.now());
  const abortRef = useRef<AbortController | null>(null);

  const poll = useCallback(async () => {
    if (!jobId) return;

    abortRef.current = new AbortController();

    try {
      const job = await pollJob(jobId, abortRef.current.signal);
      onUpdate(job);

      if (job.status === "complete")   { onComplete(job); return; }
      if (job.status === "failed")     { onError(job);    return; }
      if (job.status === "cancelled")  { onError(job);    return; }

      const elapsed = Date.now() - startRef.current;
      const interval =
        elapsed > 120_000    ? SLOW_MS   :
        job.status === "queued" ? QUEUED_MS :
                                  ACTIVE_MS;

      timerRef.current = setTimeout(poll, interval);
    } catch (err: unknown) {
      // AbortError = component unmounted; don't retry
      if (err instanceof Error && err.name === "AbortError") return;
      timerRef.current = setTimeout(poll, ERROR_MS);
    }
  }, [jobId, onUpdate, onComplete, onError]);

  useEffect(() => {
    if (!jobId) return;
    startRef.current = Date.now();
    poll();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [jobId, poll]);
}
