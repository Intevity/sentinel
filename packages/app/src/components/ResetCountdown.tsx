import React, { useEffect, useState } from 'react';

/**
 * Live countdown to a reset timestamp, re-rendering every second so the
 * displayed remaining time is always current. Format:
 *   `resets in 47m`     — under an hour
 *   `resets in 3h 12m`  — hours + minutes
 *   `resets in 2d 4h`   — 24h+ (weekly overage windows)
 *   `resets soon`       — ≤ 0 / transition edge
 *
 * Accepts an `epochSec` Unix-seconds timestamp (what Anthropic's reset
 * headers carry) and a `variant` prop to switch between a compact pill
 * (for dense account cards) and an inline text style (for meter labels).
 *
 * The per-second interval is lightweight — a single Date.now() comparison
 * + string format. Skipped entirely when `epochSec` is null so cards
 * without reset data stay passive.
 */

export interface ResetCountdownProps {
  /** Unix-seconds timestamp when the window resets. `null` or `0` hides
   *  the countdown (no data available yet). */
  epochSec: number | null | undefined;
  /** `pill` = compact chip for AccountCard (small, muted bg).
   *  `inline` = plain text for sitting beside a utilization label on
   *  the UsageView meter rows. */
  variant?: 'pill' | 'inline';
  /** Extra className merged into the outer element. */
  className?: string;
  /** Override the leading verb. Default "resets in". Useful when the
   *  caller wants wording like "paused until". */
  label?: string;
  /** Override the hover tooltip text on the pill variant. Default
   *  "5-hour window reset". Callers showing a weekly or pause-clear
   *  countdown should pass the appropriate context here. */
  tooltip?: string;
}

function formatRemaining(epochSec: number, now: number): string {
  const diffMs = epochSec * 1000 - now;
  if (diffMs <= 0) return 'resets soon';
  const totalSec = Math.floor(diffMs / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const remH = h % 24;
    return `${d}d ${remH}h`;
  }
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (totalMin > 0) {
    return `${totalMin}m`;
  }
  // Under a minute — show seconds so the user sees the final tick
  // actually happen rather than staring at "0m" for 60 seconds.
  return `${totalSec}s`;
}

export default function ResetCountdown({
  epochSec,
  variant = 'inline',
  className = '',
  label = 'resets in',
  tooltip = '5-hour window reset',
}: ResetCountdownProps): React.ReactElement | null {
  // A tick counter forces re-render once per second. We could do Date.now()
  // in render and avoid the state entirely, but React won't re-render on
  // its own without a state change — a counter is the cheapest way.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!epochSec) return;
    const id = window.setInterval(() => {
      setTick((t) => (t + 1) & 0x7fffffff);
    }, 1000);
    return () => window.clearInterval(id);
  }, [epochSec]);

  if (!epochSec) return null;

  const text = formatRemaining(epochSec, Date.now());
  const display = text === 'resets soon' ? text : `${label} ${text}`;

  if (variant === 'pill') {
    return (
      <div className="relative group">
        <span
          className={`text-[10px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted/10 text-muted ${className}`}
        >
          {display}
        </span>
        <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10">
          <div className="bg-black/85 dark:bg-white/90 text-white dark:text-black text-[10px] font-medium px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
            {tooltip}
          </div>
        </div>
      </div>
    );
  }

  return (
    <span
      className={`text-[10px] text-muted tabular-nums ${className}`}
      title={`Window resets at ${new Date(epochSec * 1000).toLocaleString()}`}
    >
      {display}
    </span>
  );
}
