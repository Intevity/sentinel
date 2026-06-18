import { useEffect, useState } from 'react';
import type { ClaudeAiUsageSnapshot } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

type UsageError = 'missing_key' | 'auth_expired' | 'oauth_forbidden' | 'network' | 'parse' | null;

interface UseClaudeAiUsageResult {
  snapshot: ClaudeAiUsageSnapshot | null;
  error: UsageError;
  loading: boolean;
}

/**
 * Per-account view of the Anthropic-reported usage snapshot. Fetches once
 * on mount for the given account, then refreshes whenever the daemon
 * broadcasts `claude_ai_usage_updated` for that same account.
 *
 * Returns `snapshot: null` AND a specific `error` discriminator so the UI
 * can pick the right recovery copy:
 *   - missing_key → "Connect claude.ai"
 *   - auth_expired → "Your cookie expired, reconnect"
 *   - oauth_forbidden → "OAuth access disabled by organization admin"
 *                       (refresh + re-auth both no-op; waits for policy change)
 *   - network/parse → "Couldn't reach claude.ai" (transient)
 */
export function useClaudeAiUsage(accountId: string | undefined): UseClaudeAiUsageResult {
  const [snapshot, setSnapshot] = useState<ClaudeAiUsageSnapshot | null>(null);
  const [error, setError] = useState<UsageError>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await sendToSentinel<{
          snapshot: ClaudeAiUsageSnapshot | null;
          error: UsageError;
        }>({
          type: 'get_claude_ai_usage',
          accountId,
        });
        if (cancelled) return;
        if (res.success && res.data) {
          setSnapshot(res.data.snapshot);
          setError(res.data.error);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type !== 'claude_ai_usage_updated') return;
      if (msg.accountId !== accountId) return;
      setSnapshot(msg.snapshot);
      setError(msg.error);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [accountId]);

  return { snapshot, error, loading };
}
