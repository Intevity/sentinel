import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Pencil } from 'lucide-react';
import type { AccountInfo, Alert, OAuthAccount } from '@claude-sentinel/shared';
import { useAlerts } from '../hooks/useAlerts.js';
import { useNotifications } from '../hooks/useNotifications.js';
import NotificationHistory from './NotificationHistory.js';

interface AlertsEditorProps {
  activeAccount: OAuthAccount | null;
  /** Full list of enrolled accounts — used to resolve the view-scope account's
   *  display name when `viewAccountId` is set. */
  accounts: AccountInfo[];
  /** View-scope override from the per-tab AccountViewPicker. When set,
   *  alerts are loaded for that account rather than the currently active one. */
  viewAccountId?: string | undefined;
}

/**
 * Renders two sections inside the Alerts tab:
 *   1. "Alerts" — CRUD for user-configured usage alerts tied to the currently
 *      active account's Sentinel key.
 *   2. "History" — every notification the daemon has persisted, including
 *      overage transitions, account switches, triggered user alerts, and
 *      auto-switch exhaustion events.
 *
 * Alerts fire at `thresholdPct` of the unified-5h window's utilization. They
 * only re-fire once the window rolls over — lowering the threshold while the
 * active alert is still within its window does not re-trigger.
 */
export default function AlertsEditor({ activeAccount, accounts, viewAccountId }: AlertsEditorProps): React.ReactElement {
  // View-scope (picker) wins over the proxy's active account. This lets the
  // user configure alerts for any enrolled account without switching tokens.
  const accountId = viewAccountId ?? (activeAccount ? sentinelKey(activeAccount) : undefined);
  const viewedInfo = viewAccountId ? accounts.find((a) => a.id === viewAccountId) : undefined;
  const { alerts, loading: alertsLoading, error: alertsError, create, update, toggle, remove } =
    useAlerts(accountId);
  const { notifications, refetch: refetchNotifications } = useNotifications();
  const [adding, setAdding] = useState(false);
  const [draftThreshold, setDraftThreshold] = useState(90);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editThreshold, setEditThreshold] = useState(90);

  // Cancel any in-flight edit / add when the user switches accounts so we never
  // save to the wrong account.
  useEffect(() => {
    setAdding(false);
    setEditingId(null);
  }, [accountId]);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      await create(draftThreshold);
      setAdding(false);
      setDraftThreshold(90);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (alert: Alert): void => {
    setEditingId(alert.id);
    setEditThreshold(alert.thresholdPct);
  };

  const handleEditSave = async (alert: Alert): Promise<void> => {
    setSaving(true);
    try {
      await update(alert, editThreshold);
      setEditingId(null);
    } finally {
      setSaving(false);
    }
  };

  const hasAccountContext = Boolean(viewedInfo || activeAccount);

  return (
    <div className="space-y-4 pt-1">
      {/* ── User alerts ─────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="section-label">Alerts</span>
          {!adding && hasAccountContext && (
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-1 text-[11px] font-medium text-ios-blue hover:opacity-80 transition-opacity active:scale-95"
            >
              <Plus size={12} strokeWidth={2.5} />
              Add alert
            </button>
          )}
        </div>

        {!hasAccountContext && (
          <div className="glass-card px-4 py-8 text-center">
            <p className="text-[12px] text-[#8E8E93]">
              Switch to an account to configure usage alerts.
            </p>
          </div>
        )}

        {hasAccountContext && alertsLoading && (
          <div className="flex items-center justify-center py-6 gap-2 text-[#8E8E93]">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-[11px]">Loading alerts…</span>
          </div>
        )}

        {hasAccountContext && !alertsLoading && alertsError && (
          <p className="text-[12px] text-ios-red px-1">{alertsError}</p>
        )}

        {hasAccountContext && !alertsLoading && !alertsError && (
          <div className="space-y-2">
            {alerts.length === 0 && !adding && (
              <div className="glass-card px-4 py-6 text-center">
                <p className="text-[12px] text-[#8E8E93]">No alerts yet. Add one to get a native notification when usage crosses a threshold.</p>
              </div>
            )}

            {alerts.map((alert) => (
              editingId === alert.id ? (
                <div key={alert.id} className="glass-card px-3 py-3">
                  <div className="flex items-center justify-between text-[11px] text-[#8E8E93] mb-1.5">
                    <span>Edit threshold</span>
                    <span className="font-semibold text-black dark:text-white tabular-nums">{editThreshold}%</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={99}
                    step={1}
                    value={editThreshold}
                    onChange={(e) => setEditThreshold(Number(e.target.value))}
                    className="w-full accent-ios-blue mb-3"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => void handleEditSave(alert)}
                      disabled={saving}
                      className="flex-1 text-[12px] font-semibold text-white bg-ios-blue hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all disabled:opacity-50"
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      disabled={saving}
                      className="text-[12px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors px-2"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div key={alert.id} className="glass-card px-3 py-2.5 flex items-center gap-3">
                  <span className="text-[13px] font-semibold text-black dark:text-white tabular-nums w-12">
                    {alert.thresholdPct}%
                  </span>
                  <span className="text-[11px] text-[#8E8E93] flex-1">
                    of 5-hour usage
                    {alert.lastTriggeredResetTs && (
                      <span className="ml-1 text-ios-blue">· triggered this window</span>
                    )}
                  </span>
                  <label className="flex items-center gap-1.5 text-[11px] text-[#8E8E93] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={alert.enabled}
                      onChange={() => void toggle(alert)}
                      className="accent-ios-blue w-3.5 h-3.5"
                    />
                    Enabled
                  </label>
                  <button
                    onClick={() => startEdit(alert)}
                    className="text-[#8E8E93] hover:text-ios-blue transition-colors active:scale-90"
                    title="Edit threshold"
                    aria-label="Edit alert"
                  >
                    <Pencil size={12} strokeWidth={2.2} />
                  </button>
                  <button
                    onClick={() => void remove(alert.id)}
                    className="text-[#8E8E93] hover:text-ios-red transition-colors active:scale-90"
                    title="Delete alert"
                    aria-label="Delete alert"
                  >
                    <Trash2 size={12} strokeWidth={2.2} />
                  </button>
                </div>
              )
            ))}

            {adding && (
              <div className="glass-card px-3 py-3">
                <div className="flex items-center justify-between text-[11px] text-[#8E8E93] mb-1.5">
                  <span>New alert threshold</span>
                  <span className="font-semibold text-black dark:text-white tabular-nums">{draftThreshold}%</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={99}
                  step={1}
                  value={draftThreshold}
                  onChange={(e) => setDraftThreshold(Number(e.target.value))}
                  className="w-full accent-ios-blue mb-3"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleSave()}
                    disabled={saving}
                    className="flex-1 text-[12px] font-semibold text-white bg-ios-blue hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => { setAdding(false); setDraftThreshold(90); }}
                    disabled={saving}
                    className="text-[12px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors px-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── History ─────────────────────────────────────────── */}
      <div className="pt-2 border-t border-black/5 dark:border-white/5">
        <NotificationHistory
          notifications={notifications}
          {...(accountId !== undefined ? { accountId } : {})}
          onRefresh={() => { void refetchNotifications(); }}
        />
      </div>
    </div>
  );
}

function sentinelKey(account: OAuthAccount): string {
  return account.organizationUuid || account.accountUuid;
}
