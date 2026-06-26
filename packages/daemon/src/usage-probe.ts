import type { Database } from 'better-sqlite3';
import type { IpcServer } from './ipc.js';
import { listAccounts } from './db.js';
import { readSentinelCredentials } from './accounts.js';
import { probeRateLimits } from './rate-limit-probe.js';

export interface UsageProberDeps {
  db: Database;
  ipcServer: IpcServer;
  /** Returns the cadence (seconds). Read fresh each tick so settings changes
   *  take effect on restart() without a daemon restart. */
  getIntervalSec: () => number;
  /** Optional per-account gate consulted at fire time. When it returns true
   *  the probe is skipped this tick (no API call, no rate-limit-store
   *  update). Used to avoid consuming quota on accounts the user has
   *  excluded from the Auto-switching pool — see the index.ts wiring for the
   *  "resume once the 5h window has rolled over" policy. Missing → legacy
   *  "always probe every account" behaviour. */
  shouldSkipProbe?: (accountId: string) => boolean;
}

export interface UsageProberHandle {
  stop: () => void;
  restart: () => void;
}

/**
 * Start the background usage prober. Periodically probes every account's
 * rate-limit state so the Usage tab reflects consumption from ALL Anthropic
 * surfaces (claude.ai, Claude Desktop, direct API) that don't hit Sentinel's
 * proxy — including the currently active account, which drifts whenever the
 * user consumes on that account via a non-Claude-Code surface.
 *
 * Probes are staggered evenly across the interval to avoid N simultaneous
 * outbound requests when the user has many accounts.
 */
export function startUsageProber(deps: UsageProberDeps): UsageProberHandle {
  let intervalTimer: NodeJS.Timeout | null = null;
  const scheduledProbes: NodeJS.Timeout[] = [];

  const cancelScheduled = (): void => {
    for (const t of scheduledProbes) clearTimeout(t);
    scheduledProbes.length = 0;
  };

  const tick = (): void => {
    cancelScheduled();

    const accounts = listAccounts(deps.db);
    if (accounts.length === 0) return;

    const intervalMs = Math.max(60, deps.getIntervalSec()) * 1000;
    // Stagger across the FULL interval so adjacent ticks don't bunch probes
    // back-to-back. e.g., 2 accounts + 300s interval → probes at t=0 and t=150.
    const stride = Math.floor(intervalMs / accounts.length);

    accounts.forEach((acct, i) => {
      const fire = (): void => {
        if (deps.shouldSkipProbe?.(acct.id)) {
          console.log(
            `[UsageProbe] Skipping ${acct.email} [${acct.planType}] (${acct.id}) — excluded from pool (window not yet reset)`,
          );
          return;
        }
        const creds = readSentinelCredentials(acct.id);
        if (!creds?.accessToken) {
          console.log(
            `[UsageProbe] Skipping ${acct.email} [${acct.planType}] (${acct.id}) — no stored credentials`,
          );
          return;
        }
        console.log(`[UsageProbe] Probing ${acct.email} [${acct.planType}] (${acct.id})`);
        probeRateLimits(acct.id, deps.ipcServer, creds.accessToken);
      };
      if (i === 0) {
        fire();
      } else {
        const t = setTimeout(fire, i * stride);
        scheduledProbes.push(t);
      }
    });
  };

  const schedule = (): void => {
    const intervalMs = Math.max(60, deps.getIntervalSec()) * 1000;
    intervalTimer = setInterval(tick, intervalMs);
  };

  // Run an immediate pass so accounts get fresh numbers without waiting a
  // full interval after daemon start.
  tick();
  schedule();

  return {
    stop: (): void => {
      cancelScheduled();
      if (intervalTimer) clearInterval(intervalTimer);
      intervalTimer = null;
    },
    restart: (): void => {
      cancelScheduled();
      if (intervalTimer) clearInterval(intervalTimer);
      tick();
      schedule();
    },
  };
}
