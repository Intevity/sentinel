import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NotificationRecord,
  NotificationType,
  SecurityOsNotifyThreshold,
} from '@claude-sentinel/shared';
import { invoke } from '@tauri-apps/api/core';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';
import { shouldFireSecurityOsNotification } from '../lib/security-threshold.js';

const DEFAULT_PAGE_SIZE = 50;
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { useSettings } from './useSettings.js';

interface UseNotificationsParams {
  /** When set, restrict to rows scoped to this account or to the global
   *  bucket (account_id IS NULL). Mirrors AlertsEditor's per-account
   *  scoping that previously happened client-side. */
  accountId?: string;
  /** Server-side category filter. Empty / undefined returns all types. */
  types?: NotificationType[];
  /** Page size for the initial fetch and each `loadMore()`. Default 50. */
  pageSize?: number;
}

interface UseNotificationsResult {
  notifications: NotificationRecord[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  loadMore: () => Promise<void>;
}

/**
 * App-global listener that fires native OS notifications (and plays the
 * configured sound) for daemon alert events. Must be mounted at App top
 * level — not inside a per-tab component — so banners still fire when
 * the user is on any tab or has the window hidden in the tray.
 *
 * Bootstraps OS notification permission on mount. If the user denies,
 * native popups won't appear but in-app history (via `useNotifications`
 * below) still works.
 */
export function useNativeAlertNotifications(): void {
  const { settings } = useSettings();
  const soundName = settings?.alertSoundName ?? null;
  const securityThreshold: SecurityOsNotifyThreshold =
    settings?.securityOsNotifyThreshold ?? 'high';
  const overageOsNotify = settings?.overageOsNotify ?? true;

  useEffect(() => {
    // Request permission once per mount. This is a no-op if already granted.
    void (async () => {
      try {
        const granted = await isPermissionGranted();
        if (!granted) await requestPermission();
      } catch {
        /* non-fatal — OS denied or plugin unavailable */
      }
    })();

    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'alert_triggered') {
        const pct = (msg.utilization * 100).toFixed(1);
        const headline =
          msg.scope === 'pool'
            ? `Sentinel: pool at ${msg.thresholdPct}%`
            : msg.scope === 'pool-weekly'
              ? `Sentinel: pool weekly at ${msg.thresholdPct}%`
              : msg.scope === 'account-sonnet'
                ? `Sentinel: ${msg.thresholdPct}% Sonnet usage reached`
                : msg.scope === 'account-weekly'
                  ? `Sentinel: ${msg.thresholdPct}% weekly usage reached`
                  : `Sentinel: ${msg.thresholdPct}% usage reached`;
        const body =
          msg.scope === 'pool'
            ? `Round-robin pool has used ${pct}% on average across its 5-hour window.`
            : msg.scope === 'pool-weekly'
              ? `Round-robin pool has used ${pct}% on average across its 7-day window.`
              : msg.scope === 'account-sonnet'
                ? `Active account has used ${pct}% of its Sonnet 7-day window.`
                : msg.scope === 'account-weekly'
                  ? `Active account has used ${pct}% of its weekly 7-day window.`
                  : `Active account has used ${pct}% of its 5-hour window.`;
        void fireNativeStandard(headline, body, soundName);
      } else if (msg.type === 'sonnet_saturation_entered') {
        if (overageOsNotify) {
          const short = msg.accountId.slice(0, 8);
          const pct = (msg.utilization * 100).toFixed(1);
          void fireNativeStandard(
            'Claude Sentinel: Sonnet 7-day saturated',
            `${short}… at ${pct}% of Sonnet weekly quota. Further Sonnet requests will draw from overage.`,
            soundName,
          );
        }
      } else if (msg.type === 'overage_entered') {
        if (overageOsNotify) {
          const short = msg.accountId.slice(0, 8);
          void fireNativeStandard(
            'Claude Sentinel: Overage started',
            `${short}… is now using overage budget.`,
            soundName,
          );
        }
      } else if (msg.type === 'overage_disabled') {
        if (overageOsNotify) {
          const short = msg.accountId.slice(0, 8);
          const reason = msg.reason && msg.reason !== 'unknown' ? ` (${msg.reason})` : '';
          void fireNativeStandard(
            'Claude Sentinel: Overage cap reached',
            `${short}… hit its overage limit${reason}.`,
            soundName,
          );
        }
      } else if (msg.type === 'account_paused') {
        // Account just transitioned into a paused state (hit weekly
        // budget cap, or Anthropic disabled overage on it). Mirrors
        // the overage_entered banner — same severity of state change
        // from the user's perspective. Always fires; there is no
        // per-signal toggle because an account going silent is rare
        // and load-bearing enough to surface unconditionally.
        const short = msg.accountId.slice(0, 8);
        const reasonBlurb =
          msg.reason === 'sentinel_budget'
            ? 'hit weekly budget cap'
            : msg.reason === 'sentinel_weekly_rate_limit'
              ? 'hit weekly 7-day rate limit'
              : msg.reason === 'anthropic_overage_disabled'
                ? 'Anthropic disabled overage'
                : 'paused';
        void fireNativeStandard(
          'Claude Sentinel: Account paused',
          `${short}… ${reasonBlurb}.`,
          soundName,
        );
      } else if (msg.type === 'security_event_detected') {
        if (shouldFireSecurityOsNotification(msg.severity, securityThreshold)) {
          const title = msg.blocked
            ? `Sentinel blocked: ${msg.title}`
            : `Sentinel security: ${msg.title}`;
          const body = `${msg.severity.toUpperCase()} severity · ${msg.kind}`;
          // eventId is typically present — passing it enables the
          // "Details" button and body-click routing on the banner.
          // Older broadcasts without the id still render as a plain
          // info-only notification.
          void fireNativeSecurity(title, body, soundName, msg.eventId);
        }
      } else if (msg.type === 'security_block_pending') {
        // Held outbound block. The OS banner is a "Details" pointer —
        // tapping it brings the app forward to the Security tab where
        // the pending block renders as a pinned LiveSecurityRow with
        // the Approve / Deny controls. No eventId: the security-event
        // row isn't persisted until the pending resolves.
        const holdSec = Math.max(0, Math.ceil((msg.pending.expiresAt - Date.now()) / 1000));
        void fireNativeSecurity(
          `Sentinel blocked: ${msg.pending.title}`,
          `Open Sentinel to Approve or Deny. Expires in ${holdSec}s.`,
          soundName,
        );
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      unlisten?.();
    };
  }, [soundName, securityThreshold, overageOsNotify]);
}

/**
 * Fetch the notification history from the daemon and stay in sync with
 * live events that add rows. Safe to mount/unmount with a tab — the
 * native OS banners are fired by `useNativeAlertNotifications` at the
 * app root, not here.
 *
 * Cursor-paginated: the initial fetch returns the newest `pageSize`
 * rows; `loadMore()` pages older using the oldest row's ts as the
 * cursor. Live broadcasts (alert_triggered, overage_*, etc.) trigger a
 * HEAD-refresh that prepends new rows without disturbing scroll
 * position on already-loaded older pages.
 */
export function useNotifications(params: UseNotificationsParams = {}): UseNotificationsResult {
  const { accountId, types, pageSize = DEFAULT_PAGE_SIZE } = params;
  const typesKey = types ? JSON.stringify(types) : '';

  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTokenRef = useRef(0);

  const buildBaseRequest = useCallback((): {
    type: 'get_notifications';
    limit: number;
    accountId?: string;
    types?: NotificationType[];
  } => {
    const req: ReturnType<typeof buildBaseRequest> = {
      type: 'get_notifications',
      limit: pageSize,
    };
    if (accountId !== undefined) req.accountId = accountId;
    if (types !== undefined && types.length > 0) req.types = types;
    return req;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, typesKey, pageSize]);

  const refetch = useCallback(async () => {
    const token = ++fetchTokenRef.current;
    setLoading(true);
    try {
      const res = await sendToSentinel<NotificationRecord[]>(buildBaseRequest());
      if (token !== fetchTokenRef.current) return;
      if (res.success) {
        const data = res.data ?? [];
        setNotifications(data);
        setHasMore(data.length >= pageSize);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load notifications');
      }
    } catch (e) {
      if (token !== fetchTokenRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === fetchTokenRef.current) setLoading(false);
    }
  }, [buildBaseRequest, pageSize]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const oldest = notifications[notifications.length - 1];
    if (!oldest) return;
    const token = fetchTokenRef.current;
    setLoadingMore(true);
    try {
      const res = await sendToSentinel<NotificationRecord[]>({
        ...buildBaseRequest(),
        beforeTs: oldest.ts,
      });
      if (token !== fetchTokenRef.current) return;
      if (res.success) {
        const page = res.data ?? [];
        setNotifications((prev) => {
          const seen = new Set(prev.map((n) => n.id));
          return [...prev, ...page.filter((n) => !seen.has(n.id))];
        });
        setHasMore(page.length >= pageSize);
      }
    } finally {
      if (token === fetchTokenRef.current) setLoadingMore(false);
    }
  }, [buildBaseRequest, notifications, hasMore, loadingMore, pageSize]);

  const refreshHead = useCallback(async () => {
    const token = fetchTokenRef.current;
    try {
      const res = await sendToSentinel<NotificationRecord[]>(buildBaseRequest());
      if (token !== fetchTokenRef.current) return;
      if (res.success) {
        const head = res.data ?? [];
        setNotifications((prev) => {
          if (prev.length === 0) return head;
          // Reconcile the head: any id present in both the new head and the
          // existing list gets its updated row (acknowledged flag may have
          // flipped server-side); brand-new ids prepend. Older rows below
          // the head window are untouched.
          const headIds = new Set(head.map((n) => n.id));
          const tail = prev.filter((n) => !headIds.has(n.id));
          return [...head, ...tail];
        });
      }
    } catch {
      /* silent — broadcast-driven refresh */
    }
  }, [buildBaseRequest]);

  useEffect(() => {
    void refetch();

    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (
        msg.type === 'alert_triggered' ||
        msg.type === 'overage_entered' ||
        msg.type === 'overage_disabled' ||
        msg.type === 'sonnet_saturation_entered' ||
        msg.type === 'account_switched' ||
        msg.type === 'security_event_detected'
      ) {
        void refreshHead();
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      unlisten?.();
    };
  }, [refetch, refreshHead]);

  return { notifications, loading, loadingMore, hasMore, error, refetch, loadMore };
}

/**
 * Native notification for usage/overage/alert events.
 *
 * Routed through the `display_alert_notification` Tauri command so
 * delivery uses the notification plugin's Rust API and failures land
 * in ~/.claude-sentinel/app.log. The previous `sendNotification` JS
 * path fired through the plugin's injected window.Notification shim,
 * whose constructor cannot propagate errors: a Windows toast failure
 * (e.g. unregistered AUMID) was invisible. Same plugin backend as
 * before, so macOS behavior (including the sound and the suppressed-
 * when-frontmost rule) is unchanged — fine for this category because
 * the user is usually away from the app when a 5-hour window hits 95%
 * or an account exhausts overage.
 */
async function fireNativeStandard(
  title: string,
  body: string,
  sound: string | null,
): Promise<void> {
  try {
    const granted = await isPermissionGranted();
    if (!granted) return;
    await invoke('display_alert_notification', { title, body, sound });
  } catch {
    /* ignore — OS denied, or the failure is already logged Rust-side */
  }
}

/**
 * Native notification for every security event — both informational
 * detections and held pending blocks. The banner always carries a
 * "Details" action button and a clickable body; both paths open the
 * tray window. When `eventId` is provided, the Rust delegate also
 * emits `security_notification_details` so the Security tab can scroll
 * to the matching row. For pending blocks we omit `eventId` because
 * the row isn't persisted until resolve, and the LiveSecurityRow at
 * the top of the Security tab carries the Approve / Deny controls.
 * Fires via the native NSUserNotification bridge on macOS so the
 * banner carries our app icon + bundle attribution — unlike the old
 * osascript path which showed as "Script Editor"; on Windows/Linux the
 * same command delivers through the notification plugin (winrt toast /
 * XDG). Sound plays through `play_system_sound` (afplay-backed, no-op
 * off macOS) for the same reason security events bypass the Tauri
 * plugin path historically.
 */
async function fireNativeSecurity(
  title: string,
  body: string,
  sound: string | null,
  eventId?: number,
): Promise<void> {
  try {
    // Omit eventId when undefined so the Tauri invoke serialiser
    // doesn't send `eventId: null` — the Rust side expects an Option
    // and either shape works, but an omitted field is less brittle
    // across IPC schema changes.
    const args: Record<string, unknown> = { title, body };
    if (eventId !== undefined) args.eventId = eventId;
    await invoke('display_os_notification', args);
  } catch {
    /* denied or delivery failed — failure logged Rust-side. */
  }
  if (sound) {
    try {
      await invoke('play_system_sound', { name: sound });
    } catch {
      /* afplay unavailable — silent. */
    }
  }
}
