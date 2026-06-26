import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Alert, AlertScope, BudgetAlertScope } from '@sentinel/shared';
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
 * Target for the alerts being edited. Shapes:
 *   { scope: 'account', accountId }        — per-account alerts fired on the
 *                                            account's unified-5h window.
 *   { scope: 'account-sonnet', accountId } — per-account alerts fired on the
 *                                            account's unified-7d_sonnet
 *                                            window. Same id, separate
 *                                            threshold list.
 *   { scope: 'account-weekly', accountId } — per-account alerts fired on the
 *                                            account's unified-7d (general
 *                                            weekly) window. Independent
 *                                            threshold list from Sonnet.
 *   { scope: 'pool' }                      — pool-wide alerts (Auto mode
 *                                            only); fire on mean unified-5h
 *                                            utilization across the pool.
 *   { scope: 'pool-weekly' }               — pool-wide alerts on mean
 *                                            unified-7d utilization.
 *   { scope: 'budget', ... }               — rolling 7-day spend alerts.
 */
export type UseAlertsTarget =
  | { scope: 'account'; accountId: string | undefined }
  | { scope: 'account-sonnet'; accountId: string | undefined }
  | { scope: 'account-weekly'; accountId: string | undefined }
  | { scope: 'pool' }
  | { scope: 'pool-weekly' }
  | { scope: 'budget'; budgetScope: BudgetAlertScope; accountId?: string | undefined };

/**
 * Back-compat overload: `useAlerts(accountId)` is equivalent to
 * `useAlerts({ scope: 'account', accountId })`. Call sites that predated
 * pool alerts keep working.
 */
export function useAlerts(accountId: string | undefined): UseAlertsResult;
export function useAlerts(target: UseAlertsTarget): UseAlertsResult;
export function useAlerts(arg: string | undefined | UseAlertsTarget): UseAlertsResult {
  const target: UseAlertsTarget = useMemo(() => {
    if (arg == null || typeof arg === 'string') {
      return { scope: 'account', accountId: arg };
    }
    return arg;
  }, [arg]);

  const scope: AlertScope = target.scope;
  const accountId =
    target.scope === 'account' ||
    target.scope === 'account-sonnet' ||
    target.scope === 'account-weekly'
      ? target.accountId
      : target.scope === 'budget'
        ? target.accountId
        : undefined;
  const budgetScope: BudgetAlertScope | undefined =
    target.scope === 'budget' ? target.budgetScope : undefined;

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Drop any alerts state the moment the scoping key changes so the UI can
  // never flash the previous account's (or the wrong scope's) rows while
  // the new fetch is in flight.
  useEffect(() => {
    setAlerts([]);
  }, [scope, accountId]);

  const refetch = useCallback(async () => {
    if (
      (scope === 'account' ||
        scope === 'account-sonnet' ||
        scope === 'account-weekly' ||
        (scope === 'budget' && budgetScope === 'account')) &&
      !accountId
    ) {
      setAlerts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await sendToSentinel<Alert[]>(
        scope === 'pool' || scope === 'pool-weekly'
          ? { type: 'list_alerts', scope }
          : scope === 'budget'
            ? accountId
              ? { type: 'list_alerts', scope: 'budget', accountId }
              : { type: 'list_alerts', scope: 'budget' }
            : { type: 'list_alerts', scope, accountId: accountId as string },
      );
      if (res.success) {
        const filtered = (res.data ?? []).filter((a) =>
          scope === 'budget' && budgetScope ? a.budgetScope === budgetScope : true,
        );
        setAlerts(filtered);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load alerts');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scope, accountId, budgetScope]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const create = useCallback(
    async (thresholdPct: number): Promise<void> => {
      if (
        (scope === 'account' || scope === 'account-sonnet' || scope === 'account-weekly') &&
        !accountId
      ) {
        return;
      }
      if (scope === 'budget' && budgetScope === 'account' && !accountId) return;
      const payloadAccountId =
        scope === 'pool' || scope === 'pool-weekly'
          ? null
          : scope === 'budget' && budgetScope === 'global'
            ? null
            : (accountId as string);
      const res = await sendToSentinel<Alert>({
        type: 'upsert_alert',
        scope,
        accountId: payloadAccountId,
        thresholdPct,
        enabled: true,
        ...(scope === 'budget' && budgetScope ? { budgetScope } : {}),
      });
      if (!res.success) throw new Error(res.error ?? 'create failed');
      await refetch();
    },
    [scope, accountId, budgetScope, refetch],
  );

  const update = useCallback(
    async (alert: Alert, thresholdPct: number): Promise<void> => {
      const res = await sendToSentinel<Alert>({
        type: 'upsert_alert',
        id: alert.id,
        scope: alert.scope,
        accountId: alert.accountId,
        thresholdPct,
        enabled: alert.enabled,
        ...(alert.scope === 'budget' && alert.budgetScope
          ? { budgetScope: alert.budgetScope }
          : {}),
      });
      if (!res.success) throw new Error(res.error ?? 'update failed');
      await refetch();
    },
    [refetch],
  );

  const toggle = useCallback(
    async (alert: Alert): Promise<void> => {
      const res = await sendToSentinel<Alert>({
        type: 'upsert_alert',
        id: alert.id,
        scope: alert.scope,
        accountId: alert.accountId,
        thresholdPct: alert.thresholdPct,
        enabled: !alert.enabled,
      });
      if (!res.success) throw new Error(res.error ?? 'toggle failed');
      await refetch();
    },
    [refetch],
  );

  const remove = useCallback(
    async (id: number): Promise<void> => {
      const res = await sendToSentinel({ type: 'delete_alert', id });
      if (!res.success) throw new Error(res.error ?? 'delete failed');
      await refetch();
    },
    [refetch],
  );

  return { alerts, loading, error, refetch, create, update, toggle, remove };
}
