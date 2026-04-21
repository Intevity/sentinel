import type { IpcServer } from './ipc.js';
import type { ClaudeAiUsageSnapshot } from '@claude-sentinel/shared';
import { readClaudeAiSessionKey } from './accounts.js';
import { fetchRunBudget } from './claude-ai-run-budget.js';

/**
 * Shape of Anthropic's `/api/organizations/{org}/usage` response (captured
 * from a live claude.ai /settings/usage request). Undocumented; treat
 * fields defensively.
 */
interface RawUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string | null } | null;
  seven_day?: { utilization?: number; resets_at?: string | null } | null;
  seven_day_sonnet?: { utilization?: number; resets_at?: string | null } | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number | null;
    used_credits?: number | null;
    utilization?: number | null;
    currency?: string | null;
  } | null;
  [k: string]: unknown;
}

/** Discriminator returned alongside a null snapshot so the UI can distinguish
 *  "you haven't connected yet" from "your cookie expired, please reconnect". */
export type UsageFetchError = 'missing_key' | 'auth_expired' | 'network' | 'parse';

export interface UsageFetchResult {
  snapshot: ClaudeAiUsageSnapshot | null;
  error: UsageFetchError | null;
}

const BASE_URL = 'https://api.anthropic.com';
const CLAUDE_AI_URL = 'https://claude.ai';

/**
 * Fetch usage for an org. Tries `api.anthropic.com` first (no Cloudflare
 * challenge in front of it, cleaner from a daemon process) and falls back
 * to `claude.ai` if that rejects. Both honor the sessionKey cookie when
 * provided; neither accepts the OAuth Bearer we have for anthropic-messaging.
 */
export async function fetchOrgUsage(
  orgUuid: string,
  sessionKey: string,
): Promise<UsageFetchResult> {
  const trimmed = sessionKey.trim();
  if (!trimmed) return { snapshot: null, error: 'missing_key' };

  // Kick off the per-user run-budget fetch in parallel with the org
  // usage fetch. On team plans this returns the viewing member's
  // personal cap + spend (the numbers Sentinel wants to show that
  // member). On individual plans it 403s and we degrade to null.
  // Starting the fetch now (rather than after the primary) overlaps
  // the two RTT windows; the snapshot below awaits both.
  const runBudgetPromise = fetchRunBudget(orgUuid, trimmed).catch(() => null);

  // Send BOTH cookie names. claude.ai's current web deployment sets the
  // session token under `sessionKeyLC` (confirmed via DevTools
  // document.cookie enumeration — the `LC` suffix is a production
  // naming that the Anthropic backend now expects). Older deployments
  // accepted bare `sessionKey`; we ship both so a single captured token
  // works across whatever rollout Anthropic has routed this request to.
  // Both entries point at the same secret — whichever the server
  // validates will match.
  const headers: Record<string, string> = {
    Cookie: `sessionKeyLC=${trimmed}; sessionKey=${trimmed}`,
    // `web_claude_ai` client header mirrors what a real browser sends; some
    // edges on anthropic's backend gate on it.
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-version': '1.0.0',
    Accept: 'application/json',
  };

  // Primary: api.anthropic.com (no CF in front of this particular API host
  // today, so daemon requests aren't challenged).
  let resp: Response;
  try {
    resp = await fetch(`${BASE_URL}/api/organizations/${orgUuid}/usage`, {
      method: 'GET',
      headers,
    });
  } catch {
    return { snapshot: null, error: 'network' };
  }

  // Fallback: some accounts or Anthropic regions may route differently;
  // try claude.ai host if the API host 404s or the session isn't
  // recognized there. claude.ai has Cloudflare bot protection but
  // accepts server-to-server requests with only `Cookie: sessionKey` on
  // the API subpath (no browser-fingerprint challenge for /api/* today).
  if (resp.status === 404 || resp.status === 401) {
    try {
      resp = await fetch(`${CLAUDE_AI_URL}/api/organizations/${orgUuid}/usage`, {
        method: 'GET',
        headers,
      });
    } catch {
      return { snapshot: null, error: 'network' };
    }
  }

  if (resp.status === 401 || resp.status === 403) {
    return { snapshot: null, error: 'auth_expired' };
  }
  if (!resp.ok) {
    return { snapshot: null, error: 'network' };
  }

  let raw: RawUsageResponse;
  try {
    raw = (await resp.json()) as RawUsageResponse;
  } catch {
    return { snapshot: null, error: 'parse' };
  }

  try {
    const snapshot = parseUsage(raw);
    const runBudget = await runBudgetPromise;
    snapshot.perUserBudget = runBudget
      ? { limitUsd: runBudget.limitUsd, usedUsd: runBudget.usedUsd }
      : null;
    return { snapshot, error: null };
  } catch {
    return { snapshot: null, error: 'parse' };
  }
}

/**
 * Convert the raw response into the typed snapshot. `monthly_limit` and
 * `used_credits` are **minor units** (cents); we divide by 100 to show
 * dollars so consumers never have to remember the unit.
 *
 * Exported for tests.
 */
export function parseUsage(raw: RawUsageResponse): ClaudeAiUsageSnapshot {
  const fiveHour = raw.five_hour ?? null;
  const sevenDay = raw.seven_day ?? null;
  const sonnet = raw.seven_day_sonnet ?? null;
  const extra = raw.extra_usage ?? null;

  // Server sends utilization on the 0-100 percent scale for the window
  // members but 0-100 for extra_usage too. Normalize to 0-1 for 5h/7d to
  // match our existing RateLimitWindow type; leave extra_usage as percent
  // since the UI presents it as dollars + a percentage readout.
  const utilFraction = (v: number | undefined | null): number | null => {
    if (v == null || !Number.isFinite(v)) return null;
    // Observed live: `"five_hour": { "utilization": 0.0 }` where 1.0 means
    // fully used. But `"seven_day": { "utilization": 29.0 }` where 100 means
    // fully used. Defensive: if the value looks like a percent (>1.01 and
    // ≤100) scale down; if it looks like a fraction (≤1.0) leave alone.
    if (v > 1.01 && v <= 100) return v / 100;
    return v;
  };

  // Anthropic's `/api/organizations/{org}/usage` response has two
  // spend-ish fields under extra_usage on individual (Max/Pro) plans:
  //   - `used_credits`: a per-credit counter, NOT equivalent to
  //     dollar spend — for team plans this value is a team-wide
  //     credit counter that doesn't map to actual per-user dollars.
  //   - `utilization`: the percent (0-100) of the cap consumed. The
  //     canonical spend signal for individual plans — always matches
  //     what the claude.ai /settings/usage page displays.
  // For team plans `utilization` comes back as null (confirmed live),
  // which is why we fall back to the per-user run-budget endpoint.
  // Here we always compute `usedUsd = (utilization/100) * limit` so
  // the number matches claude.ai's own display exactly on individual
  // plans and naturally sits at 0 on team plans (where both fields
  // are null and perUserBudget takes over in the UI).
  const extraUsage: ClaudeAiUsageSnapshot['extraUsage'] =
    extra && typeof extra.is_enabled === 'boolean'
      ? {
          isEnabled: extra.is_enabled,
          limitUsd: toUsd(extra.monthly_limit),
          usedUsd:
            typeof extra.utilization === 'number' && typeof extra.monthly_limit === 'number'
              ? (extra.utilization / 100) * toUsd(extra.monthly_limit)
              : 0,
          utilizationPct: typeof extra.utilization === 'number' ? extra.utilization : 0,
          currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
        }
      : null;

  return {
    fiveHourUtilization: utilFraction(fiveHour?.utilization),
    fiveHourResetsAt: fiveHour?.resets_at ?? null,
    sevenDayUtilization: utilFraction(sevenDay?.utilization),
    sevenDayResetsAt: sevenDay?.resets_at ?? null,
    sevenDaySonnetUtilization: utilFraction(sonnet?.utilization),
    sevenDaySonnetResetsAt: sonnet?.resets_at ?? null,
    extraUsage,
    // Populated by fetchOrgUsage after parseUsage — parseUsage itself
    // doesn't know about the per-user budget endpoint. Default null
    // here so callers (tests, UI fallback paths) always see the
    // expected shape even if perUserBudget never gets set.
    perUserBudget: null,
    fetchedAt: Date.now(),
  };
}

/** Cents → dollars, with null guard. Anthropic sends `monthly_limit: 10000`
 *  meaning $100.00; dividing by 100 keeps our types in dollars everywhere. */
function toUsd(minorUnits: number | null | undefined): number {
  if (minorUnits == null || !Number.isFinite(minorUnits)) return 0;
  return minorUnits / 100;
}

/** How often to poll the usage endpoint when a sessionKey is configured.
 *  Claude.ai's own UI appears to cache for ~30s; 5 minutes is plenty for
 *  a background budget display while staying well inside any sensible rate
 *  limit Anthropic might apply. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Back-off after an auth_expired error — the cookie is stale and won't
 *  recover until the user re-logs in. Don't keep hammering. */
const AUTH_EXPIRED_BACKOFF_MS = 30 * 60 * 1000;

export interface ClaudeAiUsageStoreDeps {
  ipcServer: IpcServer;
  /** Maps Sentinel account id → org UUID. Orgs are keyed that way in the
   *  usage URL, and AccountInfo carries both. */
  getOrgUuid: (accountId: string) => string | null;
  /** List of Sentinel ids we should poll for. Typically every enrolled
   *  account; the store skips accounts with no sessionKey configured. */
  getAccountIds: () => string[];
  /** Test seam: swap fetch for a stub. */
  fetch?: typeof fetchOrgUsage;
  /** Test seam: deterministic clock. */
  now?: () => number;
}

/**
 * In-memory cache of the most recent `ClaudeAiUsageSnapshot` per account,
 * backed by a periodic poller. Subscribers receive broadcasts on every
 * snapshot refresh (successful OR failed — the failure case carries an
 * `error` discriminator so the UI can render the right recovery CTA).
 */
export class ClaudeAiUsageStore {
  private snapshots = new Map<string, ClaudeAiUsageSnapshot>();
  private lastError = new Map<string, UsageFetchError>();
  private nextPollAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchImpl: typeof fetchOrgUsage;
  private readonly subscribers: ((accountId: string) => void)[] = [];

  /** Fires after every fetch completes (success OR failure). Use when an
   *  in-process consumer needs to react to spend changes without taking a
   *  round-trip through the IPC broadcast. */
  onUpdate(cb: (accountId: string) => void): void {
    this.subscribers.push(cb);
  }

  private fireSubscribers(accountId: string): void {
    for (const cb of this.subscribers) {
      try {
        cb(accountId);
      } catch (err) {
        console.error('[ClaudeAiUsage] subscriber threw:', err);
      }
    }
  }

  constructor(private readonly deps: ClaudeAiUsageStoreDeps) {
    this.fetchImpl = deps.fetch ?? fetchOrgUsage;
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    if (this.timer) return;
    // Fire once immediately, then on interval. Startup latency matters —
    // the UI expects real numbers the moment the user opens the Usage tab.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(accountId: string): ClaudeAiUsageSnapshot | null {
    return this.snapshots.get(accountId) ?? null;
  }

  getLastError(accountId: string): UsageFetchError | null {
    return this.lastError.get(accountId) ?? null;
  }

  /** Force an immediate fetch for a specific account (used on
   *  `set_claude_ai_session_key` so the UI doesn't wait for the poller). */
  async refresh(accountId: string): Promise<void> {
    await this.fetchOne(accountId, /* force */ true);
  }

  private async tick(): Promise<void> {
    const now = this.clock();
    for (const accountId of this.deps.getAccountIds()) {
      const nextAt = this.nextPollAt.get(accountId) ?? 0;
      if (now < nextAt) continue;
      await this.fetchOne(accountId, /* force */ false);
    }
  }

  private async fetchOne(accountId: string, force: boolean): Promise<void> {
    const sessionKey = readClaudeAiSessionKey(accountId);
    const orgUuid = this.deps.getOrgUuid(accountId);
    if (!sessionKey) {
      this.recordFailure(accountId, 'missing_key', force);
      return;
    }
    if (!orgUuid) {
      this.recordFailure(accountId, 'parse', force);
      return;
    }
    const result = await this.fetchImpl(orgUuid, sessionKey);
    if (result.error) {
      this.recordFailure(accountId, result.error, force);
      return;
    }
    if (!result.snapshot) {
      this.recordFailure(accountId, 'parse', force);
      return;
    }
    this.snapshots.set(accountId, result.snapshot);
    this.lastError.delete(accountId);
    this.nextPollAt.set(accountId, this.clock() + POLL_INTERVAL_MS);
    this.deps.ipcServer.broadcast({
      type: 'claude_ai_usage_updated',
      accountId,
      snapshot: result.snapshot,
      error: null,
    });
    this.fireSubscribers(accountId);
  }

  private recordFailure(accountId: string, error: UsageFetchError, force: boolean): void {
    // Longer backoff for auth expiry — the cookie is dead until user
    // re-logs in. `force` (on-demand refresh) bypasses the cooldown.
    const backoff = error === 'auth_expired' && !force ? AUTH_EXPIRED_BACKOFF_MS : POLL_INTERVAL_MS;
    this.nextPollAt.set(accountId, this.clock() + backoff);
    this.lastError.set(accountId, error);
    // Don't zero out the snapshot on transient failures — the UI keeps
    // showing the last-known good numbers with a warning indicator. Only
    // missing_key clears the snapshot (there's nothing meaningful cached
    // when no key was ever set).
    if (error === 'missing_key') this.snapshots.delete(accountId);
    this.deps.ipcServer.broadcast({
      type: 'claude_ai_usage_updated',
      accountId,
      snapshot: this.snapshots.get(accountId) ?? null,
      error,
    });
    this.fireSubscribers(accountId);
  }
}
