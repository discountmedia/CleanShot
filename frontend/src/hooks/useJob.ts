// =============================================================================
//  useJob — polls GET /jobs/{id} every 2s until terminal status (done | failed)
//
//  Used by Enhance and Resize tabs. NOT used by Scan, which is now synchronous
//  (see useScan).
// =============================================================================

import { useEffect, useState, useRef } from 'react';
import { api } from '../lib/api';
import type { JobStatusResponse, JobStatus } from '../lib/types';

interface UseJobResult {
  job: JobStatusResponse | null;
  status: JobStatus;
  progress: number;
  message: string;
  error: string | null;
  isTerminal: boolean;
}

const POLL_INTERVAL_MS = 2000;

export function useJob(job_id: string | null): UseJobResult {
  const [job, setJob] = useState<JobStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!job_id) {
      setJob(null);
      setError(null);
      return;
    }

    let cancelled = false;

    const tick = async () => {
      try {
        const response = await api.getJob(job_id);
        if (cancelled) return;
        setJob(response);

        if (response.status === 'done' || response.status === 'failed') {
          if (intervalRef.current !== null) {
            window.clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        if (intervalRef.current !== null) {
          window.clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    };

    // Fire immediately, then on interval
    tick();
    intervalRef.current = window.setInterval(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [job_id]);

  return {
    job,
    status: job?.status ?? 'queued',
    progress: job?.progress ?? 0,
    message: job?.message ?? '',
    error,
    isTerminal: job?.status === 'done' || job?.status === 'failed',
  };
}
