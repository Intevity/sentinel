import { useCallback, useEffect, useState } from 'react';
import type { PermissionRule, PermissionRuleInput } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UsePermissionRulesResult {
  rules: PermissionRule[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  upsert: (input: PermissionRuleInput) => Promise<PermissionRule>;
  remove: (id: string) => Promise<void>;
  toggle: (rule: PermissionRule) => Promise<void>;
}

/**
 * Load every tool-permission rule from the daemon, stay in sync via
 * `permission_rules_changed` broadcasts, and expose CRUD helpers that round
 * through IPC.
 */
export function usePermissionRules(): UsePermissionRulesResult {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await sendToSentinel<PermissionRule[]>({ type: 'list_permission_rules' });
      if (res.success && res.data) {
        setRules(res.data);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load rules');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'permission_rules_changed') {
        setRules(msg.rules);
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, [refetch]);

  const upsert = useCallback(async (input: PermissionRuleInput): Promise<PermissionRule> => {
    const res = await sendToSentinel<PermissionRule>({
      type: 'upsert_permission_rule',
      rule: input,
    });
    if (!res.success || !res.data) throw new Error(res.error ?? 'upsert failed');
    return res.data;
  }, []);

  const remove = useCallback(async (id: string): Promise<void> => {
    const res = await sendToSentinel({ type: 'delete_permission_rule', id });
    if (!res.success) throw new Error(res.error ?? 'delete failed');
  }, []);

  const toggle = useCallback(async (rule: PermissionRule): Promise<void> => {
    await sendToSentinel<PermissionRule>({
      type: 'upsert_permission_rule',
      rule: {
        id: rule.id,
        decision: rule.decision,
        tool: rule.tool,
        pattern: rule.pattern,
        raw: rule.raw,
        note: rule.note,
        enabled: !rule.enabled,
        priority: rule.priority,
      },
    });
  }, []);

  return { rules, loading, error, refetch, upsert, remove, toggle };
}
