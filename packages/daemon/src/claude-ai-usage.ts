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
 *  "this account has no valid OAuth token" from "the fetch failed in flight."
 *
 *  `oauth_forbidden` is a distinct failure from `auth_expired`: the token is
 *  accepted by auth, but the organization has OAuth API access disabled by
 *  admin/billing policy (seen as HTTP 403 with
 *  `error.type === 'permission_error'` and a message like "OAuth authentication
 *  is currently not allowed for this organization"). Neither refreshing the
 *  token nor re-authenticating helps until the org flips the policy; the UI
 *  must render a non-Reconnect panel. */
export type UsageFetchError =
  | 'missing_key'
  | 'auth_expired'
  | 'oauth_forbidden'
  | 'network'
  | 'parse';

export interface UsageFetchResult {
  snapshot: ClaudeAiUsageSnapshot | null;
  error: UsageFetchError | null;
}

const BASE_URL = 'https://api.anthropic.com';
const USAGE_PATH = '/api/oauth/usage';

/** Pattern identifying Anthropic's "org has OAuth disabled" 403 message.
 *  The exact text surfaced today is "OAuth authentication is currently not
 *  allowed for this organization"; we match case-insensitively with a
 *  tolerant leading fragment so minor wording tweaks don't silently drop
 *  us back into the auth_expired bucket. Shared with rate-limit-probe. */
export const OAUTH_FORBIDDEN_MESSAGE_RE = /oauth authentication is currently not allowed/i;

/** Inspect a 403 response body to decide whether it is the org-level
 *  "OAuth disabled" error. Returns `{ forbidden: true, message }` on match
 *  (with the verbatim error.message for logs / broadcasts), or
 *  `{ forbidden: false }` otherwise. Exported for tests + shared with the
 *  rate-limit-probe path. The passed JSON text is consumed — callers must
 *  provide either a pre-read string or a clone of the body. */
export function isOAuthForbiddenBodyString(
  body: string,
): { forbidden: true; message: string } | { forbidden: false } {
  try {
    const parsed = JSON.parse(body) as {
      error?: { type?: string; message?: string };
    };
    const errorType = parsed?.error?.type;
    const errorMessage = parsed?.error?.message;
    if (
      errorType === 'permission_error' &&
      typeof errorMessage === 'string' &&
      OAUTH_FORBIDDEN_MESSAGE_RE.test(errorMessage)
    ) {
      return { forbidden: true, message: errorMessage };
    }
  } catch {
    // Unparseable body — can't prove OAuth-forbidden; caller falls through.
  }
  return { forbidden: false };
}

/** Read + parse a Response body to check for the OAuth-forbidden signal.
 *  Returns only the boolean verdict; `fetchOrgUsage` doesn't need the
 *  message. The rate-limit-probe path uses {@link isOAuthForbiddenBodyString}
 *  directly because it has the body string already. */
async function isOAuthForbiddenBody(resp: Response): Promise<boolean> {
  let body: string;
  try {
    body = await resp.text();
  } catch {
    return false;
  }
  return isOAuthForbiddenBodyString(body).forbidden;
}
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

  if (resp.status === 403) {
    // Org-level OAuth-disabled policy emits HTTP 403 with
    // `error.type === 'permission_error'` and the "OAuth authentication is
    // currently not allowed for this organization" message. Surface it as a
    // distinct error so the UI doesn't offer a Reconnect button that would
    // just reissue a token with the same restriction.
    if (await isOAuthForbiddenBody(resp)) {
      return { snapshot: null, error: 'oauth_forbidden' };
    }
    return { snapshot: null, error: 'auth_expired' };
  }
  if (resp.status === 401) {
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

/** How often to poll the usage endpoint. Doubles as the primary
 *  server-side-revoked-token detection path: a 401 here triggers an
 *  inline forced refresh, and a failed refresh broadcasts
 *  `token_refresh_failed` → the UI's Re-authenticate banner. A tight
 *  cadence is what keeps Claude Code from blowing up on a dead token
 *  the user didn't know had been revoked. 90s strikes the balance —
 *  well above claude.ai's 429 threshold for a handful of accounts,
 *  fast enough that the yellow banner appears within a minute or two
 *  of server-side revocation even if the user never opens the tray. */
const POLL_INTERVAL_MS = 90 * 1000;
/** Back-off after auth_expired — the refresh + retry happens inline in
 *  fetchOne, so by the time we land here we've already tried to recover.
 *  The long cooldown is for persistently-dead tokens where the refresher
 *  broadcast has fired `token_refresh_failed` and the UI is already
 *  prompting for re-authentication. */
const AUTH_EXPIRED_BACKOFF_MS = 30 * 60 * 1000;
/** Back-off after oauth_forbidden. Org policy changes on a human timescale
 *  (admins enabling OAuth API access), not a request timescale — polling
 *  every 5 min against the same 403 just burns quota. 24h means the user
 *  will still see the policy flip picked up within a day of the admin
 *  enabling it; manual refresh is instant so this doesn't trap the user. */
const OAUTH_FORBIDDEN_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** Outcome of a forced-refresh attempt, surfaced from the store's injected
 *  `refreshCredential` dep. Mirrors the `RefreshResult` shape used by
 *  token-refresher.ts without pulling in its full dependency graph — the
 *  store only needs the discriminators. */
export interface UsageStoreRefreshOutcome {
  success: boolean;
  /** True when the refresh_token itself was rejected and the caller must
   *  prompt re-authentication. `token-refresh-failed` is already broadcast
   *  by the refresher in this case, so the store just records the failure. */
  needsReauth?: boolean;
}

export interface ClaudeAiUsageStoreDeps {
  ipcServer: IpcServer;
  /** Maps Sentinel account id → org UUID. Needed for the per-user
   *  run-budget sub-call; the main usage endpoint derives org from
   *  the token itself. */
  getOrgUuid: (accountId: string) => string | null;
  /** List of Sentinel ids we should poll for. Typically every enrolled
   *  account; the store skips accounts with no stored credential. */
  getAccountIds: () => string[];
  /** Force a token refresh for the given account. Called inline when
   *  fetchOrgUsage returns `auth_expired` so a silently-revoked refresh
   *  token surfaces as `token_refresh_failed` within one poll cycle (the
   *  refresher's background timer alone can't detect this because it keys
   *  on local `expiresAt`, which a revoked-but-not-yet-expired token
   *  still satisfies). Optional for tests / legacy callers — without it,
   *  `auth_expired` keeps the pre-refresh-retry behavior. */
  refreshCredential?: (accountId: string) => Promise<UsageStoreRefreshOutcome>;
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

    // Auto-recover on 401-class failures: force a refresh and retry once.
    // This catches the silently-revoked-refresh-token case that the
    // background refresher misses (it keys on local `expiresAt`, which
    // a server-side-revoked but not-yet-expired token still satisfies).
    // The refresher's own `token_refresh_failed` broadcast fires on a dead
    // refresh token, so the UI's `expiredAccountIds` state picks up the
    // reauth signal within seconds instead of never.
    if (result.error === 'auth_expired' && this.deps.refreshCredential) {
      const refreshResult = await this.deps.refreshCredential(accountId);
      if (refreshResult.success) {
        const freshCreds = readSentinelCredentials(accountId);
        if (freshCreds?.accessToken) {
          const retry = await this.fetchImpl(orgUuid, freshCreds.accessToken);
          if (!retry.error && retry.snapshot) {
            this.storeSnapshot(accountId, retry.snapshot);
            return;
          }
          // Retry failed — fall through to recordFailure with the retry
          // result's error, so a still-auth_expired state records once
          // (no recursion) and other errors reflect the current failure.
          this.recordFailure(accountId, retry.error ?? 'parse', force);
          return;
        }
      }
      // Refresh failed. If it was REFRESH_TOKEN_EXPIRED, the refresher
      // already broadcast `token_refresh_failed` so the UI shows the
      // reauth banner. We still record auth_expired here so the Usage
      // tab's own indicator lights up as a second path to Reconnect.
      this.recordFailure(accountId, 'auth_expired', force);
      return;
    }

    if (result.error) {
      this.recordFailure(accountId, result.error, force);
      return;
    }
    if (!result.snapshot) {
      this.recordFailure(accountId, 'parse', force);
      return;
    }
    this.storeSnapshot(accountId, result.snapshot);
  }

  private storeSnapshot(accountId: string, snapshot: ClaudeAiUsageSnapshot): void {
    this.snapshots.set(accountId, snapshot);
    this.lastError.delete(accountId);
    this.nextPollAt.set(accountId, this.clock() + POLL_INTERVAL_MS);
    this.deps.ipcServer.broadcast({
      type: 'claude_ai_usage_updated',
      accountId,
      snapshot,
      error: null,
    });
    this.fireSubscribers(accountId);
  }

  private recordFailure(accountId: string, error: UsageFetchError, force: boolean): void {
    // Per-error backoff. `force` (on-demand refresh) bypasses all cooldowns.
    //   oauth_forbidden → 24h (policy change is manual; polling burns quota)
    //   auth_expired    → 30min (refresh + retry already happened inline)
    //   other           → 5min (normal poll cadence)
    let backoff: number;
    if (force) {
      backoff = POLL_INTERVAL_MS;
    } else if (error === 'oauth_forbidden') {
      backoff = OAUTH_FORBIDDEN_BACKOFF_MS;
    } else if (error === 'auth_expired') {
      backoff = AUTH_EXPIRED_BACKOFF_MS;
    } else {
      backoff = POLL_INTERVAL_MS;
    }
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
