import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Pencil, Bell, BellOff } from 'lucide-react';
import type { AccountInfo, Alert, OAuthAccount } from '@claude-sentinel/shared';
import { useAlerts, type UseAlertsTarget } from '../hooks/useAlerts.js';
import { useNotifications } from '../hooks/useNotifications.js';
import { useSettings } from '../hooks/useSettings.js';
import NotificationHistory from './NotificationHistory.js';
import AccountColorDot from './AccountColorDot.js';
import { accountColor } from '../lib/accountColor.js';

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
 * Renders three sections inside the Alerts tab:
 *   1. "Pooled alerts" — round-robin only. CRUD for alerts that fire on the
 *      pool-wide MEAN unified-5h utilization across every pool member.
 *   2. "Alerts" — CRUD for user-configured usage alerts tied to the currently
 *      active account's Sentinel key.
 *   3. "History" — every notification the daemon has persisted, including
 *      overage transitions, account switches, and triggered user alerts.
 *
 * Per-account alerts fire at `thresholdPct` of the unified-5h window's
 * utilization for the bound account. Pool alerts fire when the pool's mean
 * utilization crosses the threshold. Both re-fire only once their governing
 * window (per-account or earliest-in-pool) rolls over.
 */
export default function AlertsEditor({
  activeAccount,
  accounts,
  viewAccountId,
}: AlertsEditorProps): React.ReactElement {
  const { settings, update } = useSettings();
  const isRoundRobin = settings?.switchingMode === 'round-robin';
  const overageOsNotify = settings?.overageOsNotify ?? true;
  const toggleOverageNotify = (): void => {
    void update({ overageOsNotify: !overageOsNotify }).catch(() => undefined);
  };

  // View-scope (picker) wins over the proxy's active account. This lets the
  // user configure alerts for any enrolled account without switching tokens.
  const accountId = viewAccountId ?? (activeAccount ? sentinelKey(activeAccount) : undefined);
  const viewedInfo = viewAccountId ? accounts.find((a) => a.id === viewAccountId) : undefined;
  // Resolve the matching AccountInfo for dot coloring. Prefer viewed-scope,
  // fall back to the enrolled account whose id matches the active OAuth context.
  const rowInfo =
    viewedInfo ??
    (activeAccount ? accounts.find((a) => a.id === sentinelKey(activeAccount)) : undefined);
  const hasAccountContext = Boolean(viewedInfo || activeAccount);

  const accountTarget: UseAlertsTarget = { scope: 'account', accountId };
  const sonnetTarget: UseAlertsTarget = { scope: 'account-sonnet', accountId };
  const poolTarget: UseAlertsTarget = { scope: 'pool' };
  const perAccount = useAlerts(accountTarget);
  const perAccountSonnet = useAlerts(sonnetTarget);
  const pool = useAlerts(poolTarget);
  const { notifications, refetch: refetchNotifications } = useNotifications();

  return (
    <div className="space-y-4 pt-1">
      {/* Quick-access: mute OS notifications. Writes through useSettings so
          the Settings panel's toggle mirrors instantly. Icon changes so
          the muted state is visible at a glance. */}
      {settings && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={toggleOverageNotify}
            aria-pressed={!overageOsNotify}
            title={
              overageOsNotify
                ? 'Overage notifications are ON; click to mute'
                : 'Overage notifications are muted; click to re-enable'
            }
            className={`flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full transition-colors active:scale-95 ${
              overageOsNotify
                ? 'text-[#8E8E93] hover:text-black dark:hover:text-white hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                : 'text-ios-orange bg-ios-orange/10 hover:bg-ios-orange/15'
            }`}
          >
            {overageOsNotify ? (
              <Bell size={12} strokeWidth={2.2} />
            ) : (
              <BellOff size={12} strokeWidth={2.2} />
            )}
            <span>{overageOsNotify ? 'Notifications on' : 'Muted'}</span>
          </button>
        </div>
      )}

      {/* ── Pooled alerts (round-robin only) ───────────────────── */}
      {isRoundRobin && (
        <AlertList
          title="Pooled alerts"
          emptyCopy="No pool alerts yet. Add one to get notified when pool-wide 5-hour usage (averaged across every account in the pool) crosses a threshold."
          rowSuffix="of pool average"
          alerts={pool.alerts}
          loading={pool.loading}
          error={pool.error}
          available={true}
          rowColor={null}
          create={pool.create}
          update={pool.update}
          toggle={pool.toggle}
          remove={pool.remove}
        />
      )}

      {/* ── Per-account alerts ─────────────────────────────────── */}
      <AlertList
        title="Alerts"
        emptyCopy="No alerts yet. Add one to get a native notification when usage crosses a threshold."
        rowSuffix="of 5-hour usage"
        unavailableCopy="Switch to an account to configure usage alerts."
        alerts={perAccount.alerts}
        loading={perAccount.loading}
        error={perAccount.error}
        available={hasAccountContext}
        rowColor={rowInfo ? accountColor(rowInfo) : null}
        create={perAccount.create}
        update={perAccount.update}
        toggle={perAccount.toggle}
        remove={perAccount.remove}
      />

      {/* ── Per-account Sonnet 7-day alerts ─────────────────────── */}
      <AlertList
        title="Sonnet 7-day alerts"
        emptyCopy="No Sonnet alerts yet. Add one to get notified before this account's Sonnet weekly quota spills into overage."
        rowSuffix="of Sonnet 7-day usage"
        unavailableCopy="Switch to an account to configure Sonnet alerts."
        alerts={perAccountSonnet.alerts}
        loading={perAccountSonnet.loading}
        error={perAccountSonnet.error}
        available={hasAccountContext}
        rowColor={rowInfo ? accountColor(rowInfo) : null}
        create={perAccountSonnet.create}
        update={perAccountSonnet.update}
        toggle={perAccountSonnet.toggle}
        remove={perAccountSonnet.remove}
      />

      {/* ── History ─────────────────────────────────────────── */}
      <div className="pt-2 border-t border-black/5 dark:border-white/5">
        <NotificationHistory
          notifications={notifications}
          accounts={accounts}
          {...(accountId !== undefined ? { accountId } : {})}
          onRefresh={() => {
            void refetchNotifications();
          }}
        />
      </div>
    </div>
  );
}

interface AlertListProps {
  title: string;
  emptyCopy: string;
  /** Copy rendered next to the threshold pct in each row. Differs between
   *  per-account ("of 5-hour usage") and pool ("of pool average"). */
  rowSuffix: string;
  /** When false, show `unavailableCopy` instead of the list + Add button. */
  available: boolean;
  unavailableCopy?: string;
  /** Color for the per-row dot. Null renders a muted gray dot (pool scope)
   *  so row alignment stays consistent across both lists. */
  rowColor: string | null;
  alerts: Alert[];
  loading: boolean;
  error: string | null;
  create: (thresholdPct: number) => Promise<void>;
  update: (alert: Alert, thresholdPct: number) => Promise<void>;
  toggle: (alert: Alert) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

function AlertList({
  title,
  emptyCopy,
  rowSuffix,
  available,
  unavailableCopy,
  rowColor,
  alerts,
  loading,
  error,
  create,
  update,
  toggle,
  remove,
}: AlertListProps): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [draftThreshold, setDraftThreshold] = useState(90);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editThreshold, setEditThreshold] = useState(90);

  // Cancel any in-flight edit / add when availability toggles (account
  // switch, round-robin mode flipped off) so we never save to the wrong
  // scope.
  useEffect(() => {
    setAdding(false);
    setEditingId(null);
  }, [available]);

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

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="section-label">{title}</span>
        {!adding && available && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-[11px] font-medium text-ios-blue hover:opacity-80 transition-opacity active:scale-95"
          >
            <Plus size={12} strokeWidth={2.5} />
            Add alert
          </button>
        )}
      </div>

      {!available && (
        <div className="glass-card px-4 py-8 text-center">
          <p className="text-[12px] text-[#8E8E93]">{unavailableCopy ?? 'Not available.'}</p>
        </div>
      )}

      {available && loading && (
        <div className="flex items-center justify-center py-6 gap-2 text-[#8E8E93]">
          <Loader2 size={12} className="animate-spin" />
          <span className="text-[11px]">Loading alerts…</span>
        </div>
      )}

      {available && !loading && error && <p className="text-[12px] text-ios-red px-1">{error}</p>}

      {available && !loading && !error && (
        <div className="space-y-2">
          {alerts.length === 0 && !adding && (
            <div className="glass-card px-4 py-6 text-center">
              <p className="text-[12px] text-[#8E8E93]">{emptyCopy}</p>
            </div>
          )}

          {alerts.map((alert) =>
            editingId === alert.id ? (
              <div key={alert.id} className="glass-card px-3 py-3">
                <div className="flex items-center justify-between text-[11px] text-[#8E8E93] mb-1.5">
                  <span>Edit threshold</span>
                  <span className="font-semibold text-black dark:text-white tabular-nums">
                    {editThreshold}%
                  </span>
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
                <AccountColorDot color={rowColor} size="sm" />
                <span className="text-[13px] font-semibold text-black dark:text-white tabular-nums w-12">
                  {alert.thresholdPct}%
                </span>
                <span className="text-[11px] text-[#8E8E93] flex-1">
                  {rowSuffix}
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
            ),
          )}

          {adding && (
            <div className="glass-card px-3 py-3">
              <div className="flex items-center justify-between text-[11px] text-[#8E8E93] mb-1.5">
                <span>New alert threshold</span>
                <span className="font-semibold text-black dark:text-white tabular-nums">
                  {draftThreshold}%
                </span>
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
                  onClick={() => {
                    setAdding(false);
                    setDraftThreshold(90);
                  }}
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
  );
}

function sentinelKey(account: OAuthAccount): string {
  return account.organizationUuid || account.accountUuid;
}
