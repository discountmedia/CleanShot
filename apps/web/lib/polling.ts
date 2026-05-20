"use client";
// apps/web/lib/polling.ts
// Adaptive polling hook — intervals match Phase 2 v2.5 Tier 1 IPM reality.
// 3s while processing, 10s while queued (matches dispatch rate), 15s after 2 min.

import { useEffect, useRef } from "react";
import { pollJob } from "./api";
import type { JobRecord } from "./types";

const ACTIVE_MS  = 3_000;   // job is processing
const QUEUED_MS  = 10_000;  // job is queued (matches Cloud Tasks 0.1 dps)
const SLOW_MS    = 15_000;  // >2 min elapsed (large batch cleanup)
const ERROR_MS   = 5_000;   // network error — retry delay

/**
 * Adaptive poller. Callers usually pass inline arrow functions (e.g.
 * `(j) => setJob(j)`) which get fresh identities on every render — if
 * those identities were in the effect's deps array, the effect would
 * re-run on every render and spin up a fresh poll loop while the old
 * one was still mid-flight. We've seen that bug manifest as doubled
 * polls in the access logs and jobs that never visually transition
 * from "processing" because each render kept restarting the loop
 * before the old one could call `onComplete`.
 *
 * To stay robust we stash the callbacks in a ref and depend only on
 * `jobId`. The ref is updated on every render so the loop always
 * sees the latest closures, but the effect itself never re-runs
 * mid-poll.
 */
export function useJobPoller(
  jobId: string | null,
  onUpdate:   (job: JobRecord) => void,
  onComplete: (job: JobRecord) => void,
  onError:    (job: JobRecord) => void
) {
  const cbRef = useRef({ onUpdate, onComplete, onError });
  // Refresh the latest callbacks after each render. Doing this in an
  // effect (not during render) satisfies React Compiler's purity rule.
  // Polls fire seconds apart, so the one-frame lag vs. assigning during
  // render is irrelevant in practice.
  useEffect(() => {
    cbRef.current = { onUpdate, onComplete, onError };
  });

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
          const { onUpdate, onComplete, onError } = cbRef.current;
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
  }, [jobId]);
}
