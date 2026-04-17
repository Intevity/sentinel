import React, { useState } from 'react';
import { Users, Activity, BarChart3, AlertTriangle, Bell, Loader2, Settings as SettingsIcon } from 'lucide-react';
import AccountSwitcher from './components/AccountSwitcher.js';
import AccountChip from './components/AccountChip.js';
import UsageView from './components/UsageView.js';
import MetricsDashboard from './components/MetricsDashboard.js';
import OverageTimeline from './components/OverageTimeline.js';
import AlertsEditor from './components/AlertsEditor.js';
import ActivationBanner from './components/ActivationBanner.js';
import HeaderMenu from './components/HeaderMenu.js';
import PersistenceBanner from './components/PersistenceBanner.js';
import SettingsPanel from './components/SettingsPanel.js';
import { useDaemon } from './hooks/useDaemon.js';

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

  return (
    <div className="flex flex-col h-full bg-[#F2F2F7] dark:bg-[#111111] select-none relative">

      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
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

        <div className="flex items-center gap-3">
          {activeAccount && (
            <span className="text-[11px] text-[#8E8E93] truncate max-w-[180px]">
              {activeAccount.emailAddress}
            </span>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5"
            title="Settings"
            aria-label="Settings"
          >
            <SettingsIcon size={16} strokeWidth={2.2} />
          </button>
          <HeaderMenu />
        </div>
      </header>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

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
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-[9px] text-[11px] font-medium transition-all duration-150 ${
                    activeTab === id
                      ? 'bg-white dark:bg-[#3A3A3C] text-black dark:text-white shadow-[0_1px_3px_rgba(0,0,0,0.15)]'
                      : 'text-[#8E8E93] hover:text-black dark:hover:text-white'
                  }`}
                >
                  <Icon size={11} strokeWidth={2.2} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Tab content ─────────────────────────────────────── */}
          <main className="flex-1 overflow-y-auto px-4 pb-4">
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
              // Non-Accounts tabs: show which account the displayed data belongs to
              const chip = <AccountChip account={activeAccount} />;
              if (activeTab === 'usage')         return <>{chip}<UsageView rateLimitsVersion={rateLimitsVersion} isProbing={probingAccountId !== null} activeAccount={activeAccount} accounts={accounts} /></>;
              if (activeTab === 'metrics')       return <>{chip}<MetricsDashboard /></>;
              if (activeTab === 'overage')       return <>{chip}<OverageTimeline overageVersion={overageVersion} /></>;
              if (activeTab === 'notifications') return <>{chip}<AlertsEditor activeAccount={activeAccount} /></>;
              return null;
            })()}
          </main>
        </>
      )}

    </div>
  );
}
