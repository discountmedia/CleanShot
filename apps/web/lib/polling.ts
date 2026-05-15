"use client";
// apps/web/lib/polling.ts
// Adaptive polling hook — intervals match Phase 2 v2.5 Tier 1 IPM reality.
// 3s while processing, 10s while queued (matches dispatch rate), 15s after 2 min.

import { useEffect } from "react";
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
  useEffect(() => {
    if (!jobId) return;

    const abort = new AbortController();
    const start = Date.now();
    let cancelled = false;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        abort.signal.addEventListener(
          "abort",
          () => { clearTimeout(t); resolve(); },
          { once: true }
        );
      });

    (async () => {
      while (!cancelled) {
        try {
          const job = await pollJob(jobId, abort.signal);
          if (cancelled) return;
          onUpdate(job);

          if (job.status === "complete")  { onComplete(job); return; }
          if (job.status === "failed")    { onError(job);    return; }
          if (job.status === "cancelled") { onError(job);    return; }

          const elapsed = Date.now() - start;
          const interval =
            elapsed > 120_000       ? SLOW_MS   :
            job.status === "queued" ? QUEUED_MS :
                                      ACTIVE_MS;
          await sleep(interval);
        } catch (err: unknown) {
          // AbortError = component unmounted; don't retry
          if (err instanceof Error && err.name === "AbortError") return;
          await sleep(ERROR_MS);
        }
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [jobId, onUpdate, onComplete, onError]);
}
