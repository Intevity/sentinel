import type { IpcServer } from './ipc.js';
import type { ClaudeAiUsageSnapshot } from '@claude-sentinel/shared';
import { readSentinelCredentials } from './accounts.js';
import { fetchRunBudget } from './claude-ai-run-budget.js';

/**
 * Shape of Anthropic's `/api/oauth/usage` response. Undocumented; treat
 * fields defensively. Matches the shape previously returned by
 * `/api/organizations/{uuid}/usage` — `parseUsage` is unchanged.
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
 *  "this account has no valid OAuth token" from "the fetch failed in flight." */
export type UsageFetchError = 'missing_key' | 'auth_expired' | 'network' | 'parse';

export interface UsageFetchResult {
  snapshot: ClaudeAiUsageSnapshot | null;
  error: UsageFetchError | null;
}

const BASE_URL = 'https://api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';
/** Beta header required by the OAuth usage endpoint. Matches the value
 *  the Claude Code CLI sends today (GitHub issue anthropics/claude-code#31021). */
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Fetch usage for an org using the OAuth Bearer token Sentinel already has.
 * Replaces the previous sessionKey-cookie path: `/api/oauth/usage` serves
 * the same JSON shape that `/api/organizations/{uuid}/usage` did, so
 * parseUsage is unchanged. The Bearer token is scoped to a single org,
 * so orgUuid is only needed for the per-user run-budget sub-call (team
 * plans) — the main usage endpoint derives the org from the token.
 */
export async function fetchOrgUsage(
  orgUuid: string,
  accessToken: string,
): Promise<UsageFetchResult> {
  const trimmed = accessToken.trim();
  if (!trimmed) return { snapshot: null, error: 'missing_key' };

  // Kick off per-user run-budget in parallel with the org usage fetch.
  // Team plans return numbers here; Pro/Max return 403/404 and the call
  // resolves to null, in which case the UI falls back to extraUsage.
  const runBudgetPromise = fetchRunBudget(orgUuid, trimmed).catch(() => null);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${trimmed}`,
    'anthropic-beta': OAUTH_BETA,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  let resp: Response;
  try {
    resp = await fetch(`${BASE_URL}${USAGE_PATH}`, {
      method: 'GET',
      headers,
    });
  } catch {
    return { snapshot: null, error: 'network' };
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
  // members but 0-1 fraction in some rollouts. Normalize both to 0-1
  // to match our RateLimitWindow type.
  const utilFraction = (v: number | undefined | null): number | null => {
    if (v == null || !Number.isFinite(v)) return null;
    // If the value looks like a percent (>1.01 and ≤100), scale down.
    // If it looks like a fraction (≤1.0), leave alone.
    if (v > 1.01 && v <= 100) return v / 100;
    return v;
  };

  // `extra_usage` shape varies by plan:
  //   - Max/Pro: `monthly_limit` and `utilization` both populated.
  //   - Team: `monthly_limit` and `utilization` are null (admin-only);
  //     `used_credits` is the team-wide total. The UI relies on
  //     `perUserBudget` from the run-budget endpoint for per-member
  //     figures and shows this as the team-wide context.
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
    // Populated by fetchOrgUsage after parseUsage.
    perUserBudget: null,
    fetchedAt: Date.now(),
  };
}

/** Cents → dollars, with null guard. */
function toUsd(minorUnits: number | null | undefined): number {
  if (minorUnits == null || !Number.isFinite(minorUnits)) return 0;
  return minorUnits / 100;
}

/** How often to poll the usage endpoint. Claude Code caches its own
 *  response for 1 hour; the OAuth usage host rate-limits aggressively
 *  (anthropics/claude-code#31021 reports 429s under heavy polling).
 *  5 minutes is a conservative middle ground: fresh enough for a
 *  background budget display, well below the 1h the CLI uses. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Back-off after auth_expired — the token refresher will pick it up
 *  soon, but don't re-hammer the endpoint in the meantime. */
const AUTH_EXPIRED_BACKOFF_MS = 30 * 60 * 1000;

export interface ClaudeAiUsageStoreDeps {
  ipcServer: IpcServer;
  /** Maps Sentinel account id → org UUID. Needed for the per-user
   *  run-budget sub-call; the main usage endpoint derives org from
   *  the token itself. */
  getOrgUuid: (accountId: string) => string | null;
  /** List of Sentinel ids we should poll for. Typically every enrolled
   *  account; the store skips accounts with no stored credential. */
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

  /** Force an immediate fetch for a specific account (used after account
   *  add / token refresh so the UI doesn't wait for the poller). */
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
    const creds = readSentinelCredentials(accountId);
    const orgUuid = this.deps.getOrgUuid(accountId);
    if (!creds?.accessToken) {
      this.recordFailure(accountId, 'missing_key', force);
      return;
    }
    if (!orgUuid) {
      this.recordFailure(accountId, 'parse', force);
      return;
    }
    const result = await this.fetchImpl(orgUuid, creds.accessToken);
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
    // Longer backoff for auth expiry — the refresher handles recovery.
    // `force` (on-demand refresh) bypasses the cooldown.
    const backoff = error === 'auth_expired' && !force ? AUTH_EXPIRED_BACKOFF_MS : POLL_INTERVAL_MS;
    this.nextPollAt.set(accountId, this.clock() + backoff);
    this.lastError.set(accountId, error);
    // Don't zero out the snapshot on transient failures — the UI keeps
    // showing the last-known good numbers with a warning indicator. Only
    // missing_key clears the snapshot (there's nothing meaningful cached
    // when no credential is available).
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
