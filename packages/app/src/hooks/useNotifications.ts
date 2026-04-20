import { useCallback, useEffect, useState } from 'react';
import type {
  NotificationRecord,
  SecuritySeverity,
  SecurityOsNotifyThreshold,
} from '@claude-sentinel/shared';
import { invoke } from '@tauri-apps/api/core';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { useSettings } from './useSettings.js';

const SEVERITY_ORDER: Record<SecuritySeverity, number> = { low: 0, medium: 1, high: 2 };
const THRESHOLD_ORDER: Record<SecurityOsNotifyThreshold, number> = {
  low: 0,
  medium: 1,
  high: 2,
  off: 99,
};

function shouldFireSecurityOsNotification(
  severity: SecuritySeverity,
  threshold: SecurityOsNotifyThreshold,
): boolean {
  if (threshold === 'off') return false;
  return SEVERITY_ORDER[severity] >= THRESHOLD_ORDER[threshold];
}

interface UseNotificationsResult {
  notifications: NotificationRecord[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
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
  const securityThreshold: SecurityOsNotifyThreshold = settings?.securityOsNotifyThreshold ?? 'high';
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
        const headline = msg.scope === 'pool'
          ? `Sentinel: pool at ${msg.thresholdPct}%`
          : `Sentinel: ${msg.thresholdPct}% usage reached`;
        const body = msg.scope === 'pool'
          ? `Round-robin pool has used ${pct}% on average across its 5-hour window.`
          : `Active account has used ${pct}% of its 5-hour window.`;
        void fireNativeStandard(headline, body, soundName);
      } else if (msg.type === 'overage_entered') {
        if (overageOsNotify) {
          const short = msg.accountId.slice(0, 8);
          void fireNativeStandard(
            'Claude Sentinel — Overage started',
            `${short}… is now using overage budget.`,
            soundName,
          );
        }
      } else if (msg.type === 'overage_disabled') {
        if (overageOsNotify) {
          const short = msg.accountId.slice(0, 8);
          const reason = msg.reason && msg.reason !== 'unknown' ? ` (${msg.reason})` : '';
          void fireNativeStandard(
            'Claude Sentinel — Overage cap reached',
            `${short}… hit its overage limit${reason}.`,
            soundName,
          );
        }
      } else if (msg.type === 'security_event_detected') {
        if (shouldFireSecurityOsNotification(msg.severity, securityThreshold)) {
          const title = msg.blocked
            ? `Sentinel blocked: ${msg.title}`
            : `Sentinel security: ${msg.title}`;
          const body = `${msg.severity.toUpperCase()} severity · ${msg.kind}`;
          void fireNativeSecurity(title, body, soundName);
        }
      } else if (msg.type === 'security_block_pending') {
        // Security-category notifications route through osascript so
        // they fire even when Sentinel is frontmost (macOS suppresses
        // the plugin path in that case). The notification itself
        // doesn't carry buttons — click focuses the window, and the
        // in-app PendingBlockBanner provides approve/deny.
        const holdSec = Math.max(0, Math.ceil((msg.pending.expiresAt - Date.now()) / 1000));
        void fireNativeSecurity(
          `Sentinel blocked: ${msg.pending.title}`,
          `Click to review — approval expires in ${holdSec}s.`,
          soundName,
        );
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);

    return () => { unlisten?.(); };
  }, [soundName, securityThreshold, overageOsNotify]);
}

/**
 * Fetch the notification history from the daemon and stay in sync with
 * live events that add rows. Safe to mount/unmount with a tab — the
 * native OS banners are fired by `useNativeAlertNotifications` at the
 * app root, not here.
 */
export function useNotifications(): UseNotificationsResult {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await sendToSentinel<NotificationRecord[]>({ type: 'get_notifications' });
      if (res.success) {
        setNotifications(res.data ?? []);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load notifications');
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
      if (
        msg.type === 'alert_triggered' ||
        msg.type === 'overage_entered' ||
        msg.type === 'overage_disabled' ||
        msg.type === 'account_switched' ||
        msg.type === 'security_event_detected'
      ) {
        void refetch();
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);

    return () => { unlisten?.(); };
  }, [refetch]);

  return { notifications, loading, error, refetch };
}

/**
 * Native notification for usage/overage/alert events.
 *
 * Uses the Tauri notification plugin (UNUserNotificationCenter on
 * macOS). Suppressed when Sentinel is frontmost — that's fine for
 * this category because the user is usually away from the app when a
 * 5-hour window hits 95% or an account exhausts overage. Keeping this
 * path preserves the sound integration the plugin already handles.
 */
async function fireNativeStandard(title: string, body: string, sound: string | null): Promise<void> {
  try {
    const granted = await isPermissionGranted();
    if (!granted) return;
    sendNotification(sound ? { title, body, sound } : { title, body });
  } catch {
    /* ignore — OS may have denied or plugin is unavailable */
  }
}

/**
 * Native notification for security events.
 *
 * Routes through the `display_os_notification` Tauri command, which
 * shells to macOS's `osascript` and bypasses the foreground-app
 * suppression that silently drops `sendNotification` banners when
 * Sentinel is visible — which is exactly when security events matter
 * most. The afplay-backed sound still plays through the existing
 * `play_system_sound` command so the user hears the alert too.
 */
async function fireNativeSecurity(title: string, body: string, sound: string | null): Promise<void> {
  try {
    await invoke('display_os_notification', { title, body });
  } catch {
    /* osascript unavailable (non-macOS or denied) — silently fall back. */
  }
  if (sound) {
    try {
      await invoke('play_system_sound', { name: sound });
    } catch {
      /* afplay unavailable — silent. */
    }
  }
}
