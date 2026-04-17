import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '@claude-sentinel/shared';
import { invoke } from '@tauri-apps/api/core';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

/** localStorage flag so the first-run autostart bootstrap runs exactly once
 *  per install — never override a user who deliberately disabled it later. */
const AUTOSTART_BOOTSTRAP_KEY = 'sentinel.autostartBootstrapped.v1';

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
 */
export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await sendToSentinel<Settings>({ type: 'get_settings' });
      if (res.success && res.data) {
        setSettings(res.data);
        setError(null);
        await bootstrapAutostart(res.data);
      } else {
        setError(res.error ?? 'Failed to load settings');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'settings_changed') {
        setSettings(msg.settings);
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, [load]);

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
