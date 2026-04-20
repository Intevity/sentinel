import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, Volume2, Trash2, Plus, RefreshCw } from 'lucide-react';
import { motion } from 'motion/react';
import type {
  SwitchingMode,
  RoundRobinStrategy,
  SecurityEnforcementMode,
  SecurityOsNotifyThreshold,
  PermissionDecision,
} from '@claude-sentinel/shared';
import { ALERT_SOUNDS } from '@claude-sentinel/shared';
import { invoke } from '@tauri-apps/api/core';
import { sendToSentinel } from '../lib/ipc.js';
import { useSettings } from '../hooks/useSettings.js';
import { useSecurityAllowlist } from '../hooks/useSecurityAllowlist.js';
import { useDaemon } from '../hooks/useDaemon.js';
import { useClaudeAiLogin } from '../hooks/useClaudeAiLogin.js';
import { useClaudeAiUsage } from '../hooks/useClaudeAiUsage.js';
import { useAccounts } from '../hooks/useAccounts.js';
import { useSiblingCandidates } from '../hooks/useSiblingCandidates.js';
import { accountColor } from '../lib/accountColor.js';
import AccountColorDot from './AccountColorDot.js';
import OverlayPanel from './OverlayPanel.js';
import PermissionsEditor from './PermissionsEditor.js';
import { Section, ToggleRow, RadioRow } from './settings/primitives.js';

/**
 * Which of the 4 Settings tabs a given deep-link anchor lives in. Used by
 * the auto-scroll effect to switch tabs before scrolling. Keep this map in
 * sync when new anchors are added to any tab.
 */
type SettingsTabId = 'general' | 'accounts' | 'security' | 'data';

const ANCHOR_TO_TAB: Record<string, SettingsTabId> = {
  // Security tab anchors
  'security-enable-toggle': 'security',
  'security-enforcement-heading': 'security',
};

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'security', label: 'Security' },
  { id: 'data', label: 'Data' },
];

interface SettingsPanelProps {
  onClose: () => void;
  /** Callback ref attached to the scrollable content area so the
   *  auto-resize hook can grow the window to fit the settings list. */
  measureRef?: (el: HTMLElement | null) => void;
  /** When set, scroll the element with this `id` into view shortly after
   *  the panel animates in, and flash it briefly. Used for deep-linking
   *  from elsewhere in the app (e.g. the Security-tab disabled banner
   *  jumping straight to the "Enable security scanning" toggle). */
  initialScrollTarget?: string | null;
  /** Close the panel and force-open the Security Setup Wizard. Provided
   *  by the parent so the replay button in the Security tab can reopen
   *  the wizard without tripping over `securitySetupCompleted`. */
  onRunSetupWizard?: () => void;
}

/**
 * Full-surface settings screen, rendered as an overlay within the 420×600
 * tray window. Reached by the cog icon in the header. Writes propagate to the
 * daemon via `update_settings` — no Save button, every change persists live.
 */
export default function SettingsPanel({ onClose, measureRef, initialScrollTarget, onRunSetupWizard }: SettingsPanelProps): React.ReactElement {
  const { settings, loading, error, update } = useSettings();
  const { accounts } = useDaemon();
  const { refreshToken } = useAccounts();
  const { candidates: siblingCandidates, consume: consumeSiblingCandidate } = useSiblingCandidates();
  // Tracks which sibling is mid-enrollment so the pill button can show
  // a spinner while silent_sibling_login round-trips through the daemon.
  const [siblingAdding, setSiblingAdding] = useState<string | null>(null);

  // Active tab state. Settings is grouped into 4 tabs (General, Accounts,
  // Security, Data) so no single scroll path exceeds the 628 px tray
  // window. Default to General unless a deep-link target lives in a
  // specific tab.
  const [activeTab, setActiveTab] = useState<SettingsTabId>(() => {
    if (initialScrollTarget && ANCHOR_TO_TAB[initialScrollTarget]) {
      return ANCHOR_TO_TAB[initialScrollTarget]!;
    }
    return 'general';
  });

  // Deep-link scroll. Wait for the panel slide-in animation to settle
  // (~220 ms) before scrolling, otherwise scrollIntoView calculates against
  // the pre-animation layout and lands in the wrong spot. If the anchor
  // belongs to a different tab, switch to it first.
  useEffect(() => {
    if (!initialScrollTarget) return;
    const targetTab = ANCHOR_TO_TAB[initialScrollTarget];
    if (targetTab && targetTab !== activeTab) setActiveTab(targetTab);
    const handle = window.setTimeout(() => {
      const el = document.getElementById(initialScrollTarget);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-flash');
      window.setTimeout(() => el.classList.remove('highlight-flash'), 1500);
    }, 260);
    return () => window.clearTimeout(handle);
    // activeTab intentionally omitted — we only auto-switch on the initial
    // target; later tab changes by the user shouldn't retrigger the flash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialScrollTarget]);

  const setLaunch = (enabled: boolean): void => {
    void update({ launchAtLogin: enabled }).catch(() => undefined);
  };

  const setMode = (mode: SwitchingMode): void => {
    void update({ switchingMode: mode }).catch(() => undefined);
  };

  const setRoundRobinStrategy = (strategy: RoundRobinStrategy): void => {
    void update({ roundRobinStrategy: strategy }).catch(() => undefined);
  };

  const setAlertSound = (value: string | null): void => {
    void update({ alertSoundName: value }).catch(() => undefined);
  };

  const setOverageOsNotify = (enabled: boolean): void => {
    void update({ overageOsNotify: enabled }).catch(() => undefined);
  };

  const setAutoUpdate = (enabled: boolean): void => {
    void update({ autoUpdate: enabled }).catch(() => undefined);
  };

  const setBackgroundProbeIntervalSec = (secs: number): void => {
    void update({ backgroundProbeIntervalSec: secs }).catch(() => undefined);
  };

  const setTelemetryRetentionDays = (days: number): void => {
    void update({ telemetryRetentionDays: days }).catch(() => undefined);
  };

  const setSecurityEnabled = (enabled: boolean): void => {
    void update({ securityScanEnabled: enabled }).catch(() => undefined);
    // When turning ON, scroll so the newly-revealed enforcement + category
    // controls land near the top of the viewport. 220ms matches the deep-link
    // scroll delay so the auto-resize-window loop (ResizeObserver → Tauri
    // setSize) has time to grow the window before we compute offsets.
    if (!enabled) return;
    window.setTimeout(() => {
      const el = document.getElementById('security-enforcement-heading');
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('highlight-flash');
      window.setTimeout(() => el.classList.remove('highlight-flash'), 1500);
    }, 220);
  };
  const setEnforcementMode = (mode: SecurityEnforcementMode): void => {
    void update({ securityEnforcementMode: mode }).catch(() => undefined);
  };
  const setScanSecrets = (v: boolean): void => {
    void update({ securityScanSecrets: v }).catch(() => undefined);
  };
  const setScanInjection = (v: boolean): void => {
    void update({ securityScanInjection: v }).catch(() => undefined);
  };
  const setScanToolUse = (v: boolean): void => {
    void update({ securityScanToolUse: v }).catch(() => undefined);
  };
  const setOsNotifyThreshold = (t: SecurityOsNotifyThreshold): void => {
    void update({ securityOsNotifyThreshold: t }).catch(() => undefined);
  };
  const setPersistSnippet = (v: boolean): void => {
    void update({ securityPersistSnippet: v }).catch(() => undefined);
  };
  const setRetentionDays = (d: number): void => {
    void update({ securityEventRetentionDays: d }).catch(() => undefined);
  };
  const setBlockHoldEnabled = (v: boolean): void => {
    void update({ securityBlockHoldEnabled: v }).catch(() => undefined);
  };
  const setApproveHoldSec = (n: number): void => {
    void update({ securityApproveHoldSec: n }).catch(() => undefined);
  };
  const setToolPermissionsEnabled = (v: boolean): void => {
    void update({ toolPermissionsEnabled: v }).catch(() => undefined);
  };
  const setToolPermissionDefaultAction = (v: PermissionDecision): void => {
    void update({ toolPermissionDefaultAction: v }).catch(() => undefined);
  };
  const setToolPermissionSkipInAutoMode = (v: boolean): void => {
    void update({ toolPermissionSkipInAutoMode: v }).catch(() => undefined);
  };
  const setToolPermissionAutoModeActive = (v: boolean): void => {
    void update({ toolPermissionAutoModeActive: v }).catch(() => undefined);
  };

  const [showRulesEditor, setShowRulesEditor] = useState(false);

  const clearAllSecurityEvents = async (): Promise<void> => {
    await sendToSentinel({ type: 'clear_security_events' }).catch(() => undefined);
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

  // Sticky chrome — panel header + inner tab bar. Lifted into its own
  // node so OverlayPanel can pin it with `position: sticky; top: 0`,
  // keeping it visible while the body scrolls. See OverlayPanel.tsx for
  // the full layout invariants.
  const chrome = (
    <>
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
      <div
        role="tablist"
        aria-label="Settings categories"
        className="flex gap-1 px-4 py-2 border-b border-black/5 dark:border-white/5"
      >
        {SETTINGS_TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex-1 text-[11px] font-semibold px-2 py-1 rounded-full transition-colors ${
                active ? 'text-white' : 'text-[#8E8E93] hover:text-black dark:hover:text-white'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="settings-tab-pill"
                  className="absolute inset-0 bg-ios-blue rounded-full -z-[1]"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="relative">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </>
  );

  return (
    <OverlayPanel measureRef={measureRef} stickyChrome={chrome}>
      <div className="px-4 py-3">
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
            {activeTab === 'general' && (
            <Section title="General">
              <ToggleRow
                label="Launch at login"
                description="Start Sentinel automatically when you sign in. Recommended so Claude Code stays routed through the proxy."
                checked={settings.launchAtLogin}
                onChange={setLaunch}
              />
            </Section>
            )}

            {activeTab === 'general' && (
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
            )}

            {activeTab === 'accounts' && (
            <Section title="Account switching">
              <RadioRow
                label="Off"
                description="No automatic switching. You manage accounts manually from the Accounts tab."
                checked={settings.switchingMode === 'off'}
                onChange={() => setMode('off')}
              />
              <RadioRow
                label="Round-Robin"
                description="Rotate the OAuth token on every API request so usage drains across all accounts."
                checked={settings.switchingMode === 'round-robin'}
                onChange={() => setMode('round-robin')}
              />
              {settings.switchingMode === 'round-robin' && accounts.length > 0 && (
                <PoolMemberPreview
                  accounts={accounts}
                  excludedIds={settings.poolExcludedIds}
                />
              )}
              {settings.switchingMode === 'round-robin' && (
                <div className="px-3 pb-3 pt-1">
                  <p className="text-[11px] text-[#8E8E93] mb-1.5">Rotation strategy</p>
                  <div className="rounded-xl bg-black/[0.02] dark:bg-white/[0.03] divide-y divide-black/5 dark:divide-white/5">
                    <RadioRow
                      label="Balance"
                      description="Route each request to the lowest-utilization account, keeping the pool within ~1%. Best when you want to spread wear evenly."
                      checked={settings.roundRobinStrategy === 'balance'}
                      onChange={() => setRoundRobinStrategy('balance')}
                    />
                    <RadioRow
                      label="Earliest reset"
                      description="Pin traffic to the account whose 5-hour window resets soonest, reclaiming headroom you'd lose anyway. Rotation resumes when it blocks or rolls over."
                      checked={settings.roundRobinStrategy === 'earliest-reset'}
                      onChange={() => setRoundRobinStrategy('earliest-reset')}
                    />
                  </div>
                </div>
              )}
              {settings.switchingMode === 'round-robin' && (
                <div className="px-3 pb-3 pt-1">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[11px] text-[#8E8E93]">Overage safety buffer</p>
                    <span className="text-[11px] font-semibold text-black dark:text-white tabular-nums">
                      {settings.overageBufferPct}%
                    </span>
                  </div>
                  <p className="text-[10px] text-[#8E8E93]/80 leading-snug mb-2">
                    Round-robin stops picking an account once its 5-hour utilization reaches {100 - settings.overageBufferPct}%. A larger buffer protects against a single large request pushing you into overage; a smaller one squeezes more pool throughput.
                  </p>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    step={1}
                    value={settings.overageBufferPct}
                    onChange={(e) => {
                      void update({ overageBufferPct: Number(e.target.value) }).catch(() => undefined);
                    }}
                    className="w-full accent-ios-blue"
                  />
                  <div className="flex justify-between text-[10px] text-[#8E8E93] mt-0.5 tabular-nums">
                    <span>0%</span>
                    <span>50%</span>
                  </div>
                </div>
              )}
            </Section>
            )}

            {activeTab === 'accounts' && accounts.length > 0 && (
              <Section title="Overage spend tracking">
                <div className="px-3 pt-2.5 pb-1.5 space-y-1">
                  <p className="text-[11px] text-[#8E8E93] leading-snug">
                    Overage controls need a live claude.ai connection — Anthropic's dollar-denominated spend numbers aren't in any OAuth API, only the web session. Connect once per account; the cookie renews automatically on each fetch.
                  </p>
                </div>
                {(() => {
                  // Group accounts by email so we can render a header +
                  // sibling-add affordance for users who hold multiple
                  // orgs on a single claude.ai login. Single-account
                  // emails render without a header so nothing changes
                  // visually for the common case.
                  const groups = new Map<string, typeof accounts>();
                  for (const a of accounts) {
                    const bucket = groups.get(a.email);
                    if (bucket) bucket.push(a);
                    else groups.set(a.email, [a]);
                  }
                  return Array.from(groups.entries()).map(([email, groupAccounts]) => {
                    const pendingSiblings = siblingCandidates[email] ?? [];
                    const showHeader = groupAccounts.length > 1 || pendingSiblings.length > 0;
                    return (
                      <div key={email}>
                        {showHeader && (
                          <div className="px-3 pt-2 pb-1 flex items-center justify-between">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[#8E8E93]">
                              {email}
                            </span>
                          </div>
                        )}
                        {groupAccounts.map((a) => (
                          <ClaudeAiConnectionRow
                            key={a.id}
                            account={a}
                            overageEnabled={settings.overageEnabledIds.includes(a.id)}
                            onToggleOverage={(next) => {
                              const set = new Set(settings.overageEnabledIds);
                              if (next) set.add(a.id); else set.delete(a.id);
                              void update({ overageEnabledIds: Array.from(set) }).catch(() => undefined);
                            }}
                            budgetUsd={settings.budgetWeeklyUsdByAccount[a.id] ?? null}
                            onBudgetChange={(v) => {
                              const next = { ...settings.budgetWeeklyUsdByAccount };
                              if (v == null || v === 0) delete next[a.id];
                              else next[a.id] = v;
                              void update({ budgetWeeklyUsdByAccount: next }).catch(() => undefined);
                            }}
                            onRefresh={async () => {
                              // Parallel: refresh OAuth token (no-op on
                              // silent-enrolled stubs, which lack
                              // credentials; daemon returns a polite
                              // error that we ignore) and re-fetch
                              // claude.ai usage numbers.
                              await Promise.all([
                                refreshToken(a.id).catch(() => undefined),
                                sendToSentinel({ type: 'refresh_claude_ai_usage', accountId: a.id })
                                  .catch(() => undefined),
                              ]);
                            }}
                          />
                        ))}
                        {pendingSiblings.length > 0 && (
                          <div className="px-3 pt-1.5 pb-2 flex flex-wrap gap-1.5">
                            {pendingSiblings.map((o) => {
                              const isAdding = siblingAdding === o.orgUuid;
                              return (
                                <button
                                  key={o.orgUuid}
                                  onClick={() => {
                                    setSiblingAdding(o.orgUuid);
                                    // Fire-and-forget. The daemon will
                                    // broadcast login_complete + an
                                    // updated additional_orgs_available
                                    // when enrollment finishes; useDaemon
                                    // and useSiblingCandidates will
                                    // react to those and the UI updates
                                    // on its own.
                                    void sendToSentinel({
                                      type: 'silent_sibling_login',
                                      email,
                                      orgUuidHint: o.orgUuid,
                                    })
                                      .catch(() => undefined)
                                      .finally(() => {
                                        setSiblingAdding(null);
                                        consumeSiblingCandidate(email, o.orgUuid);
                                      });
                                  }}
                                  disabled={isAdding}
                                  className="flex items-center gap-1 text-[11px] font-semibold text-ios-blue
                                             bg-ios-blue/10 hover:bg-ios-blue/15 disabled:opacity-50
                                             active:scale-95 px-2.5 py-1 rounded-full transition-all"
                                  title={`Enroll ${o.orgName || o.orgUuid} silently via the shared sessionKey`}
                                >
                                  {isAdding
                                    ? <Loader2 size={11} className="animate-spin" />
                                    : <Plus size={11} strokeWidth={2.5} />
                                  }
                                  Add {o.orgName || o.orgUuid}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
                <div className="px-3 pt-2 pb-2 border-t border-black/5 dark:border-white/5">
                  <p className="text-[11px] font-semibold text-black dark:text-white mb-1">Global budget cap</p>
                  <p className="text-[10px] text-[#8E8E93] leading-snug mb-1.5">
                    When summed spend across all connected accounts meets this cap, every connected account is paused until Anthropic's period resets.
                  </p>
                  <BudgetInputRow
                    label="Global cap"
                    value={settings.budgetWeeklyUsdGlobal}
                    onChange={(v) => void update({ budgetWeeklyUsdGlobal: v }).catch(() => undefined)}
                  />
                </div>
              </Section>
            )}

            {activeTab === 'data' && (
            <Section title="Usage sync">
              <div className="px-3 py-2.5">
                <div className="flex items-center justify-between text-[13px] mb-0.5">
                  <span className="font-medium text-black dark:text-white">Background refresh interval</span>
                  <span className="font-semibold text-black dark:text-white tabular-nums">
                    {settings.backgroundProbeIntervalSec < 60
                      ? `${settings.backgroundProbeIntervalSec}s`
                      : `${Math.round(settings.backgroundProbeIntervalSec / 60)} min`}
                  </span>
                </div>
                <p className="text-[11px] text-[#8E8E93] leading-snug mb-2">
                  Sentinel probes each non-active account on this interval so usage stays in sync with claude.ai and other Anthropic tools. Each probe sends one minimal request per account.
                </p>
                <input
                  type="range"
                  min={60}
                  max={3600}
                  step={60}
                  value={settings.backgroundProbeIntervalSec}
                  onChange={(e) => setBackgroundProbeIntervalSec(Number(e.target.value))}
                  className="w-full accent-ios-blue"
                />
                <div className="flex justify-between text-[10px] text-[#8E8E93] mt-0.5 tabular-nums">
                  <span>1 min</span>
                  <span>60 min</span>
                </div>
              </div>
            </Section>
            )}

            {activeTab === 'data' && (
            <Section title="Data retention">
              <div className="px-3 py-2.5">
                <div className="flex items-center justify-between text-[13px] mb-0.5">
                  <span className="font-medium text-black dark:text-white">Keep telemetry for</span>
                  <span className="font-semibold text-black dark:text-white tabular-nums">
                    {settings.telemetryRetentionDays} {settings.telemetryRetentionDays === 1 ? 'day' : 'days'}
                  </span>
                </div>
                <p className="text-[11px] text-[#8E8E93] leading-snug mb-2">
                  Usage, tool, API-error, and activity rows older than this are purged at daemon startup and once every 24 hours. The Metrics tab's largest window is 30 days.
                </p>
                <input
                  type="range"
                  min={1}
                  max={365}
                  step={1}
                  value={settings.telemetryRetentionDays}
                  onChange={(e) => setTelemetryRetentionDays(Number(e.target.value))}
                  className="w-full accent-ios-blue"
                />
                <div className="flex justify-between text-[10px] text-[#8E8E93] mt-0.5 tabular-nums">
                  <span>1d</span>
                  <span>365d</span>
                </div>
              </div>
            </Section>
            )}

            {activeTab === 'general' && (
            <Section title="Notifications">
              <ToggleRow
                label="Notify on overage events"
                description="Fire a native OS notification when an account enters overage or hits its overage cap. Exit events stay silent."
                checked={settings.overageOsNotify}
                onChange={setOverageOsNotify}
              />
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
            )}

            {activeTab === 'security' && onRunSetupWizard && (
            <Section title="Setup wizard">
              <div className="px-3 py-2.5 flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-black dark:text-white">Run setup wizard</p>
                  <p className="text-[11px] text-[#8E8E93] mt-0.5 leading-snug">
                    Apply a risk profile (Low, Medium, High) that configures the scanner,
                    notifications, and tool-permission rules in one step.
                  </p>
                </div>
                <button
                  onClick={onRunSetupWizard}
                  className="flex-shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all"
                >
                  Run wizard
                </button>
              </div>
            </Section>
            )}

            {activeTab === 'security' && (
            <Section title="Security scanning">
              <div id="security-enable-toggle">
                <ToggleRow
                  label="Enable security scanning"
                  description="Scan outbound requests for secrets and risky tool calls. Findings appear in the Security tab and the Alerts tab."
                  checked={settings.securityScanEnabled}
                  onChange={setSecurityEnabled}
                />
              </div>
              {settings.securityScanEnabled && (
                <>
                  <div id="security-enforcement-heading" className="px-3 pt-2.5 pb-1">
                    <p className="text-[11px] text-[#8E8E93] mb-1">Enforcement mode</p>
                  </div>
                  <RadioRow
                    label="Observe only"
                    description="Record findings; never block. Recommended."
                    checked={settings.securityEnforcementMode === 'observe' || settings.securityEnforcementMode === null}
                    onChange={() => setEnforcementMode('observe')}
                  />
                  <RadioRow
                    label="Block on HIGH"
                    description="Stop outbound requests with a confirmed secret."
                    checked={settings.securityEnforcementMode === 'block_high'}
                    onChange={() => setEnforcementMode('block_high')}
                  />
                  <RadioRow
                    label="Block on MEDIUM and HIGH"
                    description="Stricter blocking. More false positives possible."
                    checked={settings.securityEnforcementMode === 'block_medium_high'}
                    onChange={() => setEnforcementMode('block_medium_high')}
                  />
                  {(settings.securityEnforcementMode === 'block_high' ||
                    settings.securityEnforcementMode === 'block_medium_high') && (
                    <>
                      <div className="px-3 pt-2.5 pb-1">
                        <p className="text-[11px] text-[#8E8E93] mb-1">Approve window</p>
                      </div>
                      <ToggleRow
                        label="Hold blocked requests for approval"
                        description="When a block fires, keep the request open briefly so you can approve it from a pop-up. Disabling this reverts to an immediate 403."
                        checked={settings.securityBlockHoldEnabled}
                        onChange={setBlockHoldEnabled}
                      />
                      {settings.securityBlockHoldEnabled && (
                        <div className="px-3 py-2.5">
                          <div className="flex items-center justify-between text-[11px] text-[#8E8E93] mb-1">
                            <span>Approve timeout</span>
                            <span className="font-semibold text-black dark:text-white tabular-nums">
                              {settings.securityApproveHoldSec}s
                            </span>
                          </div>
                          <input
                            type="range"
                            min={10}
                            max={300}
                            step={5}
                            value={settings.securityApproveHoldSec}
                            onChange={(e) => setApproveHoldSec(Number(e.target.value))}
                            className="w-full accent-ios-blue"
                          />
                          <p className="text-[10px] text-[#8E8E93] mt-1 leading-snug">
                            Claude Code's own timeout is 10 minutes per request, so even a 5-min
                            hold leaves ample headroom.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                  <div className="px-3 pt-2.5 pb-1">
                    <p className="text-[11px] text-[#8E8E93] mb-1">Categories</p>
                  </div>
                  <ToggleRow
                    label="Scan for secrets"
                    description="AWS keys, GitHub tokens, private keys, API credentials."
                    checked={settings.securityScanSecrets}
                    onChange={setScanSecrets}
                  />
                  <ToggleRow
                    label="Scan for prompt injection"
                    description="Heuristic detection of injection phrases and hidden unicode. Off by default (noisy on security docs and CTF content)."
                    checked={settings.securityScanInjection}
                    onChange={setScanInjection}
                  />
                  <ToggleRow
                    label="Scan model tool calls"
                    description="Inspect proposed Bash/Write/WebFetch calls in streamed responses."
                    checked={settings.securityScanToolUse}
                    onChange={setScanToolUse}
                  />
                  <div className="px-3 pt-2.5 pb-1">
                    <p className="text-[11px] text-[#8E8E93] mb-1">Notify me about</p>
                  </div>
                  <RadioRow
                    label="HIGH severity only"
                    description="Fire a native OS notification only for confirmed findings."
                    checked={settings.securityOsNotifyThreshold === 'high'}
                    onChange={() => setOsNotifyThreshold('high')}
                  />
                  <RadioRow
                    label="MEDIUM and HIGH"
                    description="Also notify for medium-confidence findings."
                    checked={settings.securityOsNotifyThreshold === 'medium'}
                    onChange={() => setOsNotifyThreshold('medium')}
                  />
                  <RadioRow
                    label="All findings"
                    description="Notify even for low-severity and synthetic telemetry events."
                    checked={settings.securityOsNotifyThreshold === 'low'}
                    onChange={() => setOsNotifyThreshold('low')}
                  />
                  <RadioRow
                    label="Never"
                    description="Silence native notifications. Findings still appear in the app."
                    checked={settings.securityOsNotifyThreshold === 'off'}
                    onChange={() => setOsNotifyThreshold('off')}
                  />
                  <div className="px-3 pt-2.5 pb-1">
                    <p className="text-[11px] text-[#8E8E93] mb-1">Privacy &amp; retention</p>
                  </div>
                  <ToggleRow
                    label="Store redacted snippet"
                    description="Keep a 40-char window around each match with the secret replaced by [REDACTED]. Disable for minimal persistence."
                    checked={settings.securityPersistSnippet}
                    onChange={setPersistSnippet}
                  />
                  <div className="px-3 py-2.5">
                    <div className="flex items-center justify-between text-[11px] text-[#8E8E93] mb-1">
                      <span>Event retention</span>
                      <span className="font-semibold text-black dark:text-white tabular-nums">
                        {settings.securityEventRetentionDays} days
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={365}
                      step={1}
                      value={settings.securityEventRetentionDays}
                      onChange={(e) => setRetentionDays(Number(e.target.value))}
                      className="w-full accent-ios-blue"
                    />
                  </div>
                  <ClearAllSecurityEventsRow onConfirm={clearAllSecurityEvents} />
                  <div className="px-3 pt-2.5 pb-1">
                    <p className="text-[11px] text-[#8E8E93] mb-1">Allowlist</p>
                    <p className="text-[10px] text-[#8E8E93] leading-snug mb-2">
                      Matches you&apos;ve chosen to always allow. Entries here are
                      silently suppressed across every future scan.
                    </p>
                  </div>
                  <AllowlistManager />
                </>
              )}
            </Section>
            )}

            {activeTab === 'security' && (
            <Section title="Tool permissions">
              <ToggleRow
                label="Enforce tool permissions"
                description="Block denied tool calls at the proxy layer. Works independently of Claude Code's own permission settings — a second enforcement layer you control."
                checked={settings.toolPermissionsEnabled}
                onChange={setToolPermissionsEnabled}
              />
              {settings.toolPermissionsEnabled && (
                <>
                  <div className="px-3 pt-2.5 pb-1">
                    <p className="text-[11px] text-[#8E8E93] mb-1">Default for unmatched tool calls</p>
                  </div>
                  <RadioRow
                    label="Allow unmatched"
                    description="Only explicit deny rules block. Recommended for most users."
                    checked={settings.toolPermissionDefaultAction === 'allow'}
                    onChange={() => setToolPermissionDefaultAction('allow')}
                  />
                  <RadioRow
                    label="Deny unmatched"
                    description="Only explicit allow rules pass. Strictest policy."
                    checked={settings.toolPermissionDefaultAction === 'deny'}
                    onChange={() => setToolPermissionDefaultAction('deny')}
                  />
                  <button
                    onClick={() => setShowRulesEditor(true)}
                    className="w-full text-left px-3 py-2.5 text-[13px] font-medium text-ios-blue hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors"
                  >
                    Manage rules…
                  </button>
                  <div className="px-3 pt-2.5 pb-1">
                    <p className="text-[11px] text-[#8E8E93] mb-1">Auto mode bypass</p>
                  </div>
                  <ToggleRow
                    label="Skip enforcement in auto mode"
                    description="When Claude Code is in auto mode, bypass every rule. Detected automatically from request headers (afk-mode / advisor-tool beta flags); the manual toggle below is a fallback."
                    checked={settings.toolPermissionSkipInAutoMode}
                    onChange={setToolPermissionSkipInAutoMode}
                  />
                  <ToggleRow
                    label="Force auto-mode skip (manual override)"
                    description="Treat every request as auto mode regardless of its headers. Use this only if automatic detection isn't picking up your session — normally you can leave it off."
                    checked={settings.toolPermissionAutoModeActive}
                    onChange={setToolPermissionAutoModeActive}
                  />
                </>
              )}
            </Section>
            )}
          </>
        )}
      </div>
      {showRulesEditor && <PermissionsEditor onClose={() => setShowRulesEditor(false)} />}
    </OverlayPanel>
  );
}

// ─── Security-specific subcomponents ──────────────────────────────────────

/** Two-click confirm for destructive buttons — Tauri webview doesn't
 *  reliably surface native confirm() dialogs, so we use an inline
 *  state instead. First click flips to a "Confirm?" button that reverts
 *  after 4s; second click within that window fires the action. */
function useInlineConfirm(action: () => void | Promise<void>, timeoutMs = 4000): {
  pending: boolean;
  trigger: () => void;
} {
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const trigger = (): void => {
    if (!pending) {
      setPending(true);
      timerRef.current = setTimeout(() => setPending(false), timeoutMs);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setPending(false);
    void action();
  };
  return { pending, trigger };
}

function ClearAllSecurityEventsRow({ onConfirm }: { onConfirm: () => Promise<void> }): React.ReactElement {
  const { pending, trigger } = useInlineConfirm(onConfirm);
  return (
    <button
      onClick={trigger}
      className={`w-full text-left px-3 py-2.5 text-[13px] font-medium transition-colors ${
        pending
          ? 'bg-ios-red/10 text-ios-red'
          : 'text-ios-red hover:bg-black/[0.02] dark:hover:bg-white/[0.03]'
      }`}
    >
      {pending ? 'Click again to permanently delete every security event' : 'Clear all security events…'}
    </button>
  );
}

/** Lists every entry on the user's allowlist, with a per-row Remove button.
 *  Empty state when the list is empty so the section reads as intentional. */
function AllowlistManager(): React.ReactElement {
  const { entries, loading, error, remove } = useSecurityAllowlist();
  if (loading) {
    return (
      <div className="px-3 py-3 text-[11px] text-[#8E8E93]">Loading…</div>
    );
  }
  if (error) {
    return <div className="px-3 py-3 text-[11px] text-ios-red">{error}</div>;
  }
  if (entries.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-[#8E8E93]">
        No entries yet. Click <span className="font-semibold">Always allow</span> on a Security-tab
        event to add one.
      </div>
    );
  }
  return (
    <div className="divide-y divide-black/5 dark:divide-white/5">
      {entries.map((entry) => (
        <AllowlistRow key={entry.id} entry={entry} onRemove={() => remove(entry.id)} />
      ))}
    </div>
  );
}

function AllowlistRow({
  entry,
  onRemove,
}: {
  entry: import('@claude-sentinel/shared').SecurityAllowlistEntry;
  onRemove: () => Promise<void>;
}): React.ReactElement {
  const { pending, trigger } = useInlineConfirm(onRemove);
  const when = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric',
  }).format(new Date(entry.createdAt));
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-black dark:text-white truncate">
          {entry.title ?? entry.detectorId}
        </p>
        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
          {entry.matchMask && (
            <code className="text-[10px] font-mono bg-[#8E8E93]/10 px-1 py-0.5 rounded truncate">
              {entry.matchMask}
            </code>
          )}
          <span className="text-[10px] text-[#8E8E93]">added {when}</span>
        </div>
        {entry.note && (
          <p className="text-[10px] text-[#8E8E93] mt-1 leading-snug">{entry.note}</p>
        )}
      </div>
      <button
        onClick={trigger}
        className={`flex-shrink-0 flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full transition-all active:scale-95 ${
          pending
            ? 'bg-ios-red text-white'
            : 'bg-ios-red/10 text-ios-red hover:bg-ios-red/20'
        }`}
        title={pending ? 'Click again to remove' : 'Remove from allowlist'}
      >
        <Trash2 size={10} strokeWidth={2.5} />
        {pending ? 'Confirm?' : 'Remove'}
      </button>
    </div>
  );
}

/**
 * Read-only preview of the round-robin pool membership. Each enrolled
 * account is rendered as a colored chip (avatar color + truncated email);
 * accounts in `excludedIds` are drawn muted and struck-through so the user
 * can see at a glance which accounts will rotate.
 *
 * Membership itself is managed on the Accounts tab (Include/Exclude
 * buttons on each card); this surface is intentionally non-editable to
 * keep a single source of truth for pool-membership toggling.
 */
/**
 * Per-account row in the "Overage spend tracking" section. Shows the
 * account identity, a Connect/Disconnect claude.ai button with status dot,
 * and — only when connected — the per-account overage-opt-in toggle and
 * weekly budget input. Disconnected rows show a CTA instead; the controls
 * are hidden until real spend data is available so users can't configure
 * a cap Sentinel has no way to enforce.
 */
function ClaudeAiConnectionRow({
  account,
  overageEnabled,
  onToggleOverage,
  budgetUsd,
  onBudgetChange,
  onRefresh,
}: {
  account: import('@claude-sentinel/shared').AccountInfo;
  overageEnabled: boolean;
  onToggleOverage: (v: boolean) => void;
  budgetUsd: number | null | undefined;
  onBudgetChange: (v: number | null) => void;
  /** Optional: fire OAuth-token + usage refresh for this account. Shown
   *  as a small refresh icon next to the status dot when `state ===
   *  'connected'`. Parent (SettingsPanel) owns the actual plumbing so
   *  the row stays ignorant of hooks. */
  onRefresh?: () => Promise<void>;
}): React.ReactElement {
  const [refreshing, setRefreshing] = React.useState(false);
  const { state, connect, disconnect, refresh, pasteSessionKey } = useClaudeAiLogin(account.id);
  // claude.ai-reported overage cap for this account. Used as the upper
  // bound on the Sentinel weekly cap below — no point letting the user
  // type a Sentinel cap higher than the amount claude.ai will actually
  // allow them to spend. limitUsd is 0 when overage isn't enabled on
  // the claude.ai side; we treat that as "no cap known yet" (no clamp).
  const { snapshot } = useClaudeAiUsage(account.id);
  // Prefer the per-user budget (from /v1/code/routines/run-budget) for
  // team accounts — extra_usage.limitUsd is null for teams anyway and
  // used_credits is a team-wide credit counter, not personal spend.
  // Individual plans (Max/Pro) stay on extraUsage.limitUsd which IS
  // their overage cap.
  const isTeam = account.planType === 'team';
  const perUserLimit = snapshot?.perUserBudget?.limitUsd ?? null;
  const claudeAiOverageCap = isTeam
    ? (perUserLimit && perUserLimit > 0 ? perUserLimit : null)
    : (snapshot?.extraUsage?.limitUsd && snapshot.extraUsage.limitUsd > 0
        ? snapshot.extraUsage.limitUsd
        : null);
  // Team account without a per-user budget configured → the admin
  // hasn't enabled the feature, so we have no personal-spend signal
  // and cap enforcement is meaningless. Surface a hint pointing the
  // user at the right person to fix it.
  const teamCapAdminOnly = isTeam
    && snapshot?.extraUsage?.isEnabled === true
    && !perUserLimit;
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteValue, setPasteValue] = React.useState('');
  const [pasteBusy, setPasteBusy] = React.useState(false);
  const [pasteError, setPasteError] = React.useState<string | null>(null);

  const submitPaste = React.useCallback(async () => {
    setPasteBusy(true);
    setPasteError(null);
    const res = await pasteSessionKey(pasteValue);
    setPasteBusy(false);
    if (res.ok) {
      setPasteOpen(false);
      setPasteValue('');
    } else {
      setPasteError(res.error);
    }
  }, [pasteSessionKey, pasteValue]);

  const dotColor =
    state === 'connected' ? 'bg-ios-green'  :
    state === 'expired'   ? 'bg-ios-orange' :
    state === 'loading'   ? 'bg-[#8E8E93]/40' :
    /* disconnected */      'bg-[#8E8E93]';
  const statusLabel =
    state === 'connected' ? 'Connected'
  : state === 'expired'   ? 'Expired'
  : state === 'loading'   ? '…'
  :                         'Not connected';

  return (
    <div className="px-3 py-3 border-b border-black/5 dark:border-white/5 last:border-0 space-y-2.5">
      {/* Header row: identity + status + action */}
      <div className="flex items-center gap-3">
        <AccountColorDot color={accountColor(account)} size="sm" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-black dark:text-white truncate">{account.displayName || account.email}</p>
          <p className="text-[11px] text-[#8E8E93] truncate">{account.email}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onRefresh && state === 'connected' && (
            <button
              onClick={async () => {
                if (refreshing) return;
                setRefreshing(true);
                try {
                  await onRefresh();
                } finally {
                  setRefreshing(false);
                }
              }}
              disabled={refreshing}
              className="text-[#8E8E93] hover:text-ios-blue disabled:opacity-40 transition-colors active:scale-90"
              title="Refresh token + usage"
            >
              <RefreshCw size={12} strokeWidth={2.5} className={refreshing ? 'animate-spin' : ''} />
            </button>
          )}
          <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
          <span className="text-[10px] font-medium text-[#8E8E93]">{statusLabel}</span>
        </div>
      </div>

      {/* Action row */}
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center justify-end gap-2">
          {state === 'disconnected' && (
            <button
              onClick={() => void connect().catch(() => undefined)}
              className="text-[11px] font-semibold text-white bg-ios-blue hover:brightness-110 px-3 py-1 rounded-full transition"
            >
              Connect claude.ai
            </button>
          )}
          {state === 'expired' && (
            <>
              <button
                onClick={() => void refresh().catch(() => undefined)}
                className="text-[11px] font-medium text-[#8E8E93] hover:text-ios-blue transition-colors"
              >
                Retry
              </button>
              <button
                onClick={() => void connect().catch(() => undefined)}
                className="text-[11px] font-semibold text-white bg-ios-blue hover:brightness-110 px-3 py-1 rounded-full transition"
              >
                Reconnect
              </button>
            </>
          )}
          {state === 'connected' && (
            <button
              onClick={() => void disconnect().catch(() => undefined)}
              className="text-[11px] font-medium text-ios-red/70 hover:text-ios-red transition-colors"
              title="Remove stored session key. Overage controls will disable until you reconnect."
            >
              Disconnect
            </button>
          )}
        </div>
        {(state === 'disconnected' || state === 'expired') && (
          <div className="flex flex-col items-end gap-1 max-w-[260px]">
            <p className="text-[10px] text-[#8E8E93]/80 leading-snug text-right">
              Use email, magic-link, or Apple login inside the window. "Continue with Google" doesn't work in embedded webviews — Google blocks them.
            </p>
            <button
              type="button"
              onClick={() => setPasteOpen((v) => !v)}
              className="text-[10px] text-ios-blue hover:brightness-110 underline underline-offset-2"
            >
              {pasteOpen ? 'Cancel manual paste' : 'Or paste sessionKey from your browser'}
            </button>
          </div>
        )}
        {pasteOpen && (state === 'disconnected' || state === 'expired') && (
          <div className="w-full mt-1 p-3 rounded-lg bg-black/5 dark:bg-white/5 space-y-2 text-left">
            <p className="text-[11px] text-[#8E8E93] leading-snug">
              In your regular browser: sign in to <span className="font-mono">claude.ai</span> with any method (Google works here), open DevTools → Application → Cookies → <span className="font-mono">claude.ai</span>, copy the value of <span className="font-mono">sessionKey</span>, and paste it below.
            </p>
            <textarea
              value={pasteValue}
              onChange={(e) => { setPasteValue(e.target.value); setPasteError(null); }}
              placeholder="sk-ant-sid01-…"
              spellCheck={false}
              className="w-full h-20 px-2 py-1.5 rounded-md text-[11px] font-mono bg-white dark:bg-black/40 border border-black/10 dark:border-white/10 focus:outline-none focus:ring-1 focus:ring-ios-blue resize-none"
            />
            {pasteError && (
              <p className="text-[10px] text-ios-red">{pasteError}</p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => { setPasteOpen(false); setPasteValue(''); setPasteError(null); }}
                className="text-[11px] font-medium text-[#8E8E93] hover:text-ios-blue transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pasteBusy || !pasteValue.trim()}
                onClick={() => void submitPaste()}
                className="text-[11px] font-semibold text-white bg-ios-blue hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1 rounded-full transition"
              >
                {pasteBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Gated controls — only visible when actually connected */}
      {state === 'connected' && (
        <div className="space-y-2 pt-1 pl-5 border-l-2 border-ios-green/30">
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <p className="text-[12px] font-medium text-black dark:text-white">Allow spending overage</p>
              <p className="text-[10px] text-[#8E8E93] leading-snug">
                Round-robin picks this account for new requests after its 5-hour quota is exhausted.
              </p>
            </div>
            <input
              type="checkbox"
              checked={overageEnabled}
              onChange={(e) => onToggleOverage(e.target.checked)}
              className="accent-ios-blue w-4 h-4"
            />
          </label>
          <BudgetInputRow
            label="Weekly cap"
            sublabel="Pauses this account when Anthropic-reported spend meets the cap"
            value={budgetUsd ?? null}
            onChange={onBudgetChange}
            maxUsd={claudeAiOverageCap}
            {...(teamCapAdminOnly
              ? { adminOnlyHint: "Team overage cap isn't exposed to non-admins. Ask an org owner for the value." }
              : {})}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Numeric USD input with a debounced write-through. Used for both the global
 * spend cap and per-account caps in the Weekly spend caps section.
 *
 * The debounce is important: typing "12.50" fires 5 keystrokes, each of
 * which would otherwise emit its own update_settings → IPC → settings_changed
 * broadcast cycle. Debouncing coalesces the bursts so the UI only writes
 * once the user stops typing.
 */
function BudgetInputRow(props: {
  label: string;
  sublabel?: string;
  leading?: React.ReactNode;
  value: number | null | undefined;
  onChange: (usd: number | null) => void;
  /** Hard upper bound. When set, typed values above this are clamped
   *  on submit. Used by the per-account weekly cap to prevent the user
   *  from ever setting a Sentinel cap higher than the overage limit
   *  they've already configured on claude.ai — spending past claude.ai's
   *  cap is physically impossible regardless of what Sentinel allows,
   *  so a higher Sentinel cap would just be a lie. */
  maxUsd?: number | null;
  /** Supplemental hint text shown when the claude.ai cap is
   *  intentionally unknown (e.g. team plans gate the cap behind
   *  admin-only endpoints). Replaces the "cap: $X" auto-hint for this
   *  case so the user knows the ceiling is absent-by-policy rather
   *  than absent-by-bug. */
  adminOnlyHint?: string;
}): React.ReactElement {
  const [text, setText] = useState<string>(
    props.value != null && props.value > 0 ? props.value.toFixed(2) : '',
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the input in sync when the underlying setting changes externally.
  useEffect(() => {
    const next = props.value != null && props.value > 0 ? props.value.toFixed(2) : '';
    // Only adopt external changes when the local text is "clean" — i.e.
    // matches what we'd render for the current value. Prevents clobbering
    // a user mid-edit.
    if (text === '' || Number(text) === props.value) {
      setText(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  const onChangeDebounced = (raw: string): void => {
    setText(raw);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const trimmed = raw.trim();
      if (trimmed === '') {
        props.onChange(null);
        return;
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) return;
      const clamped = props.maxUsd != null && props.maxUsd > 0 && n > props.maxUsd ? props.maxUsd : n;
      if (clamped !== n) {
        // Reflect the clamp in the input so the user sees why the stored
        // value differs from what they typed.
        setText(clamped.toFixed(2));
      }
      props.onChange(clamped);
    }, 400);
  };

  const hint = props.adminOnlyHint
    ? props.adminOnlyHint
    : (props.maxUsd != null && props.maxUsd > 0
        ? `claude.ai overage cap: $${props.maxUsd.toFixed(2)}`
        : null);

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      {props.leading && <div className="flex-shrink-0">{props.leading}</div>}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-black dark:text-white truncate">{props.label}</p>
        {props.sublabel && (
          <p className="text-[11px] text-[#8E8E93] truncate">{props.sublabel}</p>
        )}
        {hint && (
          <p className="text-[10px] text-[#8E8E93]/80 truncate">{hint}</p>
        )}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[12px] text-[#8E8E93]">$</span>
        <input
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(e) => onChangeDebounced(e.target.value)}
          placeholder="none"
          className="w-20 px-2 py-1 rounded-md text-right text-[13px] tabular-nums bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white placeholder:text-[#8E8E93]/60 focus:outline-none focus:ring-2 focus:ring-ios-blue/40"
        />
      </div>
    </div>
  );
}

function PoolMemberPreview({
  accounts,
  excludedIds,
}: {
  accounts: import('@claude-sentinel/shared').AccountInfo[];
  excludedIds: readonly string[];
}): React.ReactElement {
  const excludedSet = new Set(excludedIds);
  const rotating = accounts.filter((a) => !excludedSet.has(a.id));
  return (
    <div className="px-3 pb-2 pt-1">
      <div className="flex items-baseline justify-between mb-1.5">
        <p className="text-[11px] text-[#8E8E93]">
          Pool <span className="tabular-nums">({rotating.length} rotating)</span>
        </p>
        <span className="text-[10px] text-[#8E8E93]/70">Manage on Accounts tab</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {accounts.map((a) => {
          const excluded = excludedSet.has(a.id);
          return (
            <span
              key={a.id}
              className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full transition-opacity ${
                excluded
                  ? 'bg-[#8E8E93]/10 text-[#8E8E93] line-through opacity-60'
                  : 'bg-black/[0.04] dark:bg-white/[0.05] text-black dark:text-white'
              }`}
              title={excluded ? `${a.email} — excluded from pool` : a.email}
            >
              <AccountColorDot color={accountColor(a)} size="xs" />
              <span className="max-w-[140px] truncate">{a.displayName || a.email}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
