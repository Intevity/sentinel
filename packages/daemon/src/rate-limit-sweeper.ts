import type { IpcServer } from './ipc.js';
import type { RateLimitStore } from './rate-limit-store.js';

/** Default sweep cadence. A usage window rolls over on a 5-hour or 7-day
 *  boundary, so minute-granularity is plenty to clear stale numbers; a finer
 *  interval would only add wakeups for no user-visible benefit. */
const DEFAULT_INTERVAL_MS = 60_000;

export interface RateLimitSweeperDeps {
  rateLimitStore: RateLimitStore;
  ipcServer: IpcServer;
  /** Invoked once after a sweep that rolled over ≥1 window. Wired to
   *  `SpendTracker.recompute()`: a rolled-over window has `reset = null`, which
   *  the tracker's reset-delta release paths (`handleRateLimitUpdate`,
   *  `sweepWeeklyResets`) deliberately skip — so a lingering weekly-rate-limit
   *  pause is released here instead, off the window's now-`allowed` status.
   *  Budget pauses are spend-based and unaffected. Omitted in unit tests that
   *  don't exercise pause release. */
  onWindowsExpired?: () => void;
  /** Current time getter — injectable so tests can freeze the clock. */
  now?: () => number;
  /** Sweep cadence in ms. Defaults to {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
}

export interface RateLimitSweeperHandle {
  stop: () => void;
}

/**
 * Start the background rate-limit window sweeper.
 *
 * Each tick asks the store to roll over any window whose `reset` timestamp has
 * elapsed (see {@link RateLimitStore.expireStaleWindows}) and broadcasts
 * `rate_limits_updated` for every account that changed, so the Usage tab and
 * pool meter drop to their true post-reset values with zero request traffic.
 *
 * Runs one pass immediately so a daemon launched after an idle stretch (e.g.
 * over a weekend) clears weekend-stale windows the moment it boots, rather than
 * waiting a full interval. The interval timer is `unref`'d so it never keeps the
 * process alive on its own.
 */
export function startRateLimitSweeper(deps: RateLimitSweeperDeps): RateLimitSweeperHandle {
  const clock = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  const tick = (): void => {
    const changed = deps.rateLimitStore.expireStaleWindows(clock());
    if (changed.size === 0) return;
    for (const accountId of changed.keys()) {
      console.log(`[RateLimitSweep] Rolled over stale window(s) for ${accountId}`);
      deps.ipcServer.broadcast({ type: 'rate_limits_updated', accountId });
    }
    deps.onWindowsExpired?.();
  };

  // Immediate pass on startup, then on the interval.
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop: (): void => {
      clearInterval(timer);
    },
  };
}
