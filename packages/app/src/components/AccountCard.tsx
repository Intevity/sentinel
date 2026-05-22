import React, { useState } from 'react';
import { Loader2, Check, X } from 'lucide-react';
import type { AccountInfo, PauseReason } from '@claude-sentinel/shared';
import { planLabel, planColor } from '../lib/plan.js';
import { getAccountStatus } from '../lib/account-status.js';
import { avatarStyle } from '../lib/accountColor.js';
import { useClaudeAiUsage } from '../hooks/useClaudeAiUsage.js';
import AccountColorPicker from './AccountColorPicker.js';
import ResetCountdown from './ResetCountdown.js';

export type RefreshUsageStatus = 'loading' | 'ok' | 'err';

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
  /** Unix-seconds timestamp when the 5h window rolls over. Displayed as a
   *  live countdown pill ("resets in 1h 24m") next to the util chip. Null
   *  / undefined suppresses the pill so cards without observed reset data
   *  don't show a bare "resets in …". */
  fiveHourResetAt?: number | null;
  /** Unix-seconds timestamp when the current pause clears (from the
   *  daemon's `account_paused` broadcast). When `paused` is true, this
   *  replaces the 5h reset in the countdown pill — for weekly rate-limit
   *  pauses it's the 7-day window reset; for other pause reasons it's
   *  the same 5h timestamp but worded as "resumes in" instead of
   *  "resets in". Null when the daemon hasn't cached window data yet. */
  pausedResetsAt?: number | null;
  /** Effective Sentinel cap for this account in USD (per-account override
   *  falling back to global). 0 or undefined suppresses the Sentinel chip. */
  weeklyCapUsd?: number | null;
  /** True when Sentinel has paused this account. Shown as a red "Paused"
   *  pill replacing the normal spend chip. Reason-specific copy is rendered
   *  from `pauseReason` in the hover tooltip. */
  paused?: boolean;
  /** Reason the account is paused. Drives the hover tooltip copy so a user
   *  can tell at a glance whether it's a Sentinel dollar cap, an Anthropic
   *  7-day rate-limit block, or claude.ai's overage disabled state. Null
   *  when not paused (or when the daemon hasn't broadcast a reason yet). */
  pauseReason?: PauseReason | null;
  /** Click handler for the "Refresh token" action. When set, the card
   *  renders a small tertiary button that triggers a manual token refresh. */
  onRefreshToken?: (id: string) => void;
  /** True while a manual refresh is in flight for this account. */
  refreshing?: boolean;
  /** When true, the card shows a persistent "Sign-in expired" banner instead
   *  of the usual actions; clicking it triggers re-authentication. */
  needsReauth?: boolean;
  /** Click handler for the expired-sign-in banner. Receives the current
   *  state of the inline "Private window" checkbox so the parent can route
   *  the OAuth flow through the right browser launcher. */
  onReauth?: (id: string, incognito: boolean) => void;
  /** Current state of the inline "Private window" checkbox in the expired
   *  banner. Sourced from `settings.reauthIncognitoDefault` so every visible
   *  expired card stays in sync. Defaults to `true` when the parent is
   *  still loading settings. */
  reauthIncognito?: boolean;
  /** Called when the user toggles "Private window". Parent persists this
   *  to settings so the choice sticks across cards and sessions. */
  onReauthIncognitoChange?: (next: boolean) => void;
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
  /** Per-card status for the page-level "refresh usage" fan-out, rendered
   *  as a spinner / green check / red X near the 5h pill. `undefined`
   *  means the card is in its resting state (no recent refresh). */
  refreshUsageStatus?: RefreshUsageStatus;
  /** Error text shown on hover when `refreshUsageStatus === 'err'`. */
  refreshUsageError?: string | null;
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
  reauthIncognito,
  onReauthIncognitoChange,
  isRoundRobin,
  inPool,
  canExclude,
  onTogglePool,
  weeklyCapUsd,
  paused,
  pauseReason,
  fiveHourResetAt,
  pausedResetsAt,
  refreshUsageStatus,
  refreshUsageError,
}: AccountCardProps): React.ReactElement {
  // Live Anthropic usage snapshot for this account. The spend chip is only
  // rendered when real numbers are available. If the user hasn't completed
  // claude.ai login we have no honest numbers to show, so no chip appears
  // (the 5h util chip and plan label still render).
  //
  // Team plans need special handling: claude.ai's `extra_usage` returns a
  // team-wide aggregate where `limit_usd` is 0 for non-admin members, so
  // the individual-plan check below would suppress the pill even though
  // the member has a real personal budget. For teams we read the
  // admin-configured `per_user_budget` instead, matching UsageView's
  // teamPerUserValid path.
  const { snapshot } = useClaudeAiUsage(account.id);
  const extraUsage = snapshot?.extraUsage ?? null;
  const perUserBudget = snapshot?.perUserBudget ?? null;
  const isTeam = account.planType === 'team';
  const teamPerUserValid =
    isTeam &&
    perUserBudget != null &&
    perUserBudget.limitUsd != null &&
    perUserBudget.limitUsd > 0 &&
    perUserBudget.usedUsd != null;
  const individualAnthropicValid =
    !isTeam && !!extraUsage && extraUsage.isEnabled && extraUsage.limitUsd > 0;
  const individualOverageDisabled = !isTeam && !!extraUsage && !extraUsage.isEnabled;
  // Shared status derivation with the AccountViewPicker dropdown so the two
  // stay in lock-step (round-robin pool members → "Active", excluded → muted).
  const status = getAccountStatus({
    isActive: account.isActive,
    switchingMode: isRoundRobin ? 'round-robin' : 'off',
    inPool: inPool ?? false,
  });
  const highlight = status === 'active';

  const initials = (account.displayName || account.email)
    .split(/[\s@]/)
    .filter(Boolean)
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const plan = { label: planLabel(account.planType), color: planColor(account.planType) };
  const avatar = avatarStyle(account);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Matches UsageView's rounding: plain round on the header value. Pin the
  // 0 / 100 boundaries so a fresh account isn't mislabeled.
  const fiveHourPct =
    fiveHourUtil == null
      ? null
      : fiveHourUtil <= 0
        ? 0
        : fiveHourUtil >= 1
          ? 100
          : Math.min(100, Math.round(fiveHourUtil * 100));
  const utilChipStyle =
    fiveHourPct == null
      ? ''
      : fiveHourPct >= 90
        ? 'bg-ios-red/10 text-ios-red'
        : fiveHourPct >= 70
          ? 'bg-ios-orange/10 text-ios-orange'
          : 'bg-muted/10 text-muted';

  // ── Status dot/label for the bottom-left of the action row ──
  // Three states driven by `getAccountStatus`: active (green), excluded
  // (gray, RR-only), inactive (empty placeholder to keep row alignment).
  const statusNode: React.ReactNode =
    status === 'active' ? (
      <StatusDot label="Active" tone="green" />
    ) : status === 'excluded' ? (
      <StatusDot label="Excluded" tone="gray" />
    ) : (
      <span />
    );

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
          className="text-[11px] font-medium text-muted hover:text-ios-red disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title={
            disabled
              ? 'At least one account must stay in the pool'
              : 'Exclude from round-robin rotation'
          }
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
      className="text-[11px] font-medium text-muted hover:text-ios-blue disabled:opacity-40 transition-colors"
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
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          title="Customize avatar color"
          aria-label="Customize avatar color"
          className={`flex-shrink-0 w-10 h-10 p-0 rounded-full border-0 appearance-none cursor-pointer ${avatar.className}
                      flex items-center justify-center text-white text-[13px] font-semibold shadow-sm
                      hover:brightness-110`}
          style={avatar.style}
        >
          {initials || '?'}
        </button>

        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-black dark:text-white truncate leading-snug">
            {account.displayName || account.email}
          </p>
          {account.displayName && (
            <p className="text-[11px] text-muted truncate leading-snug">{account.email}</p>
          )}
          {account.orgName && (
            <p className="text-[11px] text-muted truncate leading-snug">{account.orgName}</p>
          )}
        </div>

        <div className="flex-shrink-0 flex flex-col items-end gap-1">
          {refreshUsageStatus === 'loading' ? (
            // Replace the pill + countdown with a compact spinner in the
            // same vertical slot so the card's height doesn't jump while
            // the /api/oauth/usage fetch is in flight.
            <div
              className="flex items-center justify-center h-[18px] px-2"
              title="Refreshing usage…"
              aria-label="Refreshing usage"
            >
              <Loader2 size={12} className="animate-spin text-ios-blue" />
            </div>
          ) : (
            fiveHourPct != null && (
              <div className="flex items-center gap-1.5">
                <div className="relative group">
                  <span
                    className={`text-[10px] font-semibold tabular-nums px-2 py-0.5 rounded-full ${utilChipStyle}`}
                  >
                    5h · {fiveHourPct}%
                  </span>
                  <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10">
                    <div className="bg-black/85 dark:bg-white/90 text-white dark:text-black text-[10px] font-medium px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
                      5-hour usage window
                    </div>
                  </div>
                </div>
                {!needsReauth &&
                  (paused && pausedResetsAt != null && pausedResetsAt > 0 ? (
                    <ResetCountdown
                      epochSec={pausedResetsAt}
                      variant="pill"
                      label="resumes in"
                      tooltip={
                        pauseReason === 'sentinel_weekly_rate_limit'
                          ? 'Weekly (7-day) rate limit reset'
                          : 'Pause clears at'
                      }
                    />
                  ) : (
                    fiveHourResetAt != null &&
                    fiveHourResetAt > 0 && (
                      <ResetCountdown epochSec={fiveHourResetAt} variant="pill" />
                    )
                  ))}
                {refreshUsageStatus === 'ok' && (
                  <Check
                    size={12}
                    strokeWidth={3}
                    className="text-ios-green"
                    aria-label="Usage refreshed"
                  />
                )}
                {refreshUsageStatus === 'err' && (
                  <div className="relative group">
                    <X
                      size={12}
                      strokeWidth={3}
                      className="text-ios-red"
                      aria-label="Refresh failed"
                    />
                    <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10">
                      <div className="bg-black/85 dark:bg-white/90 text-white dark:text-black text-[10px] font-medium px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
                        {refreshUsageError || 'Refresh failed'}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          )}
          {/* err with no prior pill data — still surface the failure. */}
          {refreshUsageStatus === 'err' && fiveHourPct == null && (
            <div className="relative group">
              <X size={12} strokeWidth={3} className="text-ios-red" aria-label="Refresh failed" />
              <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10">
                <div className="bg-black/85 dark:bg-white/90 text-white dark:text-black text-[10px] font-medium px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
                  {refreshUsageError || 'Refresh failed'}
                </div>
              </div>
            </div>
          )}
          {paused ? (
            <div className="relative group">
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-ios-red/15 text-ios-red">
                Paused
              </span>
              <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10">
                <div className="bg-black/85 dark:bg-white/90 text-white dark:text-black text-[10px] font-medium px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
                  {pauseReason === 'sentinel_weekly_rate_limit'
                    ? 'Paused: weekly (7-day) rate limit reached'
                    : pauseReason === 'anthropic_overage_disabled'
                      ? 'Paused: Anthropic disabled overage'
                      : 'Paused: weekly budget reached'}
                </div>
              </div>
            </div>
          ) : teamPerUserValid ? (
            <SpendChip
              spend={perUserBudget!.usedUsd!}
              cap={perUserBudget!.limitUsd!}
              label="Personal"
            />
          ) : individualAnthropicValid && weeklyCapUsd != null && weeklyCapUsd > 0 ? (
            <SpendChip spend={extraUsage!.usedUsd} cap={weeklyCapUsd} label="Sentinel" />
          ) : individualAnthropicValid ? (
            <SpendChip spend={extraUsage!.usedUsd} cap={extraUsage!.limitUsd} label="Overage" />
          ) : individualOverageDisabled ? (
            <div className="relative group">
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-muted/15 text-muted">
                Overage off
              </span>
              <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10">
                <div className="bg-black/85 dark:bg-white/90 text-white dark:text-black text-[10px] font-medium px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
                  Extra usage is disabled on claude.ai
                </div>
              </div>
            </div>
          ) : null}
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

      {pickerOpen && <AccountColorPicker account={account} onClose={() => setPickerOpen(false)} />}

      {/* ── Sign-in expired banner ────────────────────────────
          Two rows: the warning copy on top, a controls row below
          with the "Private window" checkbox and Re-authenticate
          button. The checkbox is sourced from a global setting so
          flipping it on one card updates every other expired card. */}
      {needsReauth && (
        <div className="rounded-xl bg-ios-orange/10 dark:bg-ios-orange/15 px-3 py-2 space-y-1.5">
          <p className="text-[11px] text-ios-orange leading-snug">
            Sign-in expired. Reconnect to keep this account working.
          </p>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={reauthIncognito ?? true}
                onChange={(e) => onReauthIncognitoChange?.(e.target.checked)}
                className="accent-ios-orange w-3.5 h-3.5"
                aria-label="Open re-authentication in a private browser window"
              />
              <span className="text-[11px] text-ios-orange">Private window</span>
            </label>
            <button
              onClick={() => onReauth?.(account.id, reauthIncognito ?? true)}
              className="shrink-0 text-[11px] font-semibold text-white bg-ios-orange
                         hover:opacity-90 active:scale-95 px-2.5 py-1 rounded-full transition-all"
            >
              Re-authenticate
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small left-aligned status with a colored dot. Keeps the action row
 *  visually anchored regardless of whether the card is active/excluded. */
/** Small $spend / $cap chip shown next to the 5h chip on AccountCard. The
 *  color tiers mirror the 5h chip so "nearly capped" reads the same on both. */
function SpendChip({
  spend,
  cap,
  label,
}: {
  spend: number;
  cap: number;
  label: string;
}): React.ReactElement {
  const pct = cap > 0 ? Math.min(100, (spend / cap) * 100) : 0;
  const tone =
    pct >= 90
      ? 'bg-ios-red/10 text-ios-red'
      : pct >= 70
        ? 'bg-ios-orange/10 text-ios-orange'
        : 'bg-muted/10 text-muted';
  return (
    <div className="relative group">
      <span className={`text-[10px] font-semibold tabular-nums px-2 py-0.5 rounded-full ${tone}`}>
        ${spend.toFixed(2)} / ${cap.toFixed(2)}
      </span>
      <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10">
        <div className="bg-black/85 dark:bg-white/90 text-white dark:text-black text-[10px] font-medium px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
          Rolling 7-day spend vs {label} cap
        </div>
      </div>
    </div>
  );
}

function StatusDot({ label, tone }: { label: string; tone: 'green' | 'gray' }): React.ReactElement {
  const dot = tone === 'green' ? 'bg-ios-green' : 'bg-muted/60';
  const text = tone === 'green' ? 'text-ios-green' : 'text-muted';
  return (
    <span className={`text-[11px] font-semibold flex items-center gap-1.5 ${text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
