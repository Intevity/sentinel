import { useCallback, useEffect, useState } from 'react';
import type { NotificationRecord } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { useSettings } from './useSettings.js';

interface UseNotificationsResult {
  notifications: NotificationRecord[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch the notification history from the daemon, stay in sync with live
 * triggers (`alert_triggered`, `all_accounts_exhausted`, overage events),
 * and fire a native OS notification for each alert the user receives while
 * the app is running.
 *
 * Bootstraps OS notification permission on mount. If the user denies,
 * native popups won't appear but in-app history still works.
 */
export function useNotifications(): UseNotificationsResult {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { settings } = useSettings();
  const soundName = settings?.alertSoundName ?? null;

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
        void fireNative(
          `Sentinel: ${msg.thresholdPct}% usage reached`,
          `Active account has used ${pct}% of its 5-hour window.`,
          soundName,
        );
        void refetch();
      } else if (msg.type === 'all_accounts_exhausted') {
        void fireNative(
          `All accounts at ${msg.thresholdPct}%+ usage`,
          'Sentinel is staying on the current account — auto-switch has no eligible candidate.',
          soundName,
        );
        void refetch();
      } else if (
        msg.type === 'overage_entered' ||
        msg.type === 'overage_disabled' ||
        msg.type === 'account_switched'
      ) {
        void refetch();
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);

    return () => { unlisten?.(); };
  }, [refetch, soundName]);

  return { notifications, loading, error, refetch };
}

async function fireNative(title: string, body: string, sound: string | null): Promise<void> {
  try {
    const granted = await isPermissionGranted();
    if (!granted) return;
    sendNotification(sound ? { title, body, sound } : { title, body });
  } catch {
    /* ignore — OS may have denied or plugin is unavailable */
  }
}
