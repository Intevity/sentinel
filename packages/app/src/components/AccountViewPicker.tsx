import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import type { AccountInfo, OAuthAccount, SwitchingMode } from '@claude-sentinel/shared';
import { planLabel } from '../lib/plan.js';
import { getAccountStatus, type AccountStatus } from '../lib/account-status.js';
import { accountColor } from '../lib/accountColor.js';
import AccountColorDot from './AccountColorDot.js';

/** Sentinel value used in place of an accountId when the user picks the
 *  round-robin pool view (Usage + Metrics tabs). */
export const POOL_VIEW = '__pool__';

/** Sentinel value for the "All accounts (everything)" cross-account rollup
 *  on the Metrics tab. Unlike `POOL_VIEW`, this ignores pool exclusions —
 *  it's a true total across every enrolled account. */
export const ALL_VIEW = '__all__';

export type PickerValue = string | typeof POOL_VIEW | typeof ALL_VIEW;

/** A synthetic "aggregate across multiple accounts" row the picker can render
 *  at the top of its list. Callers pass whichever pool/all rows they want
 *  surfaced; the picker does not infer membership. */
export interface PoolOption {
  value: typeof POOL_VIEW | typeof ALL_VIEW;
  primary: string;
  secondary: string;
}

interface AccountViewPickerProps {
  accounts: AccountInfo[];
  activeAccount: OAuthAccount | null;
  /** Pool/aggregate rows rendered at the top of the list. Omit or pass an
   *  empty array to hide them. */
  poolOptions?: PoolOption[];
  /** Currently selected value. Defaults to activeAccount.id if unset, or the
   *  first pool option when one is provided and no explicit value is given. */
  value?: PickerValue;
  onChange: (value: PickerValue) => void;
  /** Current switching mode. Drives how status is rendered per row:
   *  in round-robin, every pool member shows "Active" and excluded accounts
   *  show "Excluded" — matching the Accounts tab. In 'off' mode, only the
   *  currently-bound account shows "Active". */
  switchingMode: SwitchingMode;
  /** Pool-exclusion set (RR only). Ignored in non-RR mode. */
  poolExcludedIds: readonly string[];
}

/**
 * Click-to-open dropdown shown above Usage / Metrics / Overage / Alerts
 * tabs. Replaces the static `AccountChip` — same visual footprint but
 * lets the user rebind the view scope to any enrolled account without
 * changing which account Claude Code's proxy uses.
 *
 * Per-row status rendering delegates to `getAccountStatus` so this
 * dropdown stays in sync with AccountCard on the Accounts tab. In
 * round-robin mode that means every pool member reads "Active" (green)
 * and excluded accounts read "Excluded" (gray).
 */
export default function AccountViewPicker({
  accounts,
  activeAccount,
  poolOptions = [],
  value,
  onChange,
  switchingMode,
  poolExcludedIds,
}: AccountViewPickerProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Resolve the visible selection. Fall back in priority order:
  //   1. explicit value prop
  //   2. first pool option when present (e.g. default to "All accounts (pool)")
  //   3. active account id
  //   4. first account (last resort — should rarely happen)
  const resolved: PickerValue | null =
    value ??
    poolOptions[0]?.value ??
    findActiveId(accounts, activeAccount) ??
    accounts[0]?.id ??
    null;

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

  const currentLabel = formatValue(resolved, accounts, poolOptions);
  const excludedSet = new Set(poolExcludedIds);

  return (
    <div ref={rootRef} className="relative pt-1 pb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] px-2.5 py-[3px] transition-colors active:scale-95"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="text-[9px] text-muted uppercase tracking-wider font-semibold">
          Showing
        </span>
        <span className="text-[11px] font-semibold text-black dark:text-white max-w-[180px] truncate">
          {currentLabel.primary}
        </span>
        {currentLabel.secondary && (
          <>
            <span className="text-[11px] text-muted">·</span>
            <span className="text-[11px] text-muted max-w-[120px] truncate">
              {currentLabel.secondary}
            </span>
          </>
        )}
        <ChevronDown size={11} strokeWidth={2.2} className="text-muted" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full mt-1 z-30 min-w-[240px] rounded-xl bg-white dark:bg-[#2C2C2E] shadow-card-md border border-black/5 dark:border-white/10 py-1"
        >
          {poolOptions.map((opt) => (
            <PickerRow
              key={opt.value}
              selected={resolved === opt.value}
              primary={opt.primary}
              secondary={opt.secondary}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            />
          ))}
          {accounts.map((acct) => (
            <PickerRow
              key={acct.id}
              selected={resolved === acct.id}
              primary={acct.displayName || acct.email}
              secondary={secondaryLine(acct)}
              color={accountColor(acct)}
              status={getAccountStatus({
                isActive: acct.isActive,
                switchingMode,
                inPool: !excludedSet.has(acct.id),
              })}
              onClick={() => {
                onChange(acct.id);
                setOpen(false);
              }}
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
  /** Resolved account color. Rendered as a small dot at the start of the
   *  row so the user can scan by color alone. Omitted for the pool row. */
  color?: string;
  /** Status pill shown on the right side of the row. `inactive` renders
   *  nothing so non-RR non-active rows stay visually quiet. */
  status?: AccountStatus;
  onClick: () => void;
}

function PickerRow({
  selected,
  primary,
  secondary,
  color,
  status,
  onClick,
}: PickerRowProps): React.ReactElement {
  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.06] transition-colors ${
        selected ? 'bg-black/[0.02] dark:bg-white/[0.04]' : ''
      }`}
    >
      {color && <AccountColorDot color={color} size="sm" />}
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-black dark:text-white truncate">{primary}</p>
        {secondary && <p className="text-[10px] text-muted truncate">{secondary}</p>}
      </div>
      {status === 'active' && (
        <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-ios-green shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-ios-green" />
          Active
        </span>
      )}
      {status === 'excluded' && (
        <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-muted shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-muted/60" />
          Excluded
        </span>
      )}
      {selected && <Check size={12} strokeWidth={2.5} className="text-ios-blue shrink-0" />}
    </button>
  );
}

/**
 * Resolve the default visible selection to the currently-bound active account
 * when the caller hasn't pinned an explicit `value`. Matches the sentinel-key
 * derivation used elsewhere: prefer org match, fall back to accountUuid.
 * Used only for default selection — per-row status rendering is driven by
 * `getAccountStatus`, not this lookup.
 */
function findActiveId(accounts: AccountInfo[], active: OAuthAccount | null): string | null {
  if (!active) return null;
  const byOrg = accounts.find(
    (a) => active.organizationUuid && a.orgUuid === active.organizationUuid,
  );
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
  poolOptions: PoolOption[],
): { primary: string; secondary?: string | undefined } {
  if (value === POOL_VIEW || value === ALL_VIEW) {
    const opt = poolOptions.find((o) => o.value === value);
    if (opt) return { primary: opt.primary, secondary: opt.secondary };
    // Fallback for the legacy case where a pool sentinel was selected but
    // the caller hasn't listed it in poolOptions (shouldn't happen in practice).
    return { primary: 'All accounts', secondary: `${accounts.length} accounts` };
  }
  const acct = accounts.find((a) => a.id === value);
  if (!acct) return { primary: 'Unknown' };
  return {
    primary: acct.displayName || acct.email,
    secondary: secondaryLine(acct),
  };
}
