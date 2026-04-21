import React, { useEffect, useRef, useState } from 'react';
import {
  Users,
  Activity,
  BarChart3,
  AlertTriangle,
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
import AccountViewPicker, { POOL_VIEW, type PickerValue } from './components/AccountViewPicker.js';
import { accountColor } from './lib/accountColor.js';
import UsageView from './components/UsageView.js';
import MetricsDashboard from './components/MetricsDashboard.js';
import OverageTimeline from './components/OverageTimeline.js';
import AlertsEditor from './components/AlertsEditor.js';
import ActivationBanner from './components/ActivationBanner.js';
import HeaderMenu from './components/HeaderMenu.js';
import PersistenceBanner from './components/PersistenceBanner.js';
import SettingsPanel from './components/SettingsPanel.js';
import SecurityRulesOverlay, {
  type SecurityOverlayTab,
} from './components/SecurityRulesOverlay.js';
import SecurityPanel from './components/SecurityPanel.js';
import SecurityEnforcementModal from './components/SecurityEnforcementModal.js';
import SecuritySetupWizard from './components/SecuritySetupWizard.js';
import Tour from './components/Tour.js';
import type { TourStep } from './lib/tourSteps.js';
import LogsViewer from './components/LogsViewer.js';
import PendingBlockBanner from './components/PendingBlockBanner.js';
import Footer from './components/Footer.js';
import { useAutoResizeWindow } from './hooks/useAutoResizeWindow.js';
import { useDaemon } from './hooks/useDaemon.js';
import { useDaemonErrors } from './hooks/useDaemonErrors.js';
import { useSettings } from './hooks/useSettings.js';
import { useNativeAlertNotifications } from './hooks/useNotifications.js';
import { usePendingSiblings } from './hooks/usePendingSiblings.js';
import { planLabel, planColor } from './lib/plan.js';
import { DUR, EASE_STD } from './lib/motion.js';
import { sendToSentinel } from './lib/ipc.js';
import { listen } from '@tauri-apps/api/event';

type Tab = 'accounts' | 'usage' | 'metrics' | 'overage' | 'notifications' | 'security' | 'logs';

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'accounts', label: 'Accounts', icon: Users },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'notifications', label: 'Alerts', icon: Bell },
  { id: 'usage', label: 'Usage', icon: Activity },
  { id: 'overage', label: 'Overage', icon: AlertTriangle },
  { id: 'metrics', label: 'Metrics', icon: BarChart3 },
  { id: 'logs', label: 'Logs', icon: ScrollText },
];

export default function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<Tab>('accounts');
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
    overageVersion,
    probingAccountId,
    initializing,
    refetch,
  } = useDaemon();
  const { recentErrors, hasUnseenErrors, markErrorsSeen } = useDaemonErrors();
  const { settings, update: updateSettings } = useSettings();
  // Which tab the SecurityRulesOverlay opens on. Header-shield click opens
  // 'rules' by default; Settings' "Manage allowlist…" button flips this to
  // 'allowlist' before opening the overlay.
  const [securityOverlayTab, setSecurityOverlayTab] = useState<SecurityOverlayTab>('rules');
  // Mount the app-global native-notification listener. Must live here (not
  // in a per-tab component) so banners fire on any tab and while the
  // window is hidden in the tray.
  useNativeAlertNotifications();

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
      setActiveTab('security');
      setSecurityExpandEventId(event.payload.eventId);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);
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
  const [metricsView, setMetricsView] = useState<string | undefined>(undefined);
  const [overageView, setOverageView] = useState<string | undefined>(undefined);
  const [alertsView, setAlertsView] = useState<string | undefined>(undefined);
  const [securityView, setSecurityView] = useState<string | undefined>(undefined);

  // First-run enforcement-mode picker. Shown once per install when scanning
  // is enabled but the user hasn't picked a posture. Dismissing without
  // choosing leaves the mode at null and the modal will re-appear on next
  // launch until the user picks.
  const [enforcementModalOpen, setEnforcementModalOpen] = useState(false);
  useEffect(() => {
    if (!settings) return;
    if (settings.securityScanEnabled && settings.securityEnforcementMode === null) {
      setEnforcementModalOpen(true);
    }
    // Deps intentionally scoped to the two scalar fields: a whole-object
    // `settings` dep would re-fire every time any unrelated setting flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.securityScanEnabled, settings?.securityEnforcementMode]);

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
    if (settingsOpen || rulesOpen || enforcementModalOpen) return;
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
    enforcementModalOpen,
    settings,
  ]);

  // First-run security setup wizard. Opens once per install (tracked via
  // settings.securitySetupCompleted) after the user has added at least one
  // account and any sibling-enrollment walk has finished. The wizard
  // supersedes the enforcement modal — when the user applies a preset we
  // write a non-null `securityEnforcementMode`, which prevents the
  // enforcement modal's trigger effect above from firing.
  //
  // Gated behind tour completion: a user seeing the app for the first
  // time should finish the tour before being asked to pick a risk
  // profile — otherwise both modals fight for the screen and the wizard
  // wins the race, hiding the tour.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardForceOpen, setWizardForceOpen] = useState(false);
  const { pending: siblingsPending } = usePendingSiblings();
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
    if (siblingsPending) return;
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
    siblingsPending,
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
    setOverageView(undefined);
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
                  connected ? 'bg-ios-green' : 'bg-[#8E8E93]/40'
                }`}
              />
            </span>
            <span className="text-[15px] font-semibold text-black dark:text-white tracking-tight">
              Sentinel
            </span>
            <button
              onClick={() => setTourForceOpen(true)}
              className="text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5 flex-shrink-0"
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
                  className="text-[11px] text-[#8E8E93] truncate min-w-0"
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
            >
              <SecurityShield
                scanOn={settings?.securityScanEnabled ?? false}
                permsOn={settings?.toolPermissionsEnabled ?? false}
              />
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5 flex-shrink-0"
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

        {enforcementModalOpen && settings && !wizardOpen && (
          <SecurityEnforcementModal
            initial={settings.securityEnforcementMode}
            onClose={() => setEnforcementModalOpen(false)}
          />
        )}

        {wizardOpen && (
          <SecuritySetupWizard
            measureRef={overlayRef}
            isFirstRun={wizardIsFirstRun.current}
            onClose={() => {
              wizardClosedThisSession.current = true;
              setWizardOpen(false);
              // Applying a preset also writes a real enforcement mode, so
              // dismiss the older enforcement modal once the wizard closes.
              setEnforcementModalOpen(false);
            }}
          />
        )}

        {tourOpen && <Tour onFinish={finishTour} onStepEnter={handleTourStepEnter} />}

        {/* ── Startup splash: shown until the first successful IPC round-trip,
             so child components never get a chance to render their own
             "Refresh failed" errors while the daemon is still coming up. */}
        {initializing ? (
          <main className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
            <Loader2 size={28} strokeWidth={2.2} className="animate-spin text-ios-blue" />
            <p className="text-[13px] font-medium text-black dark:text-white">Starting daemon…</p>
            <p className="text-[11px] text-[#8E8E93] text-center leading-relaxed max-w-[260px]">
              Waiting for the Sentinel background service to come online. This usually takes a
              second.
            </p>
          </main>
        ) : (
          <>
            {/* ── Security: pending block approval banner ──────────── */}
            {/* Rendered above the other banners so a blocked request can't be
              missed. Takes visual priority while any block is held. */}
            <PendingBlockBanner />

            {/* ── Activation banner (patches ~/.claude/settings.json) ─ */}
            <ActivationBanner />

            {/* ── One-time persistence explanation ─────────────────── */}
            <PersistenceBanner />

            {/* ── Segmented tab control ───────────────────────────── */}
            <div className="px-4 py-2">
              <div className="flex bg-black/[0.06] dark:bg-white/[0.08] rounded-xl p-[3px]">
                {TABS.map(({ id, label, icon: Icon }) => {
                  const active = activeTab === id;
                  return (
                    <button
                      key={id}
                      onClick={() => setActiveTab(id)}
                      data-tour-id={`tab-${id}`}
                      className={`relative flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-[9px] text-[11px] font-medium transition-colors duration-150 ${
                        active
                          ? 'text-black dark:text-white'
                          : 'text-[#8E8E93] hover:text-black dark:hover:text-white'
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
                            <p className="text-[12px] text-[#8E8E93] mt-1">
                              Add an account in the Accounts tab to see data here.
                            </p>
                          </div>
                        );
                      if (activeTab === 'usage') {
                        const picker = (
                          <AccountViewPicker
                            accounts={accounts}
                            activeAccount={activeAccount}
                            showPoolOption={isRoundRobin}
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
                        const picker = (
                          <AccountViewPicker
                            accounts={accounts}
                            activeAccount={activeAccount}
                            switchingMode={pickerSwitchingMode}
                            poolExcludedIds={pickerPoolExcludedIds}
                            {...(metricsView !== undefined ? { value: metricsView } : {})}
                            onChange={(v) => setMetricsView(v === POOL_VIEW ? undefined : v)}
                          />
                        );
                        return (
                          <>
                            {picker}
                            <MetricsDashboard viewAccountId={metricsView} />
                          </>
                        );
                      }
                      if (activeTab === 'overage') {
                        const picker = (
                          <AccountViewPicker
                            accounts={accounts}
                            activeAccount={activeAccount}
                            switchingMode={pickerSwitchingMode}
                            poolExcludedIds={pickerPoolExcludedIds}
                            {...(overageView !== undefined ? { value: overageView } : {})}
                            onChange={(v) => setOverageView(v === POOL_VIEW ? undefined : v)}
                          />
                        );
                        return (
                          <>
                            {picker}
                            <OverageTimeline
                              overageVersion={overageVersion}
                              viewAccountId={overageView}
                            />
                          </>
                        );
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
