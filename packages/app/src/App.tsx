import React, { useEffect, useState } from 'react';
import { Users, Activity, BarChart3, AlertTriangle, Bell, Loader2, Settings as SettingsIcon, Repeat } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import AccountSwitcher from './components/AccountSwitcher.js';
import AccountViewPicker, { POOL_VIEW, type PickerValue } from './components/AccountViewPicker.js';
import UsageView from './components/UsageView.js';
import MetricsDashboard from './components/MetricsDashboard.js';
import OverageTimeline from './components/OverageTimeline.js';
import AlertsEditor from './components/AlertsEditor.js';
import ActivationBanner from './components/ActivationBanner.js';
import HeaderMenu from './components/HeaderMenu.js';
import PersistenceBanner from './components/PersistenceBanner.js';
import SettingsPanel from './components/SettingsPanel.js';
import { useAutoResizeWindow } from './hooks/useAutoResizeWindow.js';
import { useDaemon } from './hooks/useDaemon.js';
import { useSettings } from './hooks/useSettings.js';
import { planLabel } from './lib/plan.js';
import { DUR, EASE_STD } from './lib/motion.js';

type Tab = 'accounts' | 'usage' | 'metrics' | 'overage' | 'notifications';

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'accounts',      label: 'Accounts', icon: Users         },
  { id: 'usage',         label: 'Usage',    icon: Activity      },
  { id: 'metrics',       label: 'Metrics',  icon: BarChart3     },
  { id: 'overage',       label: 'Overage',  icon: AlertTriangle },
  { id: 'notifications', label: 'Alerts',   icon: Bell          },
];

export default function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<Tab>('accounts');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { connected, activeAccount, accounts, rateLimitsVersion, overageVersion, probingAccountId, initializing, refetch } = useDaemon();
  const { settings } = useSettings();
  const isRoundRobin = settings?.switchingMode === 'round-robin';

  const { rootRef, contentRef, overlayRef } = useAutoResizeWindow();

  // Per-tab view scope. Separate from activeAccount — lets the user inspect
  // any enrolled account's data on a given tab without changing the proxy's
  // active token. Reset defaults on every tab switch so users aren't stuck on
  // a stale selection when they return.
  const [usageView,    setUsageView]    = useState<PickerValue | undefined>(undefined);
  const [metricsView,  setMetricsView]  = useState<string | undefined>(undefined);
  const [overageView,  setOverageView]  = useState<string | undefined>(undefined);
  const [alertsView,   setAlertsView]   = useState<string | undefined>(undefined);

  // Whenever the active account changes (manual switch, OAuth completion),
  // snap every per-tab picker back to the active account (or pool for Usage
  // in RR mode) so the default view mirrors what Claude Code is actually using.
  useEffect(() => {
    setUsageView(undefined);
    setMetricsView(undefined);
    setOverageView(undefined);
    setAlertsView(undefined);
  }, [activeAccount?.accountUuid, activeAccount?.organizationUuid, isRoundRobin]);

  const planBadge = activeAccount ? planLabel(activeAccount.billingType) : '';

  return (
    <MotionConfig reducedMotion="user">
    <div ref={rootRef} className="flex flex-col h-full bg-[#F2F2F7] dark:bg-[#111111] select-none relative">

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
        </div>

        {/* Flex-1 + min-w-0 lets this cluster take the remaining width and
            pass the squeeze onto the email element below (which has truncate). */}
        <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
          {activeAccount && (
            <span
              className="text-[11px] text-[#8E8E93] truncate min-w-0"
              title={activeAccount.emailAddress + (planBadge ? ` (${planBadge})` : '')}
            >
              {activeAccount.emailAddress}
              {planBadge && <span className="ml-1">({planBadge})</span>}
            </span>
          )}
          {/* Round-robin pill — surfaced in the header so users always know
              their requests are rotating, even though the email above is
              still the single "active" account in ~/.claude.json.
              flex-shrink-0 + whitespace-nowrap keeps the pill at its
              natural width regardless of how cramped the email gets. */}
          {isRoundRobin && (
            <span
              className="inline-flex items-center gap-1 text-[9px] font-semibold text-ios-blue bg-ios-blue/10 px-1.5 py-0.5 rounded-full uppercase tracking-wider flex-shrink-0 whitespace-nowrap"
              title="Round-robin is on — requests rotate across every enrolled account"
            >
              <Repeat size={9} strokeWidth={2.5} />
              Round-Robin
            </span>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5 flex-shrink-0"
            title="Settings"
            aria-label="Settings"
          >
            <SettingsIcon size={16} strokeWidth={2.2} />
          </button>
          <div className="flex-shrink-0">
            <HeaderMenu />
          </div>
        </div>
      </header>

      <AnimatePresence>
        {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} measureRef={overlayRef} />}
      </AnimatePresence>

      {/* ── Startup splash: shown until the first successful IPC round-trip,
             so child components never get a chance to render their own
             "Refresh failed" errors while the daemon is still coming up. */}
      {initializing ? (
        <main className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
          <Loader2 size={28} strokeWidth={2.2} className="animate-spin text-ios-blue" />
          <p className="text-[13px] font-medium text-black dark:text-white">Starting daemon…</p>
          <p className="text-[11px] text-[#8E8E93] text-center leading-relaxed max-w-[260px]">
            Waiting for the Sentinel background service to come online. This usually takes a second.
          </p>
        </main>
      ) : (
        <>
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
                    className={`relative flex-1 flex items-center justify-center gap-1 py-1.5 rounded-[9px] text-[11px] font-medium transition-colors duration-150 ${
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
                    <span className="relative z-10 flex items-center gap-1">
                      <Icon size={11} strokeWidth={2.2} />
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Tab content ─────────────────────────────────────── */}
          <main className="flex-1 overflow-y-auto px-4 pb-4">
            <div ref={contentRef}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0, x: 6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -6 }}
                  transition={{ duration: DUR.fast, ease: EASE_STD }}
                >
                  {(() => {
                    // Only show the "no accounts" empty state when the daemon confirms it
                    // is connected and the accounts list is genuinely empty. While loading
                    // (connected=false, accounts=[]) we fall through to the normal content
                    // so each component can show its own disconnected state.
                    const noAccounts = connected && accounts.length === 0;
                    if (activeTab === 'accounts') return <AccountSwitcher onAccountsChanged={refetch} />;
                    if (noAccounts) return (
                      <div className="rounded-2xl bg-white dark:bg-[#1E1E1E] shadow-card px-4 py-10 text-center mt-1">
                        <p className="text-[14px] font-medium text-black dark:text-white">No accounts</p>
                        <p className="text-[12px] text-[#8E8E93] mt-1">Add an account in the Accounts tab to see data here.</p>
                      </div>
                    );
                    if (activeTab === 'usage') {
                      const picker = (
                        <AccountViewPicker
                          accounts={accounts}
                          activeAccount={activeAccount}
                          showPoolOption={isRoundRobin}
                          {...(usageView !== undefined ? { value: usageView } : {})}
                          onChange={setUsageView}
                        />
                      );
                      return <>{picker}<UsageView rateLimitsVersion={rateLimitsVersion} isProbing={probingAccountId !== null} activeAccount={activeAccount} accounts={accounts} viewAccountId={usageView} /></>;
                    }
                    if (activeTab === 'metrics') {
                      const picker = (
                        <AccountViewPicker
                          accounts={accounts}
                          activeAccount={activeAccount}
                          {...(metricsView !== undefined ? { value: metricsView } : {})}
                          onChange={(v) => setMetricsView(v === POOL_VIEW ? undefined : v)}
                        />
                      );
                      return <>{picker}<MetricsDashboard viewAccountId={metricsView} /></>;
                    }
                    if (activeTab === 'overage') {
                      const picker = (
                        <AccountViewPicker
                          accounts={accounts}
                          activeAccount={activeAccount}
                          {...(overageView !== undefined ? { value: overageView } : {})}
                          onChange={(v) => setOverageView(v === POOL_VIEW ? undefined : v)}
                        />
                      );
                      return <>{picker}<OverageTimeline overageVersion={overageVersion} viewAccountId={overageView} /></>;
                    }
                    if (activeTab === 'notifications') {
                      const picker = (
                        <AccountViewPicker
                          accounts={accounts}
                          activeAccount={activeAccount}
                          {...(alertsView !== undefined ? { value: alertsView } : {})}
                          onChange={(v) => setAlertsView(v === POOL_VIEW ? undefined : v)}
                        />
                      );
                      return <>{picker}<AlertsEditor activeAccount={activeAccount} accounts={accounts} viewAccountId={alertsView} /></>;
                    }
                    return null;
                  })()}
                </motion.div>
              </AnimatePresence>
            </div>
          </main>
        </>
      )}

    </div>
    </MotionConfig>
  );
}
