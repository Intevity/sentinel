import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEntry } from '@claude-sentinel/shared';
import { onDaemonMessage, sendToSentinel } from '../lib/ipc.js';

const STORAGE_KEY = 'sentinel.lastSeenErrorSeq';
// Hold the 20 most recent error entries — matches the cap we include in
// the pre-filled GitHub issue body.
const KEEP = 20;

function readLastSeen(): number {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return 0;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeLastSeen(seq: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(seq));
  } catch {
    // localStorage disabled / full — degrade to in-memory only.
  }
}

export interface UseDaemonErrorsResult {
  recentErrors: LogEntry[];
  hasUnseenErrors: boolean;
  markErrorsSeen: () => void;
}

export function useDaemonErrors(): UseDaemonErrorsResult {
  const [recentErrors, setRecentErrors] = useState<LogEntry[]>([]);
  const [lastSeen, setLastSeen] = useState<number>(() => readLastSeen());
  // Deduplicate across history seed + broadcast batches. Daemon seq resets
  // to 0 on restart — we detect that and reset our merge state so we don't
  // orphan the entire list behind a stale high-water mark.
  const highestSeqRef = useRef<number>(0);

  const ingest = useCallback((entries: LogEntry[]): void => {
    if (entries.length === 0) return;
    const errors = entries.filter((e) => e.level === 'error');
    if (errors.length === 0) return;
    setRecentErrors((prev) => {
      // Detect daemon restart: a new entry's seq is less than what we've
      // already seen. Drop the existing merged list and re-seed from the
      // fresh batch so stale high-seq entries don't hide new errors.
      const minIncoming = errors[0]!.seq;
      const rolled = minIncoming < highestSeqRef.current;
      const base = rolled ? [] : prev;
      if (rolled) highestSeqRef.current = 0;
      const seen = new Set(base.map((e) => e.seq));
      const merged = [...base];
      for (const e of errors) {
        if (!seen.has(e.seq)) {
          merged.push(e);
          seen.add(e.seq);
          if (e.seq > highestSeqRef.current) highestSeqRef.current = e.seq;
        }
      }
      merged.sort((a, b) => a.seq - b.seq);
      return merged.slice(-KEEP);
    });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const seed = async (): Promise<void> => {
      try {
        const res = await sendToSentinel<LogEntry[]>({ type: 'get_daemon_logs' });
        if (cancelled) return;
        if (res.success && res.data) ingest(res.data);
      } catch {
        // Daemon may not be up yet; the broadcast subscription below will
        // catch up once it connects.
      }
    };

    void seed();

    onDaemonMessage((msg) => {
      if (msg.type === 'daemon_log' && msg.entries) {
        ingest(msg.entries);
      } else if (msg.type === 'daemon_logs_cleared') {
        setRecentErrors([]);
        highestSeqRef.current = 0;
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [ingest]);

  const latestSeq = recentErrors.length > 0 ? recentErrors[recentErrors.length - 1]!.seq : 0;
  const hasUnseenErrors = latestSeq > lastSeen;

  const markErrorsSeen = useCallback((): void => {
    setLastSeen((prev) => {
      if (latestSeq <= prev) return prev;
      writeLastSeen(latestSeq);
      return latestSeq;
    });
  }, [latestSeq]);

  return { recentErrors, hasUnseenErrors, markErrorsSeen };
}
