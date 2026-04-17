import type { OAuthAccount, Settings, Alert, NotificationRecord, MetricsSummary } from './types.js';

// ─── Daemon → App messages ────────────────────────────────────────────────────

export interface OverageEnteredMessage {
  type: 'overage_entered';
  accountId: string;
  resetsAt: number | null;
}

export interface OverageExitedMessage {
  type: 'overage_exited';
  accountId: string;
}

export interface OverageDisabledMessage {
  type: 'overage_disabled';
  accountId: string;
  reason: string;
}

export interface UsageUpdateMessage {
  type: 'usage_update';
  accountId: string;
  todayCostUsd: number;
  todayTokens: number;
}

export interface AccountSwitchedMessage {
  type: 'account_switched';
  to: OAuthAccount;
}

export interface LoginCompleteMessage {
  type: 'login_complete';
  email: string;
  /** Human-readable org name returned by the OAuth profile endpoint. */
  orgName?: string;
  /** True when the authorized org already existed in the DB — i.e. the user
   *  re-authorized an account they already had, rather than adding a new one.
   *  The UI uses this to show guidance for adding a *different* org. */
  reauth?: boolean;
}

export interface RateLimitsUpdatedMessage {
  type: 'rate_limits_updated';
  accountId: string;
}

/** Fired when the daemon initiates a background probe to fetch fresh
 *  rate-limit headers for an account (on switch or startup). The UI uses
 *  this to show a loading indicator on the Usage view. */
export interface RateLimitsProbingMessage {
  type: 'rate_limits_probing';
  accountId: string;
}

/** Fired when a probe started with `rate_limits_probing` fails or times out
 *  before `rate_limits_updated` could fire. Lets the UI clear its loading
 *  indicator without waiting on a real headers-update broadcast. */
export interface RateLimitsProbeEndedMessage {
  type: 'rate_limits_probe_ended';
  accountId: string;
}

/** Broadcast when settings are written (by any process) so other daemon
 *  subsystems and the UI stay in sync with the latest config. */
export interface SettingsChangedMessage {
  type: 'settings_changed';
  settings: Settings;
}

/** Broadcast when a user-configured usage alert crosses its threshold. The
 *  frontend subscribes and fires a native OS notification. */
export interface AlertTriggeredMessage {
  type: 'alert_triggered';
  alertId: number;
  accountId: string;
  thresholdPct: number;
  /** Actual observed utilization (0..1) at trigger time. */
  utilization: number;
}

/** Broadcast when auto-switch would fire but every candidate is already above
 *  the threshold. Sentinel stays on the current account and tells the user. */
export interface AllAccountsExhaustedMessage {
  type: 'all_accounts_exhausted';
  thresholdPct: number;
}

export type DaemonToAppMessage =
  | OverageEnteredMessage
  | OverageExitedMessage
  | OverageDisabledMessage
  | UsageUpdateMessage
  | AccountSwitchedMessage
  | LoginCompleteMessage
  | RateLimitsUpdatedMessage
  | RateLimitsProbingMessage
  | RateLimitsProbeEndedMessage
  | SettingsChangedMessage
  | AlertTriggeredMessage
  | AllAccountsExhaustedMessage;

// ─── App → Daemon messages ────────────────────────────────────────────────────

export interface GetAccountsMessage {
  type: 'get_accounts';
}

export interface GetCredentialsMessage {
  type: 'get_credentials';
  email: string;
}

export interface StoreCredentialsMessage {
  type: 'store_credentials';
  email: string;
  blob: string;
}

export interface GetUsageSummaryMessage {
  type: 'get_usage_summary';
  days: number;
}

/**
 * Fetch the full Metrics tab rollup for the active account across the
 * requested window. Returns a MetricsSummary (see types.ts) containing every
 * OTEL-sourced signal the dashboard renders, in one round trip.
 */
export interface GetMetricsSummaryMessage {
  type: 'get_metrics_summary';
  days: number;
}

export interface AcknowledgeNotificationMessage {
  type: 'acknowledge_notification';
  id: number;
}

export interface AcknowledgeAllNotificationsMessage {
  type: 'acknowledge_all_notifications';
  /** When set, only notifications scoped to this account or global
   *  (account_id IS NULL) are acknowledged. Omit to ack everything. */
  accountId?: string;
}

export interface SwitchAccountMessage {
  type: 'switch_account';
  /** Account UUID — preferred lookup key. Falls back to email if blank. */
  accountId: string;
  email: string;
}

export interface RefreshAccountsMessage {
  type: 'refresh_accounts';
}

export interface StartLoginMessage {
  type: 'start_login';
}

export interface CancelLoginMessage {
  type: 'cancel_login';
}

export interface RemoveAccountMessage {
  type: 'remove_account';
  /** Sentinel key (id) of the account to remove */
  accountId: string;
  /** When true, also delete all usage, rate-limit, overage, and notification data for this account. */
  deleteData?: boolean;
}

export interface GetRateLimitsMessage {
  type: 'get_rate_limits';
}

export interface GetAllRateLimitsMessage {
  type: 'get_all_rate_limits';
}

export interface GetOverageEventsMessage {
  type: 'get_overage_events';
  limit?: number;
}

export interface GetRemovedAccountsMessage {
  type: 'get_removed_accounts';
}

export interface PurgeAccountMessage {
  type: 'purge_account';
  /** Sentinel key (id) of the account to permanently delete (data + row). */
  accountId: string;
}

export interface GetDaemonStatusMessage {
  type: 'get_daemon_status';
}

/** Response payload for `get_daemon_status` — process-level info shown in the
 *  UI's overflow menu (pid, uptime). */
export interface DaemonProcessStatus {
  pid: number;
  /** Daemon process uptime in milliseconds. */
  uptimeMs: number;
  /** Unix ms timestamp when the daemon process started. */
  startedAt: number;
}

/** Ask the daemon to shut itself down cleanly. Used by "Quit Sentinel" in the
 *  UI so both the app and the daemon stop together. */
export interface ShutdownDaemonMessage {
  type: 'shutdown_daemon';
}

/** Wipe every Sentinel-owned credential from the OS keychain. The caller is
 *  expected to also delete the SQLite DB (via Rust-side deactivate_sentinel
 *  with delete_data=true) and then shut the daemon down. */
export interface PurgeAllDataMessage {
  type: 'purge_all_data';
}

export interface GetSettingsMessage {
  type: 'get_settings';
}

export interface UpdateSettingsMessage {
  type: 'update_settings';
  settings: Partial<Settings>;
}

export interface ListAlertsMessage {
  type: 'list_alerts';
  /** When provided, only alerts bound to this Sentinel account key are returned. */
  accountId?: string;
}

export interface UpsertAlertMessage {
  type: 'upsert_alert';
  /** Omit to create; provide an existing id to update in place. */
  id?: number;
  accountId: string;
  thresholdPct: number;
  enabled: boolean;
}

export interface DeleteAlertMessage {
  type: 'delete_alert';
  id: number;
}

export interface GetNotificationsMessage {
  type: 'get_notifications';
  limit?: number;
}

export type AppToDaemonMessage =
  | GetAccountsMessage
  | GetCredentialsMessage
  | StoreCredentialsMessage
  | GetUsageSummaryMessage
  | GetMetricsSummaryMessage
  | AcknowledgeNotificationMessage
  | AcknowledgeAllNotificationsMessage
  | SwitchAccountMessage
  | RefreshAccountsMessage
  | StartLoginMessage
  | CancelLoginMessage
  | RemoveAccountMessage
  | GetRateLimitsMessage
  | GetAllRateLimitsMessage
  | GetOverageEventsMessage
  | GetRemovedAccountsMessage
  | PurgeAccountMessage
  | GetDaemonStatusMessage
  | ShutdownDaemonMessage
  | PurgeAllDataMessage
  | GetSettingsMessage
  | UpdateSettingsMessage
  | ListAlertsMessage
  | UpsertAlertMessage
  | DeleteAlertMessage
  | GetNotificationsMessage;

/** Response payload alias re-exports for convenience in consumers. */
export type { Settings, Alert, NotificationRecord, MetricsSummary };

// ─── All IPC messages ─────────────────────────────────────────────────────────

export type IpcMessage = DaemonToAppMessage | AppToDaemonMessage;

/**
 * Typed response envelope for request/response IPC interactions
 */
export interface IpcResponse<T = unknown> {
  requestType: string;
  success: boolean;
  data?: T;
  error?: string;
}
