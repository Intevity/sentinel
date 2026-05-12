import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, Volume2, Trash2, RefreshCw } from 'lucide-react';
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
import { useInlineConfirm } from '../hooks/useInlineConfirm.js';
import { usePermissionBypasses } from '../hooks/usePermissionBypasses.js';
import { useClaudeSyncStatus } from '../hooks/useClaudeSyncStatus.js';
import { useOtelExporter } from '../hooks/useOtelExporter.js';
import { useScanBenchmark } from '../hooks/useScanBenchmark.js';
import { useDaemon } from '../hooks/useDaemon.js';
import { useClaudeAiUsage } from '../hooks/useClaudeAiUsage.js';
import { useAccounts } from '../hooks/useAccounts.js';
import { accountColor } from '../lib/accountColor.js';
import { planLabel } from '../lib/plan.js';
import AccountColorDot from './AccountColorDot.js';
import OverlayPanel from './OverlayPanel.js';
import { Section, ToggleRow, RadioRow, SettingsCard } from './settings/primitives.js';

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
  'tool-permissions-toggle': 'security',
  'oversized-threshold-slider': 'security',
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
  /** Close the panel and open the Tool-permission-rules editor. Provided
   *  by the parent so the rules editor renders at App level (outside the
   *  Settings scroll container) — otherwise the editor positions itself
   *  to the top of the scroll area and appears off-screen when the user
   *  is scrolled down to the Security tab. */
  onManageRules?: () => void;
  /** Close the panel and open the security overlay on the Allowlist tab.
   *  Symmetric with onManageRules — lets the Allowlist section act as a
   *  deep-link rather than rendering its entries inline. */
  onManageAllowlist?: () => void;
}

/**
 * Full-surface settings screen, rendered as an overlay within the 420×600
 * tray window. Reached by the cog icon in the header. Writes propagate to the
 * daemon via `update_settings` — no Save button, every change persists live.
 */
export default function SettingsPanel({
  onClose,
  measureRef,
  initialScrollTarget,
  onRunSetupWizard,
  onManageRules,
  onManageAllowlist,
}: SettingsPanelProps): React.ReactElement {
  const { settings, loading, error, update } = useSettings();
  const { accounts } = useDaemon();
  const { refreshToken } = useAccounts();

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

  const setAlternateApiUrl = (value: string | null): void => {
    void update({ alternateApiUrl: value }).catch(() => undefined);
  };

  const setCacheTtlForceOneHour = (enabled: boolean): void => {
    void update({ cacheTtlForceOneHour: enabled }).catch(() => undefined);
  };

  const setBackgroundProbeIntervalSec = (secs: number): void => {
    void update({ backgroundProbeIntervalSec: secs }).catch(() => undefined);
  };

  const setTelemetryRetentionDays = (days: number): void => {
    void update({ telemetryRetentionDays: days }).catch(() => undefined);
  };

  const setSecurityContextVerbosity = (v: 'compact' | 'standard' | 'verbose'): void => {
    void update({ securityContextVerbosity: v }).catch(() => undefined);
  };

  const setRequestLoggingEnabled = (enabled: boolean): void => {
    void update({ requestLoggingEnabled: enabled }).catch(() => undefined);
  };
  const setRequestLogRetentionDays = (days: number): void => {
    void update({ requestLogRetentionDays: days }).catch(() => undefined);
  };
  const setRequestLogMaxBodyKb = (kb: number): void => {
    void update({ requestLogMaxBodyKb: kb }).catch(() => undefined);
  };
  const setRequestLogCaptureResponse = (v: boolean): void => {
    void update({ requestLogCaptureResponse: v }).catch(() => undefined);
  };
  const setRequestLogRedactAuthHeaders = (v: boolean): void => {
    void update({ requestLogRedactAuthHeaders: v }).catch(() => undefined);
  };
  const setOptimizeCaptureEnabled = (v: boolean): void => {
    void update({ optimizeCaptureEnabled: v }).catch(() => undefined);
  };
  const setOptimizeAutoRecommend = (v: boolean): void => {
    void update({ optimizeAutoRecommend: v }).catch(() => undefined);
  };
  const setOptimizeShowMicroOpportunities = (v: boolean): void => {
    void update({ optimizeShowMicroOpportunities: v }).catch(() => undefined);
  };
  const setOtelForwardingEnabled = (v: boolean): void => {
    void update({ otelForwardingEnabled: v }).catch(() => undefined);
  };
  const setOtelForwardMetrics = (v: boolean): void => {
    void update({ otelForwardMetrics: v }).catch(() => undefined);
  };
  const setOtelForwardLogs = (v: boolean): void => {
    void update({ otelForwardLogs: v }).catch(() => undefined);
  };
  const setOtelEmitSentinelMetrics = (v: boolean): void => {
    void update({ otelEmitSentinelMetrics: v }).catch(() => undefined);
  };
  const setOtelExporterEndpoint = (value: string): void => {
    const trimmed = value.trim();
    void update({ otelExporterEndpoint: trimmed === '' ? null : trimmed }).catch(() => undefined);
  };
  const setOtelExporterHeaderName = (value: string): void => {
    void update({ otelExporterHeaderName: value }).catch(() => undefined);
  };
  const [requestLogClearConfirm, setRequestLogClearConfirm] = useState(false);
  const clearRequestLogsConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (clearRequestLogsConfirmTimerRef.current) {
        clearTimeout(clearRequestLogsConfirmTimerRef.current);
      }
    },
    [],
  );
  const triggerClearRequestLogs = (): void => {
    if (!requestLogClearConfirm) {
      setRequestLogClearConfirm(true);
      clearRequestLogsConfirmTimerRef.current = setTimeout(
        () => setRequestLogClearConfirm(false),
        4000,
      );
      return;
    }
    if (clearRequestLogsConfirmTimerRef.current) {
      clearTimeout(clearRequestLogsConfirmTimerRef.current);
    }
    setRequestLogClearConfirm(false);
    void sendToSentinel({ type: 'clear_request_logs' }).catch(() => undefined);
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
  const setClaudeCodeSyncEnabled = (v: boolean): void => {
    void update({ claudeCodeSyncEnabled: v }).catch(() => undefined);
  };
  const setIncidentReplayEnabled = (v: boolean): void => {
    void update({ securityIncidentReplay: v }).catch(() => undefined);
  };
  const setOversizedThresholdMb = (n: number): void => {
    void update({ securityOversizedThresholdMb: n }).catch(() => undefined);
  };
  const setScanOversizedSync = (v: boolean): void => {
    void update({ securityScanOversizedSync: v }).catch(() => undefined);
  };
  const setMuteScanDeferred = (v: boolean): void => {
    void update({ securityMuteScanDeferred: v }).catch(() => undefined);
  };
  const setMuteScanTruncated = (v: boolean): void => {
    void update({ securityMuteScanTruncated: v }).catch(() => undefined);
  };
  const setMuteScanSkipped = (v: boolean): void => {
    void update({ securityMuteScanSkipped: v }).catch(() => undefined);
  };

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
        <span className="text-[15px] font-semibold text-black dark:text-white tracking-tight">
          Settings
        </span>
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

        {!loading && error && <p className="text-[12px] text-ios-red">{error}</p>}

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

            {activeTab === 'general' && (
              <Section title="Prompt caching">
                <ToggleRow
                  label="Force 1h cache TTL"
                  description="Rewrites outbound cache_control blocks to request 1 hour retention so Pro accounts match Max/Team behavior. Effectiveness is visible in Usage: Cache TTL; Anthropic may still enforce a shorter TTL server-side on some tiers."
                  checked={settings.cacheTtlForceOneHour}
                  onChange={setCacheTtlForceOneHour}
                />
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
                  <PoolMemberPreview accounts={accounts} excludedIds={settings.poolExcludedIds} />
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
                      Round-robin stops picking an account once its 5-hour (or Sonnet 7-day)
                      utilization reaches {100 - settings.overageBufferPct}%. A larger buffer
                      protects against a single large request pushing you into overage; a smaller
                      one squeezes more pool throughput.
                    </p>
                    <input
                      type="range"
                      min={0}
                      max={50}
                      step={1}
                      value={settings.overageBufferPct}
                      onChange={(e) => {
                        void update({ overageBufferPct: Number(e.target.value) }).catch(
                          () => undefined,
                        );
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
                    Per-account overage controls and weekly caps. Sentinel reads dollar spend from
                    Anthropic&apos;s OAuth usage endpoint using the sign-in you already completed on
                    Add Account.
                  </p>
                </div>
                {accounts.map((a) => (
                  <ClaudeAiConnectionRow
                    key={a.id}
                    account={a}
                    overageEnabled={settings.overageEnabledIds.includes(a.id)}
                    onToggleOverage={(next) => {
                      const set = new Set(settings.overageEnabledIds);
                      if (next) set.add(a.id);
                      else set.delete(a.id);
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
                      await Promise.all([
                        refreshToken(a.id).catch(() => undefined),
                        sendToSentinel({
                          type: 'refresh_claude_ai_usage',
                          accountId: a.id,
                        }).catch(() => undefined),
                      ]);
                    }}
                  />
                ))}
                <div className="px-3 pt-2 pb-2 border-t border-black/5 dark:border-white/5">
                  <p className="text-[11px] font-semibold text-black dark:text-white mb-1">
                    Global budget cap
                  </p>
                  <p className="text-[10px] text-[#8E8E93] leading-snug mb-1.5">
                    When summed spend across all connected accounts meets this cap, every connected
                    account is paused until Anthropic&apos;s period resets.
                  </p>
                  <BudgetInputRow
                    label="Global cap"
                    value={settings.budgetWeeklyUsdGlobal}
                    onChange={(v) =>
                      void update({ budgetWeeklyUsdGlobal: v }).catch(() => undefined)
                    }
                  />
                </div>
              </Section>
            )}

            {activeTab === 'data' && (
              <Section title="Usage sync">
                <div className="px-3 py-2.5">
                  <div className="flex items-center justify-between text-[13px] mb-0.5">
                    <span className="font-medium text-black dark:text-white">
                      Background refresh interval
                    </span>
                    <span className="font-semibold text-black dark:text-white tabular-nums">
                      {settings.backgroundProbeIntervalSec < 60
                        ? `${settings.backgroundProbeIntervalSec}s`
                        : `${Math.round(settings.backgroundProbeIntervalSec / 60)} min`}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#8E8E93] leading-snug mb-2">
                    Sentinel probes each non-active account on this interval so usage stays in sync
                    with claude.ai and other Anthropic tools. Each probe sends one minimal request
                    per account.
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
                    <span className="font-medium text-black dark:text-white">
                      Keep telemetry for
                    </span>
                    <span className="font-semibold text-black dark:text-white tabular-nums">
                      {settings.telemetryRetentionDays}{' '}
                      {settings.telemetryRetentionDays === 1 ? 'day' : 'days'}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#8E8E93] leading-snug mb-2">
                    Usage, tool, API-error, and activity rows older than this are purged at daemon
                    startup and once every 24 hours. The Metrics tab's largest window is 30 days.
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

            {activeTab === 'data' && (
              <Section title="Request logging">
                <ToggleRow
                  label="Capture API request/response bodies"
                  description="When on, every proxied Claude API call is recorded to ~/.claude-sentinel/request-logs.db and surfaced in the Logs tab as an expandable row. Captured bodies include prompts and model output, so this is off by default."
                  checked={settings.requestLoggingEnabled}
                  onChange={setRequestLoggingEnabled}
                />
                <div
                  className={`px-3 py-2.5 ${settings.requestLoggingEnabled ? '' : 'opacity-50 pointer-events-none'}`}
                >
                  <div className="flex items-center justify-between text-[13px] mb-0.5">
                    <span className="font-medium text-black dark:text-white">
                      Keep request logs for
                    </span>
                    <span className="font-semibold text-black dark:text-white tabular-nums">
                      {settings.requestLogRetentionDays}{' '}
                      {settings.requestLogRetentionDays === 1 ? 'day' : 'days'}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#8E8E93] leading-snug mb-2">
                    Rows older than this are purged at daemon startup and once every 24 hours.
                    Bodies are large, so a shorter default than telemetry retention keeps disk usage
                    bounded.
                  </p>
                  <input
                    type="range"
                    min={1}
                    max={90}
                    step={1}
                    value={settings.requestLogRetentionDays}
                    onChange={(e) => setRequestLogRetentionDays(Number(e.target.value))}
                    className="w-full accent-ios-blue"
                  />
                  <div className="flex justify-between text-[10px] text-[#8E8E93] mt-0.5 tabular-nums">
                    <span>1d</span>
                    <span>90d</span>
                  </div>
                </div>
                <div
                  className={`px-3 py-2.5 ${settings.requestLoggingEnabled ? '' : 'opacity-50 pointer-events-none'}`}
                >
                  <div className="flex items-center justify-between text-[13px] mb-0.5">
                    <span className="font-medium text-black dark:text-white">Max body size</span>
                    <span className="font-semibold text-black dark:text-white tabular-nums">
                      {settings.requestLogMaxBodyKb} KB
                    </span>
                  </div>
                  <p className="text-[11px] text-[#8E8E93] leading-snug mb-2">
                    Applied independently to request and response bodies. Larger bodies are
                    truncated in storage; the proxy still forwards the full stream to Claude Code.
                  </p>
                  <input
                    type="range"
                    min={1}
                    max={5000}
                    step={1}
                    value={settings.requestLogMaxBodyKb}
                    onChange={(e) => setRequestLogMaxBodyKb(Number(e.target.value))}
                    className="w-full accent-ios-blue"
                  />
                  <div className="flex justify-between text-[10px] text-[#8E8E93] mt-0.5 tabular-nums">
                    <span>1 KB</span>
                    <span>5 MB</span>
                  </div>
                </div>
                <div
                  className={settings.requestLoggingEnabled ? '' : 'opacity-50 pointer-events-none'}
                >
                  <ToggleRow
                    label="Capture response bodies"
                    description="Turn off to store only the request side. Useful when debugging your own prompts without persisting large model outputs."
                    checked={settings.requestLogCaptureResponse}
                    onChange={setRequestLogCaptureResponse}
                  />
                  <ToggleRow
                    label="Redact Authorization header"
                    description="When on, the OAuth bearer token is replaced with [REDACTED] before storage. Static API keys and cookies are always redacted regardless of this setting."
                    checked={settings.requestLogRedactAuthHeaders}
                    onChange={setRequestLogRedactAuthHeaders}
                  />
                </div>
                <div className="px-3 py-2.5 flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-black dark:text-white">
                      Clear all request logs
                    </p>
                    <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">
                      Permanently deletes every captured request/response pair. Does not change the
                      toggle above.
                    </p>
                  </div>
                  <button
                    onClick={triggerClearRequestLogs}
                    className={`text-[11px] font-semibold transition-opacity active:scale-95 px-2.5 py-1 rounded-full ${
                      requestLogClearConfirm
                        ? 'bg-ios-red text-white'
                        : 'bg-ios-red/10 text-ios-red hover:bg-ios-red/20'
                    }`}
                    title={
                      requestLogClearConfirm ? 'Click again to confirm' : 'Clear all request logs'
                    }
                  >
                    <Trash2 size={11} strokeWidth={2.5} className="inline mr-1" />
                    {requestLogClearConfirm ? 'Click again' : 'Clear'}
                  </button>
                </div>
              </Section>
            )}

            {activeTab === 'data' && (
              <Section title="Optimize">
                <div className="px-3 py-2.5">
                  <p className="text-[11px] text-[#8E8E93] leading-snug">
                    Optimize captures file paths and tool call sizes (not contents) so it can
                    suggest cheaper-model subagents for routine tasks. Routing happens through
                    Claude Code's own subagent system; Sentinel never reroutes traffic silently.
                  </p>
                </div>
                <ToggleRow
                  label="Enable optimization capture"
                  description="When off, no tool_calls rows are recorded; the analyzer becomes a no-op. Existing installed subagents keep working."
                  checked={settings.optimizeCaptureEnabled}
                  onChange={setOptimizeCaptureEnabled}
                />
                <div
                  className={
                    settings.optimizeCaptureEnabled ? '' : 'opacity-50 pointer-events-none'
                  }
                >
                  <ToggleRow
                    label="Auto-recommend subagents"
                    description="Show recommended curated subagents based on observed session patterns. Turn off to keep capture on without nudges."
                    checked={settings.optimizeAutoRecommend}
                    onChange={setOptimizeAutoRecommend}
                  />
                  <ToggleRow
                    label="Show low-value opportunities"
                    description="Surface individual recommendations under $0.10 estimated savings. Off by default; they aggregate into a totals strip on the Optimize tab instead."
                    checked={settings.optimizeShowMicroOpportunities}
                    onChange={setOptimizeShowMicroOpportunities}
                  />
                </div>
              </Section>
            )}

            {activeTab === 'data' && (
              <Section title="External OTEL forwarding">
                <div className="px-3 py-2.5">
                  <p className="text-[11px] text-[#8E8E93] leading-snug">
                    Relay Claude Code's OTEL metrics and logs to an external observability backend
                    like SigNoz Cloud. Sentinel keeps storing telemetry locally for the Metrics tab;
                    this adds an outbound copy and emits Sentinel-specific signals such as the Cache
                    TTL breakdown, tagged with service.name=claude-sentinel.
                  </p>
                </div>
                <ToggleRow
                  label="Enable forwarding"
                  description="When off, no outbound HTTP fires regardless of the fields below."
                  checked={settings.otelForwardingEnabled}
                  onChange={setOtelForwardingEnabled}
                />
                <div
                  className={settings.otelForwardingEnabled ? '' : 'opacity-50 pointer-events-none'}
                >
                  <div className="px-3 py-2.5">
                    <label
                      htmlFor="otel-endpoint"
                      className="block text-[13px] font-medium text-black dark:text-white mb-1"
                    >
                      OTLP/HTTP endpoint
                    </label>
                    <input
                      id="otel-endpoint"
                      type="text"
                      value={settings.otelExporterEndpoint ?? ''}
                      placeholder="https://ingest.us2.signoz.cloud:443"
                      onChange={(e) => setOtelExporterEndpoint(e.target.value)}
                      className="w-full px-2 py-1 text-[12px] border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-black dark:text-white"
                    />
                    <p className="text-[11px] text-[#8E8E93] mt-1 leading-snug">
                      Sentinel appends /v1/metrics and /v1/logs to this base. HTTPS required except
                      on localhost.
                    </p>
                  </div>
                  <div className="px-3 py-2.5">
                    <label
                      htmlFor="otel-header-name"
                      className="block text-[13px] font-medium text-black dark:text-white mb-1"
                    >
                      Auth header name
                    </label>
                    <input
                      id="otel-header-name"
                      type="text"
                      value={settings.otelExporterHeaderName}
                      onChange={(e) => setOtelExporterHeaderName(e.target.value)}
                      className="w-full px-2 py-1 text-[12px] border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-black dark:text-white"
                    />
                    <p className="text-[11px] text-[#8E8E93] mt-1 leading-snug">
                      The HTTP header name used to carry your ingestion key. SigNoz uses
                      &quot;signoz-ingestion-key&quot;; other backends differ.
                    </p>
                  </div>
                  <OtelSecretRow />
                  <ToggleRow
                    label="Forward metrics"
                    description="Tee the /v1/metrics OTLP/HTTP bodies Sentinel receives from Claude Code."
                    checked={settings.otelForwardMetrics}
                    onChange={setOtelForwardMetrics}
                  />
                  <ToggleRow
                    label="Forward logs"
                    description="Tee the /v1/logs OTLP/HTTP bodies Sentinel receives from Claude Code."
                    checked={settings.otelForwardLogs}
                    onChange={setOtelForwardLogs}
                  />
                  <ToggleRow
                    label="Emit Sentinel custom metrics"
                    description="Adds Sentinel-specific signals (cache TTL breakdown, per-account 5h usage, account switches, security events, proxy traffic) on a 30s cadence. Tagged with service.name=claude-sentinel so dashboards can split them from the Claude Code stream."
                    checked={settings.otelEmitSentinelMetrics}
                    onChange={setOtelEmitSentinelMetrics}
                  />
                  <OtelStatusRow />
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
                      <p className="text-[13px] font-medium text-black dark:text-white">
                        Alert sound
                      </p>
                      <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">
                        Played when a usage alert or exhaustion notification fires. Uses macOS
                        system sounds.
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
                      <option key={s.label} value={s.value ?? ''}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </Section>
            )}

            {activeTab === 'general' && (
              <SettingsCard
                title="Advanced"
                {...(settings.alternateApiUrl ? { summary: 'Alternate API URL set' } : {})}
              >
                <AlternateApiUrlRow
                  value={settings.alternateApiUrl}
                  onChange={setAlternateApiUrl}
                />
              </SettingsCard>
            )}

            {activeTab === 'security' && onRunSetupWizard && (
              <Section title="Setup wizard">
                <div className="px-3 py-2.5 flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-black dark:text-white">
                      Run setup wizard
                    </p>
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
                      checked={
                        settings.securityEnforcementMode === 'observe' ||
                        settings.securityEnforcementMode === null
                      }
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
                            Every block is held briefly so you can approve it. Claude Code's own
                            timeout is 10 minutes per request, so even a 5 minute hold leaves ample
                            headroom.
                          </p>
                        </div>
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
                      description="Keep a window of redacted context around each match. The size is the same for every alert regardless of severity; pick the verbosity below."
                      checked={settings.securityPersistSnippet}
                      onChange={setPersistSnippet}
                    />
                    <div
                      className={
                        settings.securityPersistSnippet ? '' : 'opacity-50 pointer-events-none'
                      }
                    >
                      <RadioRow
                        label="Compact (40 chars per side)"
                        description="Minimal context. Smallest database footprint."
                        checked={settings.securityContextVerbosity === 'compact'}
                        onChange={() => setSecurityContextVerbosity('compact')}
                      />
                      <RadioRow
                        label="Standard (200 chars per side)"
                        description="Recommended. Enough surrounding prose to read the match in situ."
                        checked={settings.securityContextVerbosity === 'standard'}
                        onChange={() => setSecurityContextVerbosity('standard')}
                      />
                      <RadioRow
                        label="Verbose (800 chars per side)"
                        description="Forensic-grade context for investigation. Best when alerts are rare."
                        checked={settings.securityContextVerbosity === 'verbose'}
                        onChange={() => setSecurityContextVerbosity('verbose')}
                      />
                    </div>
                    <ToggleRow
                      label="Capture forensic incident replay"
                      description="When a high-severity event blocks a request, snapshot the recent tool-use messages from that session to help reconstruct what happened. Privacy-sensitive: messages persist until retention sweeps them. Off by default."
                      checked={settings.securityIncidentReplay}
                      onChange={setIncidentReplayEnabled}
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
                        max={3650}
                        step={1}
                        value={settings.securityEventRetentionDays}
                        onChange={(e) => setRetentionDays(Number(e.target.value))}
                        className="w-full accent-ios-blue"
                      />
                    </div>
                    <ClearAllSecurityEventsRow onConfirm={clearAllSecurityEvents} />
                  </>
                )}
              </Section>
            )}

            {activeTab === 'security' && settings.securityScanEnabled && (
              <Section title="Allowlist">
                <div className="px-3 pt-2.5 pb-1">
                  <p className="text-[10px] text-[#8E8E93] leading-snug mb-2">
                    Matches you&apos;ve chosen to always allow. Added by clicking
                    <span className="font-semibold"> Always allow</span> on a finding in the
                    Security tab.
                  </p>
                </div>
                <button
                  onClick={() => onManageAllowlist?.()}
                  className="w-full text-left px-3 py-2.5 text-[13px] font-medium text-ios-blue hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors"
                >
                  Manage allowlist…
                </button>
              </Section>
            )}

            {activeTab === 'security' && settings.securityScanEnabled && (
              <Section title="Oversized request scanning">
                <TuneForSystemSubsection bench={settings.lastScanBenchmark} />
                <div id="oversized-threshold-slider" className="px-3 pt-2.5 pb-1">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[12px] font-medium text-black dark:text-white">
                      Deferred-scan threshold
                    </p>
                    <span className="text-[11px] font-semibold tabular-nums text-ios-blue">
                      {settings.securityOversizedThresholdMb} MB
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={16}
                    step={1}
                    value={settings.securityOversizedThresholdMb}
                    onChange={(e) => setOversizedThresholdMb(Number(e.target.value))}
                    className="w-full accent-ios-blue"
                    aria-label="Deferred-scan threshold in megabytes"
                  />
                  <p className="text-[10px] text-[#8E8E93] leading-snug mt-1.5">
                    Requests larger than this are scanned asynchronously off the proxy&apos;s hot
                    path; detection still runs, but block-on-match doesn&apos;t. Raise it if you get
                    noisy
                    <code className="text-[9.5px] font-mono bg-[#8E8E93]/10 px-1 mx-0.5 rounded">
                      Scan Deferred
                    </code>
                    alerts on normal-sized requests; lower it to push smaller payloads through the
                    full synchronous gate.
                  </p>
                </div>
                <ToggleRow
                  label="Scan large requests synchronously"
                  description="Run the full block-decision gate on bodies above the threshold. Adds latency to large requests but catches block-mode violations inline. When off (default), oversized bodies are scanned async and you see a Scan Deferred telemetry event."
                  checked={settings.securityScanOversizedSync}
                  onChange={setScanOversizedSync}
                />
                <div className="px-3 pt-2.5 pb-1">
                  <p className="text-[11px] text-[#8E8E93] mb-1">Mute telemetry events</p>
                </div>
                <ToggleRow
                  label="Scan Deferred"
                  description="Hide informational alerts fired when a request exceeds the threshold above. Muting doesn't change scanning behaviour; it only suppresses the telemetry notice."
                  checked={settings.securityMuteScanDeferred}
                  onChange={setMuteScanDeferred}
                />
                <ToggleRow
                  label="Scan Truncated"
                  description="Hide alerts fired when an SSE response tap fills its 2 MB buffer. Detection still runs on the portion that fit."
                  checked={settings.securityMuteScanTruncated}
                  onChange={setMuteScanTruncated}
                />
                <ToggleRow
                  label="Scan Skipped"
                  description="Hide alerts fired when a body can't be parsed (e.g. non-UTF-8 encoding). Nothing to scan in that case; the alert is purely informational."
                  checked={settings.securityMuteScanSkipped}
                  onChange={setMuteScanSkipped}
                />
              </Section>
            )}

            {activeTab === 'security' && (
              <Section title="Tool permissions">
                <div id="tool-permissions-toggle">
                  <ToggleRow
                    label="Enforce tool permissions"
                    description="Block denied tool calls at the proxy layer. Works independently of Claude Code's own permission settings; a second enforcement layer you control."
                    checked={settings.toolPermissionsEnabled}
                    onChange={setToolPermissionsEnabled}
                  />
                </div>
                {settings.toolPermissionsEnabled && (
                  <>
                    <div className="px-3 pt-2.5 pb-1">
                      <p className="text-[11px] text-[#8E8E93] mb-1">
                        Default for unmatched tool calls
                      </p>
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
                      onClick={() => onManageRules?.()}
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
                      description="Treat every request as auto mode regardless of its headers. Use this only if automatic detection isn't picking up your session; normally you can leave it off."
                      checked={settings.toolPermissionAutoModeActive}
                      onChange={setToolPermissionAutoModeActive}
                    />
                  </>
                )}
              </Section>
            )}

            {activeTab === 'security' && settings.toolPermissionsEnabled && (
              <Section title="Permission bypasses">
                <div className="px-3 pt-2 pb-1.5 text-[11px] text-[#8E8E93] leading-snug">
                  Per-rule allow-through, recorded when you tick{' '}
                  <span className="font-semibold">Always allow this exact input</span> on a tool-use
                  approval banner. Remove an entry to re-trigger the banner next time that exact
                  tool call appears.
                </div>
                <BypassesManager />
              </Section>
            )}

            {activeTab === 'security' && (
              <Section title="Claude Code sync">
                <ClaudeCodeSyncSubsection
                  enabled={settings.claudeCodeSyncEnabled}
                  onToggle={setClaudeCodeSyncEnabled}
                />
              </Section>
            )}
          </>
        )}
      </div>
    </OverlayPanel>
  );
}

// ─── External OTEL forwarding subcomponents ──────────────────────────────

/** Secret input + Save/Clear buttons + status pill. The secret value
 *  itself is write-only: the daemon never echoes it back, and the UI
 *  only ever sees a `secretConfigured` boolean. Mirrors the precedent
 *  set by `securityWebhookSecret`. */
function OtelSecretRow(): React.ReactElement {
  const { status, setSecret, clearSecret, test } = useOtelExporter();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const onSave = async (): Promise<void> => {
    if (draft === '') return;
    setSaving(true);
    try {
      await setSecret(draft);
      setDraft('');
    } finally {
      setSaving(false);
    }
  };

  const onClear = async (): Promise<void> => {
    setSaving(true);
    try {
      await clearSecret();
    } finally {
      setSaving(false);
    }
  };

  const onTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await test();
      if (!result) {
        setTestResult('Test failed: no response from daemon');
        return;
      }
      setTestResult(
        result.ok ? `Test ok (HTTP ${result.status ?? '???'})` : `Test failed: ${result.message}`,
      );
    } finally {
      setTesting(false);
    }
  };

  const configured = status?.secretConfigured ?? false;

  return (
    <div className="px-3 py-2.5">
      <label
        htmlFor="otel-secret"
        className="block text-[13px] font-medium text-black dark:text-white mb-1"
      >
        Ingestion key (secret)
      </label>
      <div className="flex gap-2">
        <input
          id="otel-secret"
          type="password"
          autoComplete="off"
          value={draft}
          placeholder={configured ? 'configured (paste a new value to replace)' : 'paste your key'}
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1 px-2 py-1 text-[12px] border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-black dark:text-white"
        />
        <button
          type="button"
          onClick={() => {
            void onSave();
          }}
          disabled={saving || draft === ''}
          className="px-2.5 py-1 text-[12px] font-medium rounded bg-ios-blue text-white disabled:opacity-50"
        >
          Save
        </button>
        {configured && (
          <button
            type="button"
            onClick={() => {
              void onClear();
            }}
            disabled={saving}
            className="px-2.5 py-1 text-[12px] font-medium rounded border border-gray-300 dark:border-gray-700 text-ios-red disabled:opacity-50"
          >
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void onTest();
          }}
          disabled={testing || !configured}
          className="px-2.5 py-1 text-[12px] font-medium rounded border border-gray-300 dark:border-gray-700 text-black dark:text-white disabled:opacity-50"
          title="Send a synthetic OTLP request to verify the endpoint and key"
        >
          Test
        </button>
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <span
          className={`text-[11px] font-medium ${configured ? 'text-ios-green' : 'text-[#8E8E93]'}`}
        >
          {configured ? 'Key: configured' : 'Key: not set'}
        </span>
        {testResult !== null && (
          <span
            className={`text-[11px] ${testResult.startsWith('Test ok') ? 'text-ios-green' : 'text-ios-red'}`}
          >
            {testResult}
          </span>
        )}
      </div>
    </div>
  );
}

/** Compact status row: counters + last-error if any. Reads from the
 *  same `useOtelExporter` hook so it stays live without polling. */
function OtelStatusRow(): React.ReactElement {
  const { status } = useOtelExporter();
  if (!status) {
    return <div className="px-3 py-2 text-[11px] text-[#8E8E93]">Loading status…</div>;
  }
  const lastOk =
    status.lastForwardOkAt !== null
      ? new Date(status.lastForwardOkAt).toLocaleTimeString()
      : 'never';
  return (
    <div className="px-3 py-2 text-[11px] text-[#8E8E93] tabular-nums">
      <div>
        Sent {status.sent} · Failed {status.failed} · Dropped {status.dropped} · Last ok {lastOk}
      </div>
      {status.lastForwardErr !== null && (
        <div className="text-ios-red mt-0.5">Last error: {status.lastForwardErr}</div>
      )}
    </div>
  );
}

// ─── Security-specific subcomponents ──────────────────────────────────────

function ClearAllSecurityEventsRow({
  onConfirm,
}: {
  onConfirm: () => Promise<void>;
}): React.ReactElement {
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
      {pending
        ? 'Click again to permanently delete every security event'
        : 'Clear all security events…'}
    </button>
  );
}

function ClaudeCodeSyncSubsection({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
}): React.ReactElement {
  const { status, pull, push } = useClaudeSyncStatus();
  // First-enable flow: when the user toggles sync on for the very
  // first time, show a three-way choice modal before the engine
  // starts so the initial reconciliation doesn't silently clobber
  // either side. Tracked via a local flag — the daemon's start()
  // defaults to 'merge' if we never send a different mode, so
  // dismissing the modal without picking keeps the safe default.
  const [firstEnableOpen, setFirstEnableOpen] = useState(false);
  // Status timestamps only change when the daemon broadcasts — which
  // is on-transition, not periodically. Without a local tick, the
  // "Last imported" / "Last exported" labels would freeze at their
  // render-time value until the next sync event, making a fresh
  // "1s ago" look indistinguishable from a minute-old state. Ticking
  // once per second keeps the seconds column live; the label stops
  // mattering past ~1 minute, so we don't need anything fancier.
  const [, forceRender] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => forceRender((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [enabled]);
  const handleToggle = (v: boolean): void => {
    if (v && !enabled) {
      // Defer the actual settings write until the user picks a mode —
      // the modal's buttons call onToggle(true) themselves after a
      // priming pullNow() with the chosen mode.
      setFirstEnableOpen(true);
      return;
    }
    onToggle(v);
  };
  const ago = (ts: number | null): string => {
    if (ts === null) return 'never';
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return `${Math.round(sec / 86400)}d ago`;
  };
  return (
    <>
      <ToggleRow
        label="Sync with ~/.claude/settings.json"
        description="Mirror Sentinel's permission rules into Claude Code's own permissions.allow / deny / ask arrays. Changes on either side propagate within about a second."
        checked={enabled}
        onChange={handleToggle}
      />
      {enabled && (
        <>
          <div className="px-3 pt-2 pb-1 text-[11px] text-[#8E8E93] leading-snug">
            Last imported{' '}
            <span className="font-semibold text-black dark:text-white">
              {ago(status?.lastPulledAt ?? null)}
            </span>
            {' · '}Last exported{' '}
            <span className="font-semibold text-black dark:text-white">
              {ago(status?.lastPushedAt ?? null)}
            </span>
          </div>
          {status?.lastError && (
            <div className="px-3 pb-2 text-[11px] text-ios-red">Error: {status.lastError}</div>
          )}
          <div className="flex items-center gap-2 px-3 pb-3 pt-1">
            <button
              onClick={() => void pull()}
              className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-ios-blue/10 text-ios-blue hover:bg-ios-blue/20 active:scale-95 transition-all"
              title="Read ~/.claude/settings.json and reconcile Sentinel's rules"
            >
              Import now
            </button>
            <button
              onClick={() => void push()}
              className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-ios-blue/10 text-ios-blue hover:bg-ios-blue/20 active:scale-95 transition-all"
              title="Write Sentinel's rules out to ~/.claude/settings.json now"
            >
              Export now
            </button>
          </div>
        </>
      )}
      {firstEnableOpen && (
        <FirstEnableSyncModal
          onClose={() => setFirstEnableOpen(false)}
          onConfirm={(mode) => {
            // Turn the setting on first so the engine starts with its
            // watcher attached; then fire the initial reconciliation
            // in the chosen mode. Engine's start() will itself call
            // pullNow('merge') — our explicit pullNow overrides that
            // for this first cycle.
            onToggle(true);
            setFirstEnableOpen(false);
            void pull(mode);
          }}
        />
      )}
    </>
  );
}

function FirstEnableSyncModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (mode: 'merge' | 'import' | 'export') => void;
}): React.ReactElement {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="glass-card max-w-[380px] w-[88vw] p-5" onClick={(e) => e.stopPropagation()}>
        <p className="text-[14px] font-semibold text-black dark:text-white mb-1">
          Initial sync direction
        </p>
        <p className="text-[12px] text-[#8E8E93] leading-snug mb-4">
          Sync will run in both directions continuously. For the first pass only, choose whose rules
          win when both sides have the same entry.
        </p>
        <div className="space-y-2">
          <button
            onClick={() => onConfirm('merge')}
            className="w-full text-left px-3 py-2 rounded-xl border border-black/10 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
          >
            <div className="text-[12px] font-semibold text-black dark:text-white">
              Merge both (recommended)
            </div>
            <div className="text-[11px] text-[#8E8E93] leading-snug">
              Keep every rule from both sides. Identical duplicates stay owned by whichever side
              authored them.
            </div>
          </button>
          <button
            onClick={() => onConfirm('import')}
            className="w-full text-left px-3 py-2 rounded-xl border border-black/10 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
          >
            <div className="text-[12px] font-semibold text-black dark:text-white">
              Import from Claude Code
            </div>
            <div className="text-[11px] text-[#8E8E93] leading-snug">
              Claude Code's file wins. Identical Sentinel rules get re-marked as "from Claude Code"
              and follow that file's lifecycle.
            </div>
          </button>
          <button
            onClick={() => onConfirm('export')}
            className="w-full text-left px-3 py-2 rounded-xl border border-black/10 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors"
          >
            <div className="text-[12px] font-semibold text-black dark:text-white">
              Export from Sentinel
            </div>
            <div className="text-[11px] text-[#8E8E93] leading-snug">
              Sentinel's rules win. Rules only in Claude Code's file are dropped on this first pass
              (and the file is overwritten).
            </div>
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            className="text-[12px] font-medium text-[#8E8E93] hover:text-black dark:hover:text-white px-2 py-1 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Subsection inside Settings → Security → Oversized request scanning.
 *  Exposes the user-initiated benchmark: a "Tune for this system"
 *  button + inline results table. Separate component because it owns
 *  local state (the most recent fresh result) distinct from the
 *  persisted `lastScanBenchmark` on Settings. Both merge in the UI:
 *  a just-run bench shows its results inline; once it's persisted
 *  (via the settings_changed broadcast), those results stay visible
 *  with a "last tuned: X ago" timestamp. */
function TuneForSystemSubsection({
  bench,
}: {
  bench: import('@claude-sentinel/shared').SecurityBenchmarkResult | null;
}): React.ReactElement {
  const { settings, update } = useSettings();
  const { run, running, error } = useScanBenchmark();
  const currentThreshold = settings?.securityOversizedThresholdMb ?? 4;
  const applied = bench?.recommendedMb === currentThreshold;
  const applyRecommendation = (): void => {
    if (!bench) return;
    void update({ securityOversizedThresholdMb: bench.recommendedMb }).catch(() => undefined);
  };
  return (
    <div className="px-3 pt-2.5 pb-1">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium text-black dark:text-white">Tune for this system</p>
          <p className="text-[10px] text-[#8E8E93] leading-snug mt-0.5">
            {bench
              ? `Last tuned ${formatAgo(bench.ranAt)} on ${bench.platform}: recommended ${bench.recommendedMb} MB.`
              : 'Not tuned yet. Run a quick benchmark to pick a threshold that suits this machine.'}
          </p>
        </div>
        <button
          onClick={() => void run()}
          disabled={running}
          className="flex-shrink-0 flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-ios-blue/10 text-ios-blue hover:bg-ios-blue/20 active:scale-95 transition-all disabled:opacity-50"
          title={running ? 'Running benchmark…' : 'Measure scan cost on this machine'}
        >
          {running && <Loader2 size={11} className="animate-spin" strokeWidth={2.5} />}
          {running ? 'Benchmarking…' : bench ? 'Re-run' : 'Benchmark'}
        </button>
      </div>
      {error && <p className="text-[10px] text-ios-red leading-snug mb-2">Error: {error}</p>}
      {bench && (
        <div className="rounded-lg bg-black/[0.03] dark:bg-white/[0.04] px-2.5 py-2 mb-1">
          <div className="grid grid-cols-5 gap-1 text-[10px] mb-1">
            {bench.results.map((r) => (
              <div key={r.sizeMb} className="text-center">
                <div
                  className={`font-semibold tabular-nums ${
                    r.sizeMb === bench.recommendedMb
                      ? 'text-ios-blue'
                      : 'text-black dark:text-white'
                  }`}
                >
                  {r.sizeMb} MB
                </div>
                <div className="text-[#8E8E93] tabular-nums">{r.p99Ms.toFixed(1)}ms</div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-[#8E8E93] leading-snug">
            p99 scan cost per body size. Recommendation picks the largest size under 50 ms.
          </p>
          {!applied && (
            <button
              onClick={applyRecommendation}
              className="mt-1.5 text-[11px] font-semibold text-ios-blue hover:opacity-80 active:scale-95"
            >
              Apply recommendation → {bench.recommendedMb} MB
            </button>
          )}
          {applied && (
            <p className="mt-1.5 text-[10px] text-ios-green">✓ Recommendation already applied</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Short "Xs / Xm / Xh / Xd ago" formatter for timestamps. Simpler
 *  than the sync-subsection equivalent because we don't need live
 *  ticking — the Settings panel remounts on open and that's when
 *  users look at this label. */
function formatAgo(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function BypassesManager(): React.ReactElement {
  const { entries, loading, error, remove } = usePermissionBypasses();
  if (loading) {
    return <div className="px-3 py-3 text-[11px] text-[#8E8E93]">Loading…</div>;
  }
  if (error) {
    return <div className="px-3 py-3 text-[11px] text-ios-red">{error}</div>;
  }
  if (entries.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-[#8E8E93]">
        No bypasses yet. Tick <span className="font-semibold">Always allow this exact input</span>{' '}
        on a pending tool-use banner to add one.
      </div>
    );
  }
  return (
    <div className="divide-y divide-black/5 dark:divide-white/5">
      {entries.map((entry) => (
        <BypassesRow key={entry.id} entry={entry} onRemove={() => remove(entry.id)} />
      ))}
    </div>
  );
}

function BypassesRow({
  entry,
  onRemove,
}: {
  entry: import('@claude-sentinel/shared').PermissionBypassEntry;
  onRemove: () => Promise<void>;
}): React.ReactElement {
  const { pending, trigger } = useInlineConfirm(onRemove);
  const when = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(entry.createdAt));
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-black dark:text-white truncate">
          {entry.toolName}
        </p>
        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
          <code className="text-[10px] font-mono bg-[#8E8E93]/10 px-1 py-0.5 rounded truncate max-w-[260px]">
            {entry.mask}
          </code>
          <span className="text-[10px] text-[#8E8E93]">added {when}</span>
        </div>
        {entry.note && <p className="text-[10px] text-[#8E8E93] mt-1 leading-snug">{entry.note}</p>}
      </div>
      <button
        onClick={trigger}
        className={`flex-shrink-0 flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full transition-all active:scale-95 ${
          pending ? 'bg-ios-red text-white' : 'bg-ios-red/10 text-ios-red hover:bg-ios-red/20'
        }`}
        title={pending ? 'Click again to remove' : 'Remove bypass'}
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
 * account identity, the overage opt-in toggle, and a weekly cap input.
 * The OAuth token authorized during Add Account is what authenticates
 * the usage fetch; there is no separate claude.ai sign-in to manage.
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
  /** Optional: fire OAuth-token + usage refresh for this account. */
  onRefresh?: () => Promise<void>;
}): React.ReactElement {
  const [refreshing, setRefreshing] = React.useState(false);
  // claude.ai-reported overage cap for this account. Used as the upper
  // bound on the Sentinel weekly cap below. limitUsd is 0 when overage
  // isn't enabled on the claude.ai side; we treat that as "no cap
  // known yet" (no clamp).
  const { snapshot } = useClaudeAiUsage(account.id);
  // Prefer the per-user budget (from /v1/code/routines/run-budget) for
  // team accounts — extra_usage.limitUsd is null for teams anyway and
  // used_credits is a team-wide credit counter, not personal spend.
  // Individual plans (Max/Pro) stay on extraUsage.limitUsd which IS
  // their overage cap.
  const isTeam = account.planType === 'team';
  const perUserLimit = snapshot?.perUserBudget?.limitUsd ?? null;
  const claudeAiOverageCap = isTeam
    ? perUserLimit && perUserLimit > 0
      ? perUserLimit
      : null
    : snapshot?.extraUsage?.limitUsd && snapshot.extraUsage.limitUsd > 0
      ? snapshot.extraUsage.limitUsd
      : null;
  const teamCapAdminOnly = isTeam && snapshot?.extraUsage?.isEnabled === true && !perUserLimit;

  return (
    <div className="px-3 py-3 border-b border-black/5 dark:border-white/5 last:border-0 space-y-2.5">
      {/* Header row: identity + refresh */}
      <div className="flex items-center gap-3">
        <AccountColorDot color={accountColor(account)} size="sm" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-black dark:text-white truncate">
            {account.displayName || account.email}
          </p>
          <p className="text-[11px] text-[#8E8E93] truncate">
            {account.email}
            {account.planType ? ` (${planLabel(account.planType)})` : ''}
          </p>
        </div>
        {onRefresh && (
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
            className="text-[#8E8E93] hover:text-ios-blue disabled:opacity-40 transition-colors active:scale-90 shrink-0"
            title="Refresh token + usage"
          >
            <RefreshCw size={12} strokeWidth={2.5} className={refreshing ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      {/* Overage controls */}
      <div className="space-y-2 pt-1 pl-5 border-l-2 border-ios-green/30">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <p className="text-[12px] font-medium text-black dark:text-white">
              Allow spending overage
            </p>
            <p className="text-[10px] text-[#8E8E93] leading-snug">
              Round-robin picks this account for new requests after its 5-hour quota is exhausted,
              and lets Sonnet requests through once the Sonnet 7-day quota is spent. Off: Sentinel
              refuses either spillover with a 503.
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
            ? {
                adminOnlyHint:
                  "Team overage cap isn't exposed to non-admins. Ask an org owner for the value.",
              }
            : {})}
        />
      </div>
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
      const clamped =
        props.maxUsd != null && props.maxUsd > 0 && n > props.maxUsd ? props.maxUsd : n;
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
    : props.maxUsd != null && props.maxUsd > 0
      ? `claude.ai overage cap: $${props.maxUsd.toFixed(2)}`
      : null;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      {props.leading && <div className="flex-shrink-0">{props.leading}</div>}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-black dark:text-white truncate">{props.label}</p>
        {props.sublabel && <p className="text-[11px] text-[#8E8E93] truncate">{props.sublabel}</p>}
        {hint && <p className="text-[10px] text-[#8E8E93]/80 truncate">{hint}</p>}
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

/**
 * Text input for `alternateApiUrl`. Debounced write-through (400 ms) like
 * BudgetInputRow so each keystroke doesn't fire its own update_settings IPC.
 * Validation runs on debounce: empty saves as null; valid http(s) origin
 * saves; everything else surfaces an inline error and skips the save. The
 * daemon's coercer is still the source of truth: it strips any trailing
 * path/query/hash, so a value displayed here is always the persisted origin.
 */
function AlternateApiUrlRow(props: {
  value: string | null;
  onChange: (value: string | null) => void;
}): React.ReactElement {
  const [text, setText] = useState<string>(props.value ?? '');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const next = props.value ?? '';
    if (text === '' || text === props.value) {
      setText(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);

  const onChangeDebounced = (raw: string): void => {
    setText(raw);
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const trimmed = raw.trim();
      if (trimmed === '') {
        props.onChange(null);
        return;
      }
      try {
        const u = new URL(trimmed);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          setError('Use http:// or https://');
          return;
        }
        props.onChange(u.origin);
      } catch {
        setError('Enter a valid URL');
      }
    }, 400);
  };

  return (
    <div className="px-3 py-2.5">
      <p className="text-[13px] font-medium text-black dark:text-white">Alternate API URL</p>
      <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">
        Claude Code traffic will route through this URL. Account, usage, and OAuth queries continue
        to use api.anthropic.com.
      </p>
      <input
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => onChangeDebounced(e.target.value)}
        placeholder="https://router.example.com"
        className="mt-2 w-full px-2 py-1.5 rounded-md text-[12px] bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white placeholder:text-[#8E8E93]/60 focus:outline-none focus:ring-2 focus:ring-ios-blue/40"
      />
      {error && <p className="text-[11px] text-red-500 mt-1">{error}</p>}
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
              title={excluded ? `${a.email}: excluded from pool` : a.email}
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
