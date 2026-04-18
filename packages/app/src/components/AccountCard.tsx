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
  /** Click handler for the "Refresh token" action. When set, the card
   *  renders a small tertiary button that triggers a manual token refresh. */
  onRefreshToken?: (id: string) => void;
  /** True while a manual refresh is in flight for this account. */
  refreshing?: boolean;
  /** When true, the card shows a persistent "Sign-in expired" banner instead
   *  of the usual actions; clicking it triggers re-authentication. */
  needsReauth?: boolean;
  /** Click handler for the expired-sign-in banner (typically triggers start_login). */
  onReauth?: (id: string) => void;
  /** When true, the card is rendered in round-robin mode. Manual switching
   *  is replaced by an Include/Exclude pool-membership action. */
  isRoundRobin?: boolean;
  /** Round-robin pool membership. True = participates in rotation, gets the
   *  blue-highlighted "Active" treatment. False = muted card with "Excluded"
   *  label. Meaningless unless `isRoundRobin` is true. */
  inPool?: boolean;
  /** When false and `inPool` is true, the Exclude action is disabled to
   *  prevent the last pool member from being excluded. */
  canExclude?: boolean;
  /** Pool-membership flip — called with the new `inPool` value. */
  onTogglePool?: (id: string, nextInPool: boolean) => void;
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

export default function AccountCard({
  account,
  onSwitch,
  onRemove,
  switching,
  fiveHourUtil,
  onRefreshToken,
  refreshing,
  needsReauth,
  onReauth,
  isRoundRobin,
  inPool,
  canExclude,
  onTogglePool,
}: AccountCardProps): React.ReactElement {
  // In round-robin, only pool members rotate — they read as "active." Excluded
  // cards fall back to standard styling so they're clearly sitting out.
  const rotating = isRoundRobin && inPool;
  const highlight = account.isActive || rotating;

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
  const utilChipStyle =
    fiveHourPct == null ? ''
    : fiveHourPct >= 90 ? 'bg-ios-red/10 text-ios-red'
    : fiveHourPct >= 70 ? 'bg-ios-orange/10 text-ios-orange'
    : 'bg-[#8E8E93]/10 text-[#8E8E93]';

  // ── Status dot/label for the bottom-left of the action row ──
  // Four states: RR-included, RR-excluded, active (non-RR), idle (non-RR).
  // Idle renders an empty placeholder so the action row keeps its alignment.
  const statusNode: React.ReactNode = isRoundRobin
    ? inPool
      ? <StatusDot label="Active" tone="green" />
      : <StatusDot label="Excluded" tone="gray" />
    : account.isActive
      ? <StatusDot label="Active" tone="green" />
      : <span />;

  // ── Primary action for the bottom-right of the action row ──
  // Non-RR non-active → Switch pill (blue). RR excluded → Include pill (blue,
  // primary CTA). RR included → Exclude link (gray, de-emphasized). RR
  // included + last pool member → disabled Exclude. Non-RR active → none.
  let primaryAction: React.ReactNode = null;
  if (isRoundRobin) {
    if (inPool) {
      const disabled = canExclude === false;
      primaryAction = (
        <button
          onClick={() => onTogglePool?.(account.id, false)}
          disabled={disabled}
          className="text-[11px] font-medium text-[#8E8E93] hover:text-ios-red disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title={disabled
            ? 'At least one account must stay in the pool'
            : 'Exclude from round-robin rotation'}
        >
          Exclude
        </button>
      );
    } else {
      primaryAction = (
        <button
          onClick={() => onTogglePool?.(account.id, true)}
          className="text-[11px] font-semibold text-white bg-ios-blue hover:opacity-90
                     active:scale-95 px-2.5 py-1 rounded-full transition-all duration-150"
          title="Include in round-robin rotation"
        >
          Include
        </button>
      );
    }
  } else if (!account.isActive) {
    primaryAction = (
      <button
        onClick={() => onSwitch(account.id, account.email)}
        disabled={switching}
        className="text-[11px] font-semibold text-white bg-ios-blue hover:opacity-90
                   active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed
                   px-2.5 py-1 rounded-full transition-all duration-150"
      >
        {switching ? '…' : 'Switch'}
      </button>
    );
  }

  const refreshAction = onRefreshToken && !needsReauth && (
    <button
      onClick={() => onRefreshToken(account.id)}
      disabled={refreshing}
      className="text-[11px] font-medium text-[#8E8E93] hover:text-ios-blue disabled:opacity-40 transition-colors"
      title="Refresh this account's OAuth access token"
    >
      {refreshing ? 'Refreshing…' : 'Refresh'}
    </button>
  );

  const removeAction = (
    <button
      onClick={() => onRemove(account.id)}
      className="text-[11px] font-medium text-ios-red/70 hover:text-ios-red transition-colors"
    >
      Remove
    </button>
  );

  return (
    <div
      className={`rounded-2xl p-3 transition-all duration-200 space-y-2.5 ${
        highlight
          ? 'bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] ring-1 ring-ios-blue/25'
          : 'bg-white dark:bg-[#1E1E1E] shadow-card'
      }`}
    >
      {/* ── Info row ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div
          className={`flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br ${gradient}
                      flex items-center justify-center text-white text-[13px] font-semibold shadow-sm`}
        >
          {initials || '?'}
        </div>

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

        <div className="flex-shrink-0 flex flex-col items-end gap-1">
          {fiveHourPct != null && (
            <div className="relative group">
              <span className={`text-[10px] font-semibold tabular-nums px-2 py-0.5 rounded-full ${utilChipStyle}`}>
                5h · {fiveHourPct}%
              </span>
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
      </div>

      {/* ── Action row ───────────────────────────────────────── */}
      {/* Status on the left, actions on the right. Keeps a predictable
          horizontal rhythm instead of stacking everything on the right. */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <div className="min-w-0">{statusNode}</div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {primaryAction}
          {refreshAction}
          {removeAction}
        </div>
      </div>

      {/* ── Sign-in expired banner (unchanged) ───────────────── */}
      {needsReauth && (
        <div className="rounded-xl bg-ios-orange/10 dark:bg-ios-orange/15 px-3 py-2 flex items-center justify-between gap-2">
          <p className="text-[11px] text-ios-orange leading-snug">
            Sign-in expired. Reconnect to keep this account working.
          </p>
          <button
            onClick={() => onReauth?.(account.id)}
            className="shrink-0 text-[11px] font-semibold text-white bg-ios-orange
                       hover:opacity-90 active:scale-95 px-2.5 py-1 rounded-full transition-all"
          >
            Re-authenticate
          </button>
        </div>
      )}
    </div>
  );
}

/** Small left-aligned status with a colored dot. Keeps the action row
 *  visually anchored regardless of whether the card is active/excluded. */
function StatusDot({ label, tone }: { label: string; tone: 'green' | 'gray' }): React.ReactElement {
  const dot = tone === 'green' ? 'bg-ios-green' : 'bg-[#8E8E93]/60';
  const text = tone === 'green' ? 'text-ios-green' : 'text-[#8E8E93]';
  return (
    <span className={`text-[11px] font-semibold flex items-center gap-1.5 ${text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
