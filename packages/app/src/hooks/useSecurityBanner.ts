import { useCallback, useEffect, useRef, useState } from 'react';
import { onDaemonMessage } from '../lib/ipc.js';
import { buildSecurityBannerPayload } from './useSecurityBanner.logic.js';
import type { SecurityBannerPayload } from './useSecurityBanner.logic.js';
import { useSettings } from './useSettings.js';

export type { SecurityBannerPayload } from './useSecurityBanner.logic.js';

export interface UseSecurityBannerResult {
  banner: SecurityBannerPayload | null;
  dismiss: () => void;
}

const AUTO_DISMISS_MS = 8000;

/**
 * App-level slip banner state for incoming security broadcasts.
 *
 * Subscribes to `security_event_detected` and `security_block_pending`
 * and surfaces a single banner payload at a time, replacing on the
 * latest broadcast. Auto-dismisses after 8s; `dismiss()` clears
 * immediately. Threshold-gated by `securityOsNotifyThreshold` so the
 * banner and the OS notification share the same severity floor.
 *
 * Does NOT fire OS notifications: that responsibility stays in
 * useNativeAlertNotifications so a single subscription per surface.
 */
export function useSecurityBanner(): UseSecurityBannerResult {
  const { settings } = useSettings();
  const threshold = settings?.securityOsNotifyThreshold ?? 'high';

  const [banner, setBanner] = useState<SecurityBannerPayload | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setBanner(null);
  }, []);

  const show = useCallback((next: SecurityBannerPayload) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setBanner(next);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setBanner(null);
    }, AUTO_DISMISS_MS);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      const next = buildSecurityBannerPayload(msg, threshold);
      if (next !== null) show(next);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      unlisten?.();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [threshold, show]);

  return { banner, dismiss };
}
