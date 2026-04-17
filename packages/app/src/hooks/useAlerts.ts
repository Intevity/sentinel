import { useCallback, useEffect, useState } from 'react';
import type { Alert } from '@claude-sentinel/shared';
import { sendToSentinel } from '../lib/ipc.js';

interface UseAlertsResult {
  alerts: Alert[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  create: (thresholdPct: number) => Promise<void>;
  update: (alert: Alert, thresholdPct: number) => Promise<void>;
  toggle: (alert: Alert) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

/**
 * CRUD hook for the alerts bound to a specific Claude account. Alerts are
 * scoped by the Sentinel account key (orgUuid || accountUuid) the caller
 * passes in — typically the currently active account from `useDaemon()`.
 */
export function useAlerts(accountId: string | undefined): UseAlertsResult {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Drop any alerts state the moment the scoping key changes so the UI can
  // never flash the previous account's rows while the new fetch is in flight.
  useEffect(() => {
    setAlerts([]);
  }, [accountId]);

  const refetch = useCallback(async () => {
    if (!accountId) {
      setAlerts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await sendToSentinel<Alert[]>({ type: 'list_alerts', accountId });
      if (res.success) {
        setAlerts(res.data ?? []);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load alerts');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { void refetch(); }, [refetch]);

  const create = useCallback(async (thresholdPct: number): Promise<void> => {
    if (!accountId) return;
    const res = await sendToSentinel<Alert>({
      type: 'upsert_alert',
      accountId,
      thresholdPct,
      enabled: true,
    });
    if (!res.success) throw new Error(res.error ?? 'create failed');
    await refetch();
  }, [accountId, refetch]);

  const update = useCallback(async (alert: Alert, thresholdPct: number): Promise<void> => {
    const res = await sendToSentinel<Alert>({
      type: 'upsert_alert',
      id: alert.id,
      accountId: alert.accountId,
      thresholdPct,
      enabled: alert.enabled,
    });
    if (!res.success) throw new Error(res.error ?? 'update failed');
    await refetch();
  }, [refetch]);

  const toggle = useCallback(async (alert: Alert): Promise<void> => {
    const res = await sendToSentinel<Alert>({
      type: 'upsert_alert',
      id: alert.id,
      accountId: alert.accountId,
      thresholdPct: alert.thresholdPct,
      enabled: !alert.enabled,
    });
    if (!res.success) throw new Error(res.error ?? 'toggle failed');
    await refetch();
  }, [refetch]);

  const remove = useCallback(async (id: number): Promise<void> => {
    const res = await sendToSentinel({ type: 'delete_alert', id });
    if (!res.success) throw new Error(res.error ?? 'delete failed');
    await refetch();
  }, [refetch]);

  return { alerts, loading, error, refetch, create, update, toggle, remove };
}
