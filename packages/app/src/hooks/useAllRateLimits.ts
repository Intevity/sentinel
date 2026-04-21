import { useCallback, useEffect, useState } from 'react';
import type { RateLimitWindow } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

type AllRateLimits = Record<string, RateLimitWindow[]>;

/**
 * Snapshot every account's rate-limit windows, keyed by Sentinel accountId.
 * Used by the Accounts tab to render a discrete 5h utilization indicator on
 * each account pill without having to switch accounts first.
 *
 * Stays in sync via `rate_limits_updated` / `account_switched` broadcasts.
 * No polling — the daemon only has fresh data after an API call, so the
 * indicator is intentionally best-effort.
 */
export function useAllRateLimits(): {
  byAccount: AllRateLimits;
  refetch: () => Promise<{ ok: boolean; error?: string }>;
} {
  const [byAccount, setByAccount] = useState<AllRateLimits>({});

  const refetch = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await sendToSentinel<AllRateLimits>({ type: 'get_all_rate_limits' });
      if (res.success) {
        setByAccount(res.data ?? {});
        return { ok: true };
      }
      return { ok: false, error: res.error ?? 'Refresh failed' };
    } catch (err) {
      // Keep the state update path non-fatal — the indicator just won't show.
      // The caller still gets the error so refresh-button feedback is truthful.
      return { ok: false, error: err instanceof Error ? err.message : 'Refresh failed' };
    }
  }, []);

  useEffect(() => {
    void refetch();
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (
        msg.type === 'rate_limits_updated' ||
        msg.type === 'account_switched' ||
        msg.type === 'login_complete'
      ) {
        void refetch();
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [refetch]);

  return { byAccount, refetch };
}

/**
 * Extract the 5-hour utilization (0..1) from a list of windows, or null when
 * the daemon has no 5h window for this account yet.
 */
export function fiveHourUtilization(windows: RateLimitWindow[] | undefined): number | null {
  const w = windows?.find((x) => x.name === 'unified-5h');
  if (!w) return null;
  if (w.utilization != null) return w.utilization;
  if (w.limit != null && w.remaining != null && w.limit > 0) {
    return (w.limit - w.remaining) / w.limit;
  }
  return null;
}

/**
 * Extract the Unix-seconds reset timestamp for the 5-hour window, or null
 * when we haven't observed a reset header for this account yet. Drives the
 * live countdown pill on AccountCard and the reset-in-X label beside each
 * meter on UsageView.
 */
export function fiveHourResetAt(windows: RateLimitWindow[] | undefined): number | null {
  const w = windows?.find((x) => x.name === 'unified-5h');
  return w?.reset ?? null;
}
