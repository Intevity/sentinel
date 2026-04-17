import React from 'react';
import type { AccountInfo } from '@claude-sentinel/shared';
import { planLabel, planColor } from '../lib/plan.js';

interface AccountCardProps {
  account: AccountInfo;
  onSwitch: (id: string, email: string) => void;
  onRemove: (id: string) => void;
  switching: boolean;
  /** 5h-window utilization (0..1) for this account, when known. Rendered as a
   *  subtle "5h · NN%" line under the org name. Omitted when the daemon has
   *  no cached headers for this account yet (typical for never-switched-to
   *  accounts, or on a fresh install). */
  fiveHourUtil?: number;
}

const AVATAR_GRADIENTS = [
  'from-[#007AFF] to-[#5E5CE6]',
  'from-[#30D158] to-[#007AFF]',
  'from-[#BF5AF2] to-[#5E5CE6]',
  'from-[#FF9F0A] to-[#FF453A]',
];

function avatarGradient(id: string): string {
  const idx = id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % AVATAR_GRADIENTS.length;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return AVATAR_GRADIENTS[idx]!;
}

export default function AccountCard({ account, onSwitch, onRemove, switching, fiveHourUtil }: AccountCardProps): React.ReactElement {
  const initials = (account.displayName || account.email)
    .split(/[\s@]/)
    .filter(Boolean)
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const plan = { label: planLabel(account.planType), color: planColor(account.planType) };
  const gradient = avatarGradient(account.id);

  // Matches UsageView's rounding: plain round on the header value. Pin the
  // 0 / 100 boundaries so a fresh account isn't mislabeled.
  const fiveHourPct = fiveHourUtil == null
    ? null
    : fiveHourUtil <= 0 ? 0
    : fiveHourUtil >= 1 ? 100
    : Math.min(100, Math.round(fiveHourUtil * 100));
  // Pill styling mirrors the plan chip: severity-tinted background + matching
  // text color so the two pills read as peers.
  const utilChipStyle =
    fiveHourPct == null ? ''
    : fiveHourPct >= 90 ? 'bg-ios-red/10 text-ios-red'
    : fiveHourPct >= 70 ? 'bg-ios-orange/10 text-ios-orange'
    : 'bg-[#8E8E93]/10 text-[#8E8E93]';

  return (
    <div
      className={`rounded-2xl p-3 transition-all duration-200 ${
        account.isActive
          ? 'bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] ring-1 ring-ios-blue/25'
          : 'bg-white dark:bg-[#1E1E1E] shadow-card'
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Avatar */}
        <div
          className={`flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br ${gradient}
                      flex items-center justify-center text-white text-[13px] font-semibold shadow-sm`}
        >
          {initials || '?'}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-black dark:text-white truncate leading-snug">
            {account.displayName || account.email}
          </p>
          {account.displayName && (
            <p className="text-[11px] text-[#8E8E93] truncate leading-snug">{account.email}</p>
          )}
          {account.orgName && (
            <p className="text-[11px] text-[#8E8E93] truncate leading-snug">{account.orgName}</p>
          )}
        </div>

        {/* Right side — 5h util + plan + action */}
        <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5">
            {fiveHourPct != null && (
              <div className="relative group">
                <span
                  className={`text-[10px] font-semibold tabular-nums px-2 py-0.5 rounded-full ${utilChipStyle}`}
                >
                  5h · {fiveHourPct}%
                </span>
                {/* Hover tooltip: sits above the pill, right-aligned so it
                    doesn't spill past the card edge on narrow widths. */}
                <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10">
                  <div className="bg-black/85 dark:bg-white/90 text-white dark:text-black text-[10px] font-medium px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
                    5-hour usage window
                  </div>
                </div>
              </div>
            )}
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${plan.color}`}>
              {plan.label}
            </span>
          </div>

          {account.isActive ? (
            <>
              <span className="text-[10px] font-semibold text-ios-green flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-ios-green" />
                Active
              </span>
              <button
                onClick={() => onRemove(account.id)}
                className="text-[10px] text-ios-red/60 hover:text-ios-red transition-colors"
              >
                Remove
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => onSwitch(account.id, account.email)}
                disabled={switching}
                className="text-[11px] font-semibold text-white bg-ios-blue hover:opacity-90
                           active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed
                           px-2.5 py-1 rounded-full transition-all duration-150"
              >
                {switching ? '…' : 'Switch'}
              </button>
              <button
                onClick={() => onRemove(account.id)}
                className="text-[10px] text-ios-red/60 hover:text-ios-red transition-colors"
              >
                Remove
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
