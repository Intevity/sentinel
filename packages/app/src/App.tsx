import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Users,
  Activity,
  BarChart3,
  Sparkles,
  Bell,
  Shield,
  ScrollText,
  Loader2,
  Settings as SettingsIcon,
  Repeat,
  HelpCircle,
} from 'lucide-react';
import SecurityShield from './components/SecurityShield.js';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import AccountSwitcher from './components/AccountSwitcher.js';
import AccountColorDot from './components/AccountColorDot.js';
import AccountViewPicker, {
  POOL_VIEW,
  ALL_VIEW,
  type PickerValue,
  type PoolOption,
} from './components/AccountViewPicker.js';
import type { MetricsScope } from './hooks/useMetricsSummary.js';
import type { AccountInfo } from '@claude-sentinel/shared';
import { accountColor } from './lib/accountColor.js';
import UsageView from './components/UsageView.js';
import MetricsDashboard from './components/MetricsDashboard.js';
import OptimizeDashboard from './components/OptimizeDashboard.js';
import AlertsEditor from './components/AlertsEditor.js';
import ActivationBanner from './components/ActivationBanner.js';
import HeaderMenu from './components/HeaderMenu.js';
import PersistenceBanner from './components/PersistenceBanner.js';
import SettingsPanel from './components/SettingsPanel.js';
import SecurityRulesOverlay, {
  type SecurityOverlayTab,
} from './components/SecurityRulesOverlay.js';
import SecurityPanel from './components/SecurityPanel.js';
import SecuritySetupWizard from './components/SecuritySetupWizard.js';
import Tour from './components/Tour.js';
import type { TourStep } from './lib/tourSteps.js';
import LogsViewer from './components/LogsViewer.js';
import { usePendingSecurityBlocks } from './hooks/usePendingSecurityBlocks.js';
import AuditTamperBanner from './components/AuditTamperBanner.js';
import Footer from './components/Footer.js';
import { useAutoResizeWindow } from './hooks/useAutoResizeWindow.js';
import { useDaemon } from './hooks/useDaemon.js';
import { useDaemonErrors } from './hooks/useDaemonErrors.js';
import { useSettings } from './hooks/useSettings.js';
import { useThemeEffect } from './hooks/useThemeEffect.js';
import { useNativeAlertNotifications } from './hooks/useNotifications.js';
import { useSecurityBanner } from './hooks/useSecurityBanner.js';
import SecurityAlertBanner from './components/SecurityAlertBanner.js';
import { planLabel, planColor } from './lib/plan.js';
import { DUR, EASE_STD } from './lib/motion.js';
import { sendToSentinel } from './lib/ipc.js';
import { listen } from '@tauri-apps/api/event';

type Tab = 'accounts' | 'usage' | 'metrics' | 'optimize' | 'notifications' | 'security' | 'logs';

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'accounts', label: 'Accounts', icon: Users },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'notifications', label: 'Alerts', icon: Bell },
  { id: 'usage', label: 'Usage', icon: Activity },
  { id: 'optimize', label: 'Optimize', icon: Sparkles },
  { id: 'metrics', label: 'Metrics', icon: BarChart3 },
  { id: 'logs', label: 'Logs', icon: ScrollText },
];

export default function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<Tab>('accounts');
  // Cross-tab visibility for live security holds. The unified security
  // UI moved pending blocks from a top banner into the Security tab
  // itself; this hook lets the tab show a red dot when a hold is
  // waiting and the user is looking elsewhere. OS notifications still
  // fire (daemon-side) so a fully-backgrounded app also signals.
  const { pending: pendingSecurityBlocks } = usePendingSecurityBlocks();
  const securityNeedsAttention = pendingSecurityBlocks.length > 0 && activeTab !== 'security';
  // Deep-link target for the Security tab, set by the "Details"
  // action on an OS security notification. SecurityPanel reads this
  // prop, expands the matching row on mount/change, and calls
  // `onSecurityExpandHandled` to clear it. Gets set alongside
  // activeTab='security' in the notify-event listener below.
  const [securityExpandEventId, setSecurityExpandEventId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Tool-permission rules editor. Lifted to App level so the overlay has its
  // own positioning context (inside SettingsPanel it pinned to the top of the
  // Settings scroll area and appeared off-screen when the user was scrolled
  // down). Also reachable directly via the Shield icon in the header.
  const [rulesOpen, setRulesOpen] = useState(false);
  // Deep-link target inside the Settings panel. When set before opening,
  // SettingsPanel scrolls to the matching element id and flashes it.
  const [settingsScrollTarget, setSettingsScrollTarget] = useState<string | null>(null);
  const openSettingsAt = (target: string | null): void => {
    setSettingsScrollTarget(target);
    setSettingsOpen(true);
  };
  const {
    connected,
    activeAccount,
    accounts,
    rateLimitsVersion,
    probingAccountId,
    initializing,
    refetch,
  } = useDaemon();
  const { recentErrors, hasUnseenErrors, markErrorsSeen } = useDaemonErrors();
  const { settings, update: updateSettings } = useSettings();
  useThemeEffect(settings?.theme ?? null);
  // Which tab the SecurityRulesOverlay opens on. Header-shield click opens
  // 'rules' by default; Settings' "Manage allowlist…" button flips this to
  // 'allowlist' before opening the overlay.
  const [securityOverlayTab, setSecurityOverlayTab] = useState<SecurityOverlayTab>('rules');
  // Mount the app-global native-notification listener. Must live here (not
  // in a per-tab component) so banners fire on any tab and while the
  // window is hidden in the tray.
  useNativeAlertNotifications();

  // In-app slip banner state for security broadcasts. Mounted at App
  // level alongside the OS-notification listener so it reacts on any
  // tab. Renders only when the user is NOT already on the Security
  // tab — there's no point shouting at them about an event they're
  // already looking at.
  const { banner: securityBanner, dismiss: dismissSecurityBanner } = useSecurityBanner();

  // Navigate the user to the Security tab and (when we have one) auto-expand
  // the event row. Shared by the OS-notification Details handler and the
  // in-app banner click so both routes converge on identical behavior.
  const navigateToSecurityEvent = useCallback((eventId: number | null): void => {
    setActiveTab('security');
    setSecurityExpandEventId(eventId);
  }, []);

  // Listen for the Details-action event fired by
  // `display_os_notification` when the user taps the Details button
  // or the notification body (and an eventId was present on the
  // broadcast).
  // Rust-side shows+focuses the main window before emitting; here we
  // just flip the active tab to Security and pass the eventId through
  // to SecurityPanel so it auto-expands the right row. Lives in App
  // for the same reason the native-notification listener does —
  // needs to react regardless of which tab the user was last on.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ eventId: number }>('security_notification_details', (event) => {
      navigateToSecurityEvent(event.payload.eventId);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [navigateToSecurityEvent]);

  // Dismiss the slip banner whenever the user arrives at the Security
  // tab by any path (clicking the tab, the red dot, the banner itself,
  // or a direct deep-link from an OS notification). The banner has
  // served its purpose once the user is looking at the Security panel.
  useEffect(() => {
    if (activeTab === 'security') dismissSecurityBanner();
  }, [activeTab, dismissSecurityBanner]);
  const isRoundRobin = settings?.switchingMode === 'round-robin';
  // Picker status props — pulled once here so every tab's AccountViewPicker
  // renders identical status pills (Active / Excluded) driven by the same
  // source of truth as AccountCard on the Accounts tab.
  const pickerSwitchingMode = settings?.switchingMode ?? 'off';
  const pickerPoolExcludedIds = settings?.poolExcludedIds ?? [];

  const { rootRef, contentRef, overlayRef, popoverRef } = useAutoResizeWindow();

  // Per-tab view scope. Separate from activeAccount — lets the user inspect
  // any enrolled account's data on a given tab without changing the proxy's
  // active token. Reset defaults on every tab switch so users aren't stuck on
  // a stale selection when they return.
  const [usageView, setUsageView] = useState<PickerValue | undefined>(undefined);
  const [metricsView, setMetricsView] = useState<PickerValue | undefined>(undefined);
  const [alertsView, setAlertsView] = useState<string | undefined>(undefined);
  const [securityView, setSecurityView] = useState<string | undefined>(undefined);

  // First-run tour. Opens when the user has never completed a tour
  // (settings.tourCompleted === false) and no other modal is up. The user
  // can replay the tour any time via the help icon in the header; replay
  // flips `tourForceOpen` on without needing to reset `tourCompleted`.
  // Tour has precedence over the security-setup wizard — both could
  // otherwise fire simultaneously on users who already have accounts
  // enrolled, which is confusing.
  const [tourOpen, setTourOpen] = useState(false);
  const [tourForceOpen, setTourForceOpen] = useState(false);
  // Remembers that the user closed the tour in this session, so the
  // effect below doesn't re-open it while we wait for the
  // `settings_changed` broadcast carrying `tourCompleted: true`. Without
  // this, clicking Done on the last step bounces the tour back to step 1
  // for a frame before the settings round-trip completes.
  const tourClosedThisSession = useRef(false);
  useEffect(() => {
    if (!settings) return;
    if (tourOpen) return;
    if (settingsOpen || rulesOpen) return;
    if (tourForceOpen) {
      tourClosedThisSession.current = false;
      setTourOpen(true);
      return;
    }
    if (tourClosedThisSession.current) return;
    if (!connected) return;
    if (settings.tourCompleted) return;
    setTourOpen(true);
  }, [
    settings?.tourCompleted,
    tourForceOpen,
    tourOpen,
    connected,
    settingsOpen,
    rulesOpen,
    settings,
  ]);

  // First-run security setup wizard. Opens once per install (tracked via
  // settings.securitySetupCompleted) after the user has added at least one
  // account.
  //
  // Gated behind tour completion: a user seeing the app for the first
  // time should finish the tour before being asked to pick a risk
  // profile; otherwise the wizard hides the tour.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardForceOpen, setWizardForceOpen] = useState(false);
  // Mirror of `tourClosedThisSession` for the wizard: once the user
  // closes it (Apply / Skip / X), don't re-open while the
  // `securitySetupCompleted: true` broadcast is still in flight.
  const wizardClosedThisSession = useRef(false);
  // Captured at the moment the wizard opens: true only for the automatic
  // first-install path. Re-runs triggered by the Settings "Run setup
  // wizard" button set this to false so the header X closes without the
  // "Skip security setup?" confirm.
  const wizardIsFirstRun = useRef(false);
  useEffect(() => {
    if (!settings) return;
    if (wizardOpen) return;
    if (wizardForceOpen) {
      wizardClosedThisSession.current = false;
      wizardIsFirstRun.current = false;
      setWizardOpen(true);
      setWizardForceOpen(false);
      return;
    }
    if (wizardClosedThisSession.current) return;
    if (settings.securitySetupCompleted) return;
    if (accounts.length === 0) return;
    // Defer the wizard until the tour is finished. `tourCompleted`
    // flips to true inside `finishTour` as soon as the user skips or
    // completes the last step, so this effect re-runs naturally and
    // the wizard opens on the very next tick.
    if (!settings.tourCompleted && !tourClosedThisSession.current) return;
    if (tourOpen) return;
    wizardIsFirstRun.current = true;
    setWizardOpen(true);
  }, [
    settings?.securitySetupCompleted,
    settings?.tourCompleted,
    accounts.length,
    wizardOpen,
    wizardForceOpen,
    tourOpen,
    settings,
  ]);

  const finishTour = (): void => {
    tourClosedThisSession.current = true;
    setTourOpen(false);
    setTourForceOpen(false);
    void sendToSentinel({ type: 'update_settings', settings: { tourCompleted: true } });
  };

  const handleTourStepEnter = (step: TourStep): void => {
    if (step.tab) setActiveTab(step.tab);
  };

  // Whenever the active account changes (manual switch, OAuth completion),
  // snap every per-tab picker back to the active account (or pool for Usage
  // in RR mode) so the default view mirrors what Claude Code is actually using.
  useEffect(() => {
    setUsageView(undefined);
    setMetricsView(undefined);
    setAlertsView(undefined);
    setSecurityView(undefined);
  }, [activeAccount?.accountUuid, activeAccount?.organizationUuid, isRoundRobin]);

  const planBadge = activeAccount ? planLabel(activeAccount.billingType) : '';
  // Map the live OAuth active-account (carries accountUuid + orgUuid) back to
  // an enrolled AccountInfo so we can pull its user-picked color for the dot.
  // Matches the sentinel-key derivation (orgUuid when present, else accountUuid).
  const activeInfo = activeAccount
    ? accounts.find((a) => a.id === (activeAccount.organizationUuid || activeAccount.accountUuid))
    : undefined;
  const rrStrategyLabel =
    settings?.roundRobinStrategy === 'earliest-reset' ? 'Earliest Reset' : 'Balance';

  return (
    <MotionConfig reducedMotion="user">
      <div
        ref={rootRef}
        className="flex flex-col h-full bg-[#F2F2F7] dark:bg-[#111111] select-none relative"
      >
        {/* ── Header ─────────────────────────────────────────── */}
        {/* Responsive layout: brand on the left never shrinks; pill + icons
          on the right never shrink; only the email absorbs the space
          pressure, truncating with an ellipsis and falling back to a
          hover tooltip with the full address. */}
        <header className="flex items-center gap-3 px-4 pt-3 pb-2">
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="relative flex h-2 w-2">
              {connected && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ios-green opacity-50" />
              )}
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  connected ? 'bg-ios-green' : 'bg-muted/40'
                }`}
              />
            </span>
            <span className="text-[15px] font-semibold text-black dark:text-white tracking-tight">
              Sentinel
            </span>
            <button
              onClick={() => setTourForceOpen(true)}
              className="text-muted hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5 flex-shrink-0"
              title="Replay the tour"
              aria-label="Replay the tour"
              data-tour-id="tour-replay"
            >
              <HelpCircle size={13} strokeWidth={2.2} />
            </button>
          </div>

          {/* Flex-1 + min-w-0 lets this cluster take the remaining width and
            pass the squeeze onto the email element below (which has truncate). */}
          <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
            {/* In round-robin mode, showing a single email is misleading
              (requests rotate) so we hide it — the RR pill below carries
              the signal. Otherwise show email + plan as pill, matching
              the account-card chip style. */}
            {activeAccount && !isRoundRobin && (
              <>
                {activeInfo && <AccountColorDot color={accountColor(activeInfo)} size="xs" />}
                <span
                  className="text-[11px] text-muted truncate min-w-0"
                  title={activeAccount.emailAddress + (planBadge ? ` (${planBadge})` : '')}
                >
                  {activeAccount.emailAddress}
                </span>
                {planBadge && (
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${planColor(activeAccount.billingType)}`}
                  >
                    {planBadge}
                  </span>
                )}
              </>
            )}
            {/* Round-robin pill — surfaced in the header so users always know
              their requests are rotating, even though the email above is
              still the single "active" account in ~/.claude.json.
              flex-shrink-0 + whitespace-nowrap keeps the pill at its
              natural width regardless of how cramped the email gets. */}
            {isRoundRobin && (
              <span
                className="inline-flex items-center gap-1 text-[9px] font-semibold text-ios-blue bg-ios-blue/10 px-1.5 py-0.5 rounded-full uppercase tracking-wider flex-shrink-0 whitespace-nowrap"
                title={`Round-robin is on; rotating requests using the "${rrStrategyLabel}" strategy`}
              >
                <Repeat size={9} strokeWidth={2.5} />
                Round-Robin · {rrStrategyLabel}
              </span>
            )}
            <button
              onClick={() => {
                setSecurityOverlayTab('rules');
                setRulesOpen(true);
              }}
              className="inline-flex items-center justify-center hover:opacity-80 transition-opacity transform-gpu p-0.5 -m-0.5 flex-shrink-0 leading-none"
              aria-label="Security"
              data-tour-id="tour-permissions"
            >
              <SecurityShield
                scanOn={settings?.securityScanEnabled ?? false}
                permsOn={settings?.toolPermissionsEnabled ?? false}
              />
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-muted hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5 flex-shrink-0"
              title="Settings"
              aria-label="Settings"
            >
              <SettingsIcon size={16} strokeWidth={2.2} />
            </button>
            <div className="flex-shrink-0">
              <HeaderMenu measureRef={popoverRef} />
            </div>
          </div>
        </header>

        <AnimatePresence>
          {settingsOpen && (
            <SettingsPanel
              onClose={() => {
                setSettingsOpen(false);
                setSettingsScrollTarget(null);
              }}
              measureRef={overlayRef}
              initialScrollTarget={settingsScrollTarget}
              onRunSetupWizard={() => {
                setSettingsOpen(false);
                setSettingsScrollTarget(null);
                setWizardForceOpen(true);
              }}
              onManageRules={() => {
                setSettingsOpen(false);
                setSettingsScrollTarget(null);
                setSecurityOverlayTab('rules');
                setRulesOpen(true);
              }}
              onManageAllowlist={() => {
                setSettingsOpen(false);
                setSettingsScrollTarget(null);
                setSecurityOverlayTab('allowlist');
                setRulesOpen(true);
              }}
            />
          )}
          {rulesOpen && !settingsOpen && (
            <SecurityRulesOverlay
              onClose={() => setRulesOpen(false)}
              measureRef={overlayRef}
              initialTab={securityOverlayTab}
              settings={settings}
              updateSettings={updateSettings}
              onRunSetupWizard={() => {
                setRulesOpen(false);
                setWizardForceOpen(true);
              }}
            />
          )}
        </AnimatePresence>

        {wizardOpen && (
          <SecuritySetupWizard
            measureRef={overlayRef}
            isFirstRun={wizardIsFirstRun.current}
            onClose={() => {
              wizardClosedThisSession.current = true;
              setWizardOpen(false);
            }}
          />
        )}

        {tourOpen && (
          <Tour
            onFinish={finishTour}
            onStepEnter={handleTourStepEnter}
            replayMode={tourForceOpen}
          />
        )}

        {/* ── Startup splash: shown until the first successful IPC round-trip,
             so child components never get a chance to render their own
             "Refresh failed" errors while the daemon is still coming up. */}
        {initializing ? (
          <main className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
            <Loader2 size={28} strokeWidth={2.2} className="animate-spin text-ios-blue" />
            <p className="text-[13px] font-medium text-black dark:text-white">Starting daemon…</p>
            <p className="text-[11px] text-muted text-center leading-relaxed max-w-[260px]">
              Waiting for the Sentinel background service to come online. This usually takes a
              second.
            </p>
          </main>
        ) : (
          <>
            {/* ── Sprint 8: audit-log integrity break ─────────────── */}
            {/* Rendered first so a chain-tamper warning can't be missed
              behind a stack of routine banners. */}
            <AuditTamperBanner />

            {/* Pending blocks now render as pinned rows inside the
              Security tab itself (see SecurityPanel + LiveSecurityRow).
              Cross-tab visibility comes from the Security tab dot
              indicator below + the OS notification (daemon-side). */}

            {/* ── Activation banner (patches ~/.claude/settings.json) ─ */}
            <ActivationBanner />

            {/* ── One-time persistence explanation ─────────────────── */}
            <PersistenceBanner />

            {/* ── In-app slip banner for live security broadcasts ───── */}
            {/* Suppressed when the user is already on the Security tab —
              the panel itself surfaces new events (prepended row, unread
              badge, pinned LiveSecurityRow for pending blocks). Click
              routes via navigateToSecurityEvent, the same wiring the OS
              notification's Details action uses. */}
            <AnimatePresence>
              {securityBanner && activeTab !== 'security' && (
                <SecurityAlertBanner
                  key={`${securityBanner.kind}:${securityBanner.title}`}
                  banner={securityBanner}
                  onView={() => {
                    navigateToSecurityEvent(
                      securityBanner.kind === 'event' ? (securityBanner.eventId ?? null) : null,
                    );
                    dismissSecurityBanner();
                  }}
                  onDismiss={dismissSecurityBanner}
                />
              )}
            </AnimatePresence>

            {/* ── Segmented tab control ───────────────────────────── */}
            <div className="px-4 py-2">
              <div className="flex bg-black/[0.06] dark:bg-white/[0.08] rounded-xl p-[3px]">
                {TABS.map(({ id, label, icon: Icon }) => {
                  const active = activeTab === id;
                  const showDot = id === 'security' && securityNeedsAttention;
                  return (
                    <button
                      key={id}
                      onClick={() => setActiveTab(id)}
                      data-tour-id={`tab-${id}`}
                      className={`relative flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-[9px] text-[11px] font-medium transition-colors duration-150 ${
                        active
                          ? 'text-black dark:text-white'
                          : 'text-muted hover:text-black dark:hover:text-white'
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId="tab-pill"
                          className="absolute inset-0 rounded-[9px] bg-white dark:bg-[#3A3A3C] shadow-[0_1px_3px_rgba(0,0,0,0.15)]"
                          transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                        />
                      )}
                      <span className="relative z-10 flex items-center gap-1 transform-gpu">
                        <Icon size={11} strokeWidth={2.2} />
                        {label}
                        {showDot && (
                          <span
                            className="ml-0.5 w-1.5 h-1.5 rounded-full bg-ios-red animate-pulse"
                            aria-label="Pending security decision"
                            title="A security block is waiting for your decision"
                          />
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Tab content ─────────────────────────────────────── */}
            {/* Logs tab wants a single internal scroll — the log list inside
              LogsViewer uses flex-1 + overflow-y-auto, so <main> must NOT
              also scroll and must hand down a bounded height. Other tabs
              keep the outer overflow-y-auto so their content grows naturally
              under the auto-resize hook. */}
            <main
              // Force the 5px custom scrollbar track to always be rendered (not
              // just on overflow). The app's ::-webkit-scrollbar in index.css is
              // non-overlay so it occupies real layout space; with `auto`, the
              // track toggles on/off at the overflow boundary, reflowing card
              // widths and feeding useAutoResizeWindow → a visible flash on the
              // right edge. `scroll` reserves the track permanently; the thumb
              // still only renders when there's actually content to scroll.
              className={`flex-1 min-h-0 px-4 pb-4 ${
                activeTab === 'logs' ? 'overflow-hidden flex flex-col' : 'overflow-y-scroll'
              }`}
            >
              <div
                ref={contentRef}
                className={activeTab === 'logs' ? 'flex-1 min-h-0 flex flex-col' : undefined}
                // Expand the tray to its max height while the tour is running.
                // The tour's coach-mark card is `position: fixed` and the hook
                // can't measure it through the natural content-height path;
                // rather than wire a conditional popover signal, we simply give
                // the tour the full 628px to work within. Shrinks back to
                // content height as soon as the tour closes.
                data-expand-max={activeTab === 'logs' || tourOpen ? '' : undefined}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={activeTab}
                    initial={{ opacity: 0, x: 6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -6 }}
                    transition={{ duration: DUR.fast, ease: EASE_STD }}
                    className={activeTab === 'logs' ? 'flex-1 min-h-0 flex flex-col' : undefined}
                  >
                    {(() => {
                      // Only show the "no accounts" empty state when the daemon confirms it
                      // is connected and the accounts list is genuinely empty. While loading
                      // (connected=false, accounts=[]) we fall through to the normal content
                      // so each component can show its own disconnected state.
                      const noAccounts = connected && accounts.length === 0;
                      if (activeTab === 'accounts')
                        return <AccountSwitcher onAccountsChanged={refetch} />;
                      // Logs reads the daemon — no account required. Surface
                      // it on fresh installs (users may want to see enrollment
                      // activity before any account is added).
                      if (activeTab === 'logs') return <LogsViewer />;
                      if (noAccounts)
                        return (
                          <div className="rounded-2xl bg-white dark:bg-[#1E1E1E] shadow-card px-4 py-10 text-center mt-1">
                            <p className="text-[14px] font-medium text-black dark:text-white">
                              No accounts
                            </p>
                            <p className="text-[12px] text-muted mt-1">
                              Add an account in the Accounts tab to see data here.
                            </p>
                          </div>
                        );
                      if (activeTab === 'usage') {
                        const usagePoolOptions: PoolOption[] = isRoundRobin
                          ? [
                              {
                                value: POOL_VIEW,
                                primary: 'All accounts (pool)',
                                secondary: 'Round-robin aggregate',
                              },
                            ]
                          : [];
                        const picker = (
                          <AccountViewPicker
                            accounts={accounts}
                            activeAccount={activeAccount}
                            poolOptions={usagePoolOptions}
                            switchingMode={pickerSwitchingMode}
                            poolExcludedIds={pickerPoolExcludedIds}
                            {...(usageView !== undefined ? { value: usageView } : {})}
                            onChange={setUsageView}
                          />
                        );
                        return (
                          <>
                            {picker}
                            <UsageView
                              rateLimitsVersion={rateLimitsVersion}
                              isProbing={probingAccountId !== null}
                              activeAccount={activeAccount}
                              accounts={accounts}
                              viewAccountId={usageView}
                            />
                          </>
                        );
                      }
                      if (activeTab === 'metrics') {
                        // Build pool rows. "All accounts" (ignoring exclusions)
                        // is always available when ≥2 accounts are enrolled.
                        // The RR pool row joins it when round-robin is active
                        // AND the pool differs from the full account list
                        // (otherwise the two rows would be duplicates).
                        const poolMemberCount = accounts.length - pickerPoolExcludedIds.length;
                        const metricsPoolOptions: PoolOption[] = [];
                        if (accounts.length > 1) {
                          metricsPoolOptions.push({
                            value: ALL_VIEW,
                            primary: 'All accounts',
                            secondary: `${accounts.length} accounts`,
                          });
                        }
                        if (
                          isRoundRobin &&
                          poolMemberCount > 0 &&
                          poolMemberCount < accounts.length
                        ) {
                          metricsPoolOptions.push({
                            value: POOL_VIEW,
                            primary: 'All accounts (pool)',
                            secondary: `Round-robin · ${poolMemberCount} members`,
                          });
                        }
                        // Mirror the picker's display fallback (see
                        // AccountViewPicker resolve logic) so the chart's
                        // scope matches the dropdown's visible label on the
                        // first render. Without this, an undefined metricsView
                        // makes the picker show the first pool option while
                        // the scope quietly defaults to the active account.
                        const effectiveMetricsView: PickerValue | undefined =
                          metricsView ?? metricsPoolOptions[0]?.value;
                        const picker = (
                          <AccountViewPicker
                            accounts={accounts}
                            activeAccount={activeAccount}
                            poolOptions={metricsPoolOptions}
                            switchingMode={pickerSwitchingMode}
                            poolExcludedIds={pickerPoolExcludedIds}
                            {...(effectiveMetricsView !== undefined
                              ? { value: effectiveMetricsView }
                              : {})}
                            onChange={setMetricsView}
                          />
                        );
                        // Translate picker sentinels into a concrete scope the
                        // dashboard/hook can execute. Membership is computed
                        // here so the daemon stays ignorant of "pool" semantics.
                        const scope = metricsViewToScope(
                          effectiveMetricsView,
                          accounts,
                          pickerPoolExcludedIds,
                        );
                        return (
                          <>
                            {picker}
                            <MetricsDashboard scope={scope} />
                          </>
                        );
                      }
                      if (activeTab === 'optimize') {
                        return <OptimizeDashboard />;
                      }
                      if (activeTab === 'notifications') {
                        const picker = (
                          <AccountViewPicker
                            accounts={accounts}
                            activeAccount={activeAccount}
                            switchingMode={pickerSwitchingMode}
                            poolExcludedIds={pickerPoolExcludedIds}
                            {...(alertsView !== undefined ? { value: alertsView } : {})}
                            onChange={(v) => setAlertsView(v === POOL_VIEW ? undefined : v)}
                          />
                        );
                        return (
                          <>
                            {picker}
                            <AlertsEditor
                              activeAccount={activeAccount}
                              accounts={accounts}
                              viewAccountId={alertsView}
                            />
                          </>
                        );
                      }
                      if (activeTab === 'security') {
                        const picker = (
                          <AccountViewPicker
                            accounts={accounts}
                            activeAccount={activeAccount}
                            switchingMode={pickerSwitchingMode}
                            poolExcludedIds={pickerPoolExcludedIds}
                            {...(securityView !== undefined ? { value: securityView } : {})}
                            onChange={(v) => setSecurityView(v === POOL_VIEW ? undefined : v)}
                          />
                        );
                        return (
                          <>
                            {picker}
                            <SecurityPanel
                              viewAccountId={securityView}
                              onRequestOpenSettings={openSettingsAt}
                              autoExpandEventId={securityExpandEventId}
                              onAutoExpandHandled={() => setSecurityExpandEventId(null)}
                            />
                          </>
                        );
                      }
                      return null;
                    })()}
                  </motion.div>
                </AnimatePresence>
              </div>
            </main>
          </>
        )}

        <Footer
          daemonErrors={recentErrors}
          hasUnseenErrors={hasUnseenErrors}
          markErrorsSeen={markErrorsSeen}
        />
      </div>
    </MotionConfig>
  );
}

/**
 * Translate the Metrics-tab picker value into a concrete scope the daemon
 * can execute. Pool membership is decided here (not in the daemon) so the
 * daemon stays ignorant of what "pool" vs. "all" means in this app's model.
 *   - ALL_VIEW   → every enrolled account id
 *   - POOL_VIEW  → enrolled accounts minus the round-robin pool exclusions
 *   - string id  → single-account pin
 *   - undefined  → follow the active account
 */
function metricsViewToScope(
  view: PickerValue | undefined,
  accounts: AccountInfo[],
  poolExcludedIds: readonly string[],
): MetricsScope {
  if (view === ALL_VIEW) {
    return {
      kind: 'all',
      label: 'All accounts',
      accountIds: accounts.map((a) => a.id),
    };
  }
  if (view === POOL_VIEW) {
    const excluded = new Set(poolExcludedIds);
    return {
      kind: 'pool',
      label: 'Pool',
      accountIds: accounts.filter((a) => !excluded.has(a.id)).map((a) => a.id),
    };
  }
  if (typeof view === 'string' && view.length > 0) {
    return { kind: 'account', id: view };
  }
  return { kind: 'active' };
}
