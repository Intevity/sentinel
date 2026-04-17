import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import type { AccountInfo, OAuthAccount } from '@claude-sentinel/shared';
import { planLabel } from '../lib/plan.js';

/** Sentinel value used in place of an accountId when the user picks the
 *  cross-account pool view (Usage tab in round-robin mode). */
export const POOL_VIEW = '__pool__';

export type PickerValue = string | typeof POOL_VIEW;

interface AccountViewPickerProps {
  accounts: AccountInfo[];
  activeAccount: OAuthAccount | null;
  /** When true, renders an "All accounts (pool)" option at the top.
   *  Used on the Usage tab when round-robin is enabled. */
  showPoolOption?: boolean;
  /** Currently selected value. Defaults to activeAccount.id if unset, or
   *  POOL_VIEW when showPoolOption is true and no explicit value is given. */
  value?: PickerValue;
  onChange: (value: PickerValue) => void;
}

/**
 * Click-to-open dropdown shown above Usage / Metrics / Overage / Alerts
 * tabs. Replaces the static `AccountChip` — same visual footprint but
 * lets the user rebind the view scope to any enrolled account without
 * changing which account Claude Code's proxy uses.
 *
 * The active proxy account is flagged with a green dot + "Active" label
 * so the user always sees which account is handling their live traffic,
 * regardless of what data the tab is currently showing.
 */
export default function AccountViewPicker({
  accounts,
  activeAccount,
  showPoolOption = false,
  value,
  onChange,
}: AccountViewPickerProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Resolve the visible selection. Fall back in priority order:
  //   1. explicit value prop
  //   2. POOL_VIEW when the pool option is enabled
  //   3. active account id
  //   4. first account (last resort — should rarely happen)
  const resolved: PickerValue | null = value
    ?? (showPoolOption ? POOL_VIEW : undefined)
    ?? findActiveId(accounts, activeAccount)
    ?? accounts[0]?.id
    ?? null;

  // Close on outside click so the popover behaves like a native menu.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (accounts.length === 0 || !resolved) return null;

  const currentLabel = formatValue(resolved, accounts);
  const activeId = findActiveId(accounts, activeAccount);

  return (
    <div ref={rootRef} className="relative pt-1 pb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] px-2.5 py-[3px] transition-colors active:scale-95"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="text-[9px] text-[#8E8E93] uppercase tracking-wider font-semibold">Showing</span>
        <span className="text-[11px] font-semibold text-black dark:text-white max-w-[180px] truncate">
          {currentLabel.primary}
        </span>
        {currentLabel.secondary && (
          <>
            <span className="text-[11px] text-[#8E8E93]">·</span>
            <span className="text-[11px] text-[#8E8E93] max-w-[120px] truncate">{currentLabel.secondary}</span>
          </>
        )}
        <ChevronDown size={11} strokeWidth={2.2} className="text-[#8E8E93]" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full mt-1 z-30 min-w-[240px] rounded-xl bg-white dark:bg-[#2C2C2E] shadow-card-md border border-black/5 dark:border-white/10 py-1"
        >
          {showPoolOption && (
            <PickerRow
              selected={resolved === POOL_VIEW}
              primary="All accounts (pool)"
              secondary="Round-robin aggregate"
              onClick={() => { onChange(POOL_VIEW); setOpen(false); }}
            />
          )}
          {accounts.map((acct) => (
            <PickerRow
              key={acct.id}
              selected={resolved === acct.id}
              primary={acct.displayName || acct.email}
              secondary={secondaryLine(acct)}
              isActive={acct.id === activeId}
              onClick={() => { onChange(acct.id); setOpen(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PickerRowProps {
  selected: boolean;
  primary: string;
  secondary?: string | undefined;
  isActive?: boolean;
  onClick: () => void;
}

function PickerRow({ selected, primary, secondary, isActive, onClick }: PickerRowProps): React.ReactElement {
  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.06] transition-colors ${
        selected ? 'bg-black/[0.02] dark:bg-white/[0.04]' : ''
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-black dark:text-white truncate">{primary}</p>
        {secondary && <p className="text-[10px] text-[#8E8E93] truncate">{secondary}</p>}
      </div>
      {isActive && (
        <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-ios-green shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-ios-green" />
          Active
        </span>
      )}
      {selected && <Check size={12} strokeWidth={2.5} className="text-ios-blue shrink-0" />}
    </button>
  );
}

function findActiveId(accounts: AccountInfo[], active: OAuthAccount | null): string | null {
  if (!active) return null;
  // Prefer the sentinel-key match (AccountInfo.id uses orgUuid||accountUuid,
  // which is how OAuthAccount.organizationUuid/accountUuid also resolves).
  const byOrg = accounts.find((a) => active.organizationUuid && a.orgUuid === active.organizationUuid);
  if (byOrg) return byOrg.id;
  const byUuid = accounts.find((a) => a.accountUuid === active.accountUuid);
  return byUuid?.id ?? null;
}

function secondaryLine(acct: AccountInfo): string | undefined {
  const plan = planLabel(acct.planType);
  const org = acct.orgName;
  if (org && plan) return `${org} · ${plan}`;
  return org || plan || undefined;
}

function formatValue(
  value: PickerValue,
  accounts: AccountInfo[],
): { primary: string; secondary?: string | undefined } {
  if (value === POOL_VIEW) {
    return { primary: 'All accounts', secondary: `${accounts.length} accounts` };
  }
  const acct = accounts.find((a) => a.id === value);
  if (!acct) return { primary: 'Unknown' };
  return {
    primary: acct.displayName || acct.email,
    secondary: secondaryLine(acct),
  };
}
