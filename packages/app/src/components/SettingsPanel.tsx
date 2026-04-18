import React from 'react';
import { X, Loader2, Volume2 } from 'lucide-react';
import { motion } from 'motion/react';
import type { SwitchingMode } from '@claude-sentinel/shared';
import { ALERT_SOUNDS } from '@claude-sentinel/shared';
import { invoke } from '@tauri-apps/api/core';
import { useSettings } from '../hooks/useSettings.js';
import { panelSlide } from '../lib/motion.js';

interface SettingsPanelProps {
  onClose: () => void;
  /** Callback ref attached to the scrollable content area so the
   *  auto-resize hook can grow the window to fit the settings list. */
  measureRef?: (el: HTMLElement | null) => void;
}

/**
 * Full-surface settings screen, rendered as an overlay within the 420×600
 * tray window. Reached by the cog icon in the header. Writes propagate to the
 * daemon via `update_settings` — no Save button, every change persists live.
 */
export default function SettingsPanel({ onClose, measureRef }: SettingsPanelProps): React.ReactElement {
  const { settings, loading, error, update } = useSettings();

  const setLaunch = (enabled: boolean): void => {
    void update({ launchAtLogin: enabled }).catch(() => undefined);
  };

  const setMode = (mode: SwitchingMode): void => {
    void update({ switchingMode: mode }).catch(() => undefined);
  };

  const setThreshold = (pct: number): void => {
    void update({ autoSwitchThresholdPct: pct }).catch(() => undefined);
  };

  const setAlertSound = (value: string | null): void => {
    void update({ alertSoundName: value }).catch(() => undefined);
  };

  const setAutoUpdate = (enabled: boolean): void => {
    void update({ autoUpdate: enabled }).catch(() => undefined);
  };

  const checkForUpdatesNow = async (): Promise<void> => {
    await invoke('check_for_updates').catch(() => undefined);
  };

  const previewSound = async (name: string | null): Promise<void> => {
    // macOS silences NSSound-backed notification audio for the frontmost app,
    // so the old sendNotification({ sound }) path produced a banner but no
    // audible preview. Shell out to `afplay` via a native Tauri command to
    // play the sound directly, bypassing the notification system entirely.
    // The live alert path (useNotifications.ts) still uses sendNotification
    // because by then the user is typically elsewhere and macOS plays sound.
    if (!name) return; // 'None' means silent alerts — nothing to preview
    await invoke('play_system_sound', { name }).catch(() => undefined);
  };

  return (
    <motion.div
      {...panelSlide}
      className="absolute inset-0 z-20 flex flex-col bg-[#F2F2F7] dark:bg-[#111111]"
    >
      <header className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-black/5 dark:border-white/5">
        <span className="text-[15px] font-semibold text-black dark:text-white tracking-tight">Settings</span>
        <button
          onClick={onClose}
          className="text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5"
          title="Close"
          aria-label="Close settings"
        >
          <X size={16} strokeWidth={2.2} />
        </button>
      </header>

      <main ref={measureRef} className="flex-1 overflow-y-auto px-4 py-3">
        {loading && (
          <div className="flex items-center justify-center py-10 gap-2 text-[#8E8E93]">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-[12px]">Loading…</span>
          </div>
        )}

        {!loading && error && (
          <p className="text-[12px] text-ios-red">{error}</p>
        )}

        {!loading && settings && (
          <>
            <Section title="General">
              <ToggleRow
                label="Launch at login"
                description="Start Sentinel automatically when you sign in. Recommended so Claude Code stays routed through the proxy."
                checked={settings.launchAtLogin}
                onChange={setLaunch}
              />
            </Section>

            <Section title="Updates">
              <ToggleRow
                label="Automatically install updates"
                description="Check GitHub for a new release on launch and install it silently. Sentinel will restart when the update is ready."
                checked={settings.autoUpdate}
                onChange={setAutoUpdate}
              />
              <button
                onClick={() => void checkForUpdatesNow()}
                className="w-full text-left px-3 py-2.5 text-[13px] font-medium text-ios-blue hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors"
              >
                Check for updates now…
              </button>
            </Section>

            <Section title="Account switching">
              <RadioRow
                label="Off"
                description="No automatic switching. You manage accounts manually from the Accounts tab."
                checked={settings.switchingMode === 'off'}
                onChange={() => setMode('off')}
              />
              <RadioRow
                label="Auto-switch"
                description="When the active account's 5-hour usage reaches the threshold, switch to the account with the most remaining capacity."
                checked={settings.switchingMode === 'auto-switch'}
                onChange={() => setMode('auto-switch')}
              />
              {settings.switchingMode === 'auto-switch' && (
                <div className="px-3 pb-3 pt-1">
                  <div className="flex items-center justify-between text-[11px] text-[#8E8E93] mb-1">
                    <span>Threshold</span>
                    <span className="font-semibold text-black dark:text-white tabular-nums">{settings.autoSwitchThresholdPct}%</span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={99}
                    step={1}
                    value={settings.autoSwitchThresholdPct}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    className="w-full accent-ios-blue"
                  />
                </div>
              )}
              <RadioRow
                label="Round-Robin"
                description="Rotate the OAuth token on every API request so usage drains across all accounts, keeping them within ~1% of each other. Mutually exclusive with Auto-switch."
                checked={settings.switchingMode === 'round-robin'}
                onChange={() => setMode('round-robin')}
              />
            </Section>

            <Section title="Notifications">
              <div className="px-3 py-2.5">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-black dark:text-white">Alert sound</p>
                    <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">
                      Played when a usage alert or exhaustion notification fires.
                      Uses macOS system sounds.
                    </p>
                  </div>
                  <button
                    onClick={() => void previewSound(settings.alertSoundName)}
                    className="text-[#8E8E93] hover:text-ios-blue transition-colors active:scale-90 mt-1"
                    title="Preview sound"
                    aria-label="Preview sound"
                  >
                    <Volume2 size={14} strokeWidth={2.2} />
                  </button>
                </div>
                <select
                  value={settings.alertSoundName ?? ''}
                  onChange={(e) => setAlertSound(e.target.value === '' ? null : e.target.value)}
                  className="mt-2 w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue"
                >
                  {ALERT_SOUNDS.map((s) => (
                    <option key={s.label} value={s.value ?? ''}>{s.label}</option>
                  ))}
                </select>
              </div>
            </Section>
          </>
        )}
      </main>
    </motion.div>
  );
}

// ─── Building-block rows ─────────────────────────────────────────────────────

function Section(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mb-4">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8E8E93] mb-1.5 px-1">
        {props.title}
      </p>
      <div className="rounded-2xl bg-white dark:bg-[#1E1E1E] shadow-card overflow-hidden divide-y divide-black/5 dark:divide-white/5">
        {props.children}
      </div>
    </div>
  );
}

function ToggleRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.ReactElement {
  return (
    <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer">
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-black dark:text-white">{props.label}</p>
        {props.description && (
          <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">{props.description}</p>
        )}
      </div>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-1 accent-ios-blue w-4 h-4"
      />
    </label>
  );
}

function RadioRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
}): React.ReactElement {
  return (
    <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
      <input
        type="radio"
        checked={props.checked}
        onChange={props.onChange}
        className="mt-1 accent-ios-blue w-4 h-4"
      />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-black dark:text-white">{props.label}</p>
        {props.description && (
          <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">{props.description}</p>
        )}
      </div>
    </label>
  );
}
