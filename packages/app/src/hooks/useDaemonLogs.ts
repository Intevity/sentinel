import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEntry } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

/** Frontend in-memory cap. Larger than the daemon's ring buffer (2000) so a
 *  burst-plus-reconnect cycle can't race-truncate entries the user was about
 *  to read. Oldest entries drop when the cap is exceeded. */
const MAX_ENTRIES = 5000;

/** Matches the poll cadence used by useSettings / useDaemon while waiting for
 *  the daemon socket to come up at startup. */
const STARTUP_RETRY_MS = 500;

export interface UseDaemonLogsResult {
  entries: LogEntry[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  clearLogs: () => Promise<void>;
}

/**
 * Load the daemon's log ring buffer on mount, stay in sync via `daemon_log`
 * broadcasts, and expose clear/refetch mutations. Detects daemon-restart by
 * watching for a seq rollback and resets local state when it happens so the
 * UI never shows stale entries mixed with a fresh daemon's sequence.
 */
export function useDaemonLogs(): UseDaemonLogsResult {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track seen seq values for O(1) dedupe on overlapping history+broadcast.
  const seenSeqs = useRef<Set<number>>(new Set());

  const applyBatch = useCallback((incoming: LogEntry[]): void => {
    if (incoming.length === 0) return;
    setEntries((prev) => {
      const firstIncomingSeq = incoming[0]!.seq;
      const lastKnownSeq = prev.length > 0 ? prev[prev.length - 1]!.seq : -1;
      // Daemon restart: seq counter reset below our watermark. Drop local
      // state rather than merging apples with oranges.
      const resetDetected = firstIncomingSeq < lastKnownSeq && firstIncomingSeq === 0;
      const base = resetDetected ? [] : prev;
      if (resetDetected) seenSeqs.current.clear();

      // Build the new entries slice first; if everything was already known,
      // bail without allocating a new array so React skips the re-render.
      const fresh: LogEntry[] = [];
      for (const entry of incoming) {
        if (seenSeqs.current.has(entry.seq)) continue;
        seenSeqs.current.add(entry.seq);
        fresh.push(entry);
      }
      if (!resetDetected && fresh.length === 0) return prev;
      const merged = base.concat(fresh);
      // Cap at MAX_ENTRIES keeping the most recent; prune the seq set in step.
      if (merged.length > MAX_ENTRIES) {
        const trimmed = merged.slice(merged.length - MAX_ENTRIES);
        seenSeqs.current = new Set(trimmed.map((e) => e.seq));
        return trimmed;
      }
      return merged;
    });
  }, []);

  const refetch = useCallback(async (): Promise<void> => {
    const res = await sendToSentinel<LogEntry[]>({ type: 'get_daemon_logs' });
    if (res.success && res.data) {
      // On explicit refetch, replace state rather than merge.
      seenSeqs.current = new Set(res.data.map((e) => e.seq));
      setEntries(res.data);
      setError(null);
    } else {
      throw new Error(res.error ?? 'get_daemon_logs failed');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attempt = async (): Promise<void> => {
      if (cancelled) return;
      try {
        await refetch();
        if (cancelled) return;
        setLoading(false);
        return;
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
      if (cancelled) return;
      timer = setTimeout(() => { void attempt(); }, STARTUP_RETRY_MS);
    };

    void attempt();

    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'daemon_log') {
        applyBatch(msg.entries);
      } else if (msg.type === 'daemon_logs_cleared') {
        seenSeqs.current.clear();
        setEntries([]);
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [refetch, applyBatch]);

  const clearLogs = useCallback(async (): Promise<void> => {
    const res = await sendToSentinel({ type: 'clear_daemon_logs' });
    if (!res.success) throw new Error(res.error ?? 'clear_daemon_logs failed');
    // The broadcast echo also empties state; this is the explicit local clear.
    seenSeqs.current.clear();
    setEntries([]);
  }, []);

  return { entries, loading, error, refetch, clearLogs };
}
