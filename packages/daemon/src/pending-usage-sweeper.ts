import type { Database } from 'better-sqlite3';
import type { IpcServer } from './ipc.js';
import { commitStalePendingUsage } from './db.js';

/** How long a staged usage row waits for an OTEL claim before the proxy owns
 *  it. The Claude Code CLI exports OTEL logs every 2 s and metrics every 5 s
 *  (claude-otel-config.ts), so 90 s covers a full exporter retry/backoff
 *  cycle for a live CLI while staying well inside RequestAccountMap's 5-min
 *  TTL. A client that never reports (opencode-claude-auth; a `claude --print`
 *  child that exited) shows up in the Metrics tab at most this much later. */
export const PENDING_USAGE_GRACE_MS = 90_000;

/** Sweep cadence. Worst-case commit latency is grace + interval; the
 *  on-demand sweep in the usage/metrics IPC handlers bounds what the UI can
 *  observe at the grace window itself, so a finer timer buys nothing. */
const DEFAULT_INTERVAL_MS = 15_000;

export interface PendingUsageSweeperDeps {
  db: Database;
  ipcServer: IpcServer;
  /** Grace window in ms. Defaults to {@link PENDING_USAGE_GRACE_MS}. */
  graceMs?: number;
  /** Sweep cadence in ms. Defaults to {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
  /** Current time getter — injectable so tests can freeze the clock. */
  now?: () => number;
}

export interface PendingUsageSweeperHandle {
  stop: () => void;
}

/**
 * Start the background pending-usage sweeper.
 *
 * Each tick commits staged usage rows whose grace window elapsed with no OTEL
 * claim (see {@link commitStalePendingUsage}) and broadcasts `metrics_updated`
 * when any landed, so the Metrics tab picks up spend from claude-cli-UA
 * clients that never report their own usage.
 *
 * Runs one pass immediately so rows staged by a previous daemon run (client
 * exited, daemon restarted) commit the moment it boots rather than waiting a
 * full interval. The interval timer is `unref`'d so it never keeps the
 * process alive on its own.
 */
export function startPendingUsageSweeper(deps: PendingUsageSweeperDeps): PendingUsageSweeperHandle {
  const clock = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? PENDING_USAGE_GRACE_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  const tick = (): void => {
    try {
      const landed = commitStalePendingUsage(deps.db, { graceMs, now: clock() });
      if (landed === 0) return;
      console.log(`[PendingUsageSweep] Committed ${landed} unclaimed usage row(s)`);
      deps.ipcServer.broadcast({ type: 'metrics_updated' });
    } catch (err) {
      /* v8 ignore next 2 -- commit failure needs a corrupted db */
      console.error('[PendingUsageSweep] sweep failed:', err);
    }
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
