import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '@sentinel/shared';
import { invoke } from '@tauri-apps/api/core';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

/** localStorage flag so the first-run autostart bootstrap runs exactly once
 *  per install — never override a user who deliberately disabled it later. */
const AUTOSTART_BOOTSTRAP_KEY = 'sentinel.autostartBootstrapped.v1';

/** Poll cadence while waiting for the daemon socket to come up at startup.
 *  Matches useDaemon's retry loop so both hooks converge in the same window. */
const STARTUP_RETRY_MS = 500;

interface UseSettingsResult {
  settings: Settings | null;
  loading: boolean;
  error: string | null;
  update: (patch: Partial<Settings>) => Promise<void>;
}

/**
 * Load settings from the daemon on mount, stay in sync via `settings_changed`
 * broadcasts, and expose an update helper that also enables/disables OS
 * autostart when `launchAtLogin` toggles.
 *
 * On first run (no bootstrap flag set) we reconcile the OS autostart state
 * to match the daemon's default of `launchAtLogin: true`.
 *
 * The initial load retries every 500ms until it succeeds. Without this, the
 * App-level useSettings instance races the daemon sidecar's socket-bind at
 * startup, fails silently, and leaves downstream state (header account
 * display, Usage pool-view option) stuck on the null fallback.
 */
export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attempt = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const res = await sendToSentinel<Settings>({ type: 'get_settings' });
        if (cancelled) return;
        if (res.success && res.data) {
          setSettings(res.data);
          setError(null);
          setLoading(false);
          await bootstrapAutostart(res.data);
          return;
        }
        setError(res.error ?? 'Failed to load settings');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
      if (cancelled) return;
      // Clear the loading flag on failure so consumers (SettingsPanel)
      // render the `error` branch instead of an indefinite spinner. The
      // retry below keeps trying in the background, so a transient IPC
      // failure still recovers without user action.
      setLoading(false);
      timer = setTimeout(() => {
        void attempt();
      }, STARTUP_RETRY_MS);
    };

    void attempt();

    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'settings_changed') {
        setSettings(msg.settings);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>): Promise<void> => {
    // When launchAtLogin flips, reflect it to the OS before persisting — if the
    // OS call fails we surface the error without a stale on-disk value.
    if (patch.launchAtLogin !== undefined) {
      await invoke('set_autostart', { enabled: patch.launchAtLogin });
    }
    const res = await sendToSentinel<Settings>({ type: 'update_settings', settings: patch });
    if (res.success && res.data) setSettings(res.data);
    else throw new Error(res.error ?? 'update_settings failed');
  }, []);

  return { settings, loading, error, update };
}

/**
 * First-run reconciliation: if we have never run the bootstrap, align the OS
 * autostart state with the daemon's default of `launchAtLogin: true`. We gate
 * with localStorage so a user who explicitly turns it off later isn't
 * overridden on the next launch.
 */
async function bootstrapAutostart(settings: Settings): Promise<void> {
  if (typeof window === 'undefined') return;
  if (localStorage.getItem(AUTOSTART_BOOTSTRAP_KEY) === '1') return;
  try {
    const osEnabled = await invoke<boolean>('get_autostart');
    if (osEnabled !== settings.launchAtLogin) {
      await invoke('set_autostart', { enabled: settings.launchAtLogin });
    }
  } catch {
    // Non-fatal — the user can flip the toggle manually from Settings.
  }
  localStorage.setItem(AUTOSTART_BOOTSTRAP_KEY, '1');
}
