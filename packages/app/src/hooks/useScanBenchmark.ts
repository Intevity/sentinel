import { useCallback, useState } from 'react';
import type { SecurityBenchmarkResult } from '@sentinel/shared';
import { sendToSentinel } from '../lib/ipc.js';

interface UseScanBenchmarkResult {
  /** True while the daemon's `run_scan_benchmark` IPC is in flight.
   *  Drives the spinner / "Benchmarking…" UI state. */
  running: boolean;
  /** Error message from the last attempt, or null. Cleared when a
   *  fresh run starts. */
  error: string | null;
  /** Fire the benchmark. Resolves with the measured result (which
   *  the daemon also persists to Settings.lastScanBenchmark) or
   *  rejects with an Error. Safe to call while already running —
   *  the hook guards with the `running` flag. */
  run: () => Promise<SecurityBenchmarkResult | null>;
}

/**
 * Trigger the scanner's in-daemon benchmark and track its state.
 *
 * The daemon blocks for 2–5 seconds while running, then returns
 * per-size timings. We don't cache the result here — the daemon
 * persists it into Settings.lastScanBenchmark and the rest of the
 * UI reads it via useSettings(). Keeping the "source of truth" on
 * Settings avoids two views disagreeing after a restart.
 */
export function useScanBenchmark(): UseScanBenchmarkResult {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (): Promise<SecurityBenchmarkResult | null> => {
    if (running) return null;
    setRunning(true);
    setError(null);
    try {
      const res = await sendToSentinel<SecurityBenchmarkResult>({
        type: 'run_scan_benchmark',
      });
      if (!res.success) {
        setError(res.error ?? 'Benchmark failed');
        return null;
      }
      return res.data ?? null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setRunning(false);
    }
  }, [running]);

  return { running, error, run };
}
