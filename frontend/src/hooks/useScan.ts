// =============================================================================
//  useScan — synchronous multi-provider scan.
//
//  Calls POST /scan and awaits the merged result. Typical wall-clock 6-25s.
//  Returns a runScan() function plus state for the loading/result/error
//  tristate. The frontend should show a "Calling Gemini + OpenAI + Anthropic"
//  pending indicator while pending=true.
// =============================================================================

import { useCallback, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import type { ScanResult } from '../lib/types';

interface UseScanResult {
  runScan: (asset_id: string) => Promise<void>;
  pending: boolean;
  result: ScanResult | null;
  error: string | null;
  reset: () => void;
}

export function useScan(): UseScanResult {
  const session_id = useStore((s) => s.session_id);
  const setScanJob = useStore((s) => s.setScanJob);

  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runScan = useCallback(
    async (asset_id: string) => {
      if (!session_id) {
        setError('No active session — upload an image first.');
        return;
      }

      setPending(true);
      setResult(null);
      setError(null);
      setScanJob(asset_id, { asset_id, pending: true });

      try {
        const scan = await api.postScan(session_id, asset_id);
        setResult(scan);
        setScanJob(asset_id, { asset_id, pending: false, result: scan });
      } catch (err) {
        const msg = err instanceof ApiError ? err.detail : String(err);
        setError(msg);
        setScanJob(asset_id, { asset_id, pending: false, error: msg });
      } finally {
        setPending(false);
      }
    },
    [session_id, setScanJob],
  );

  const reset = useCallback(() => {
    setPending(false);
    setResult(null);
    setError(null);
  }, []);

  return { runScan, pending, result, error, reset };
}
