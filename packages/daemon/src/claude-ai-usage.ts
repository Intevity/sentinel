import type { IpcServer } from './ipc.js';
import type { ClaudeAiUsageSnapshot } from '@sentinel/shared';
import { readSentinelCredentials } from './accounts.js';
import { fetchRunBudget } from './claude-ai-run-budget.js';
import { headerValue, sentinelRequest, type SentinelResponse } from './http-identity.js';

/**
 * Shape of Anthropic's `/api/oauth/usage` response. Undocumented; treat
 * fields defensively. Matches the shape previously returned by
 * `/api/organizations/{uuid}/usage` — `parseUsage` is unchanged.
 */
interface RawUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string | null } | null;
  seven_day?: { utilization?: number; resets_at?: string | null } | null;
  // The Fable weekly quota has NO dedicated top-level key (there is no
  // `seven_day_fable`; the schema's per-model keys like `seven_day_opus` /
  // `seven_day_sonnet` are all null on current plans). It is served only as
  // a `limits[]` entry: kind `weekly_scoped` with
  // `scope.model.display_name === 'Fable'`, utilization in `percent`
  // (0-100 int scale, same as every other utilization here).
  //
  // Verified live 2026-07-13 against `/api/organizations/{org}/usage` (same
  // schema family this endpoint mirrors): the weekly_scoped Fable entry's
  // percent and resets_at tracked the `unified-7d_oi` response header on
  // the same org in real time, while every top-level per-model key stayed
  // null.
  limits?: Array<{
    kind?: string;
    group?: string;
    percent?: number;
    severity?: string;
    resets_at?: string | null;
    scope?: {
      model?: { id?: string | null; display_name?: string | null } | null;
      surface?: unknown;
    } | null;
    is_active?: boolean;
  } | null> | null;
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

/** Result of one usage fetch.
 *
 *  Three meaningful shapes:
 *   - `{ snapshot, error: null }`  — success.
 *   - `{ snapshot: null, error }`  — a failure worth surfacing.
 *   - `{ snapshot: null, error: null }` — **no data, and that is not a
 *     failure**: the credential is scope-limited and can never read this
 *     endpoint. Callers must treat it like the inference-only short-circuit
 *     (clear any recorded error, show nothing), never as a parse failure. */
export interface UsageFetchResult {
  snapshot: ClaudeAiUsageSnapshot | null;
  error: UsageFetchError | null;
  /** Set on HTTP 429: server-directed cooldown from the Retry-After header
   *  (clamped, with a fallback when the header is absent/malformed). The
   *  store uses it as the poll backoff instead of the 90s cadence —
   *  polling through a 429 keeps the shared per-org budget pinned at zero
   *  and starves every other consumer of the endpoint. Not a distinct
   *  UsageFetchError variant: the UI's `network` treatment (keep last-known
   *  numbers + transient warning) is already right for rate limiting. */
  retryAfterMs?: number;
}

import { getAnthropicOrigin } from './hosts.js';

const USAGE_PATH = '/api/oauth/usage';
function baseUrl(): string {
  return getAnthropicOrigin();
}

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

/** Prefix of the long-lived token minted by `claude setup-token`. Such a
 *  credential carries the `user:inference` scope ONLY — it can serve inference
 *  through the proxy, but Anthropic's OAuth metadata endpoints reject it. This
 *  is a permanent property of the token, not a transient auth failure: the sole
 *  way to "fix" it would be a `user:profile`-scoped token, which setup-token
 *  does not issue. Shared with rate-limit-probe.ts, which bails on the same
 *  prefix for the same reason. */
export const INFERENCE_ONLY_TOKEN_PREFIX = 'sk-ant-oat01-';

/** Pattern identifying Anthropic's "your token lacks the required scope" 403.
 *  Verified live 2026-07-27 against `/api/oauth/usage`:
 *
 *    403 {"error":{"type":"permission_error",
 *         "message":"OAuth token does not meet scope requirement user:profile"}}
 *
 *  `/api/oauth/profile` answers the same way with
 *  `any_of(user:profile, user:office)`, so the match deliberately stops before
 *  the scope list rather than pinning an exact set.
 *
 *  This is NOT the org-policy 403 above and NOT a dead sign-in: it is the
 *  expected answer for an inference-only credential. Routing it to
 *  `auth_expired` is what made the Usage tab claim "Sign-in expired" for a
 *  perfectly healthy account and offer a Reconnect that could never help. */
export const SCOPE_REQUIREMENT_MESSAGE_RE = /does not meet scope requirement/i;

/** Inspect a 403 response body to decide whether it is the token-scope error.
 *  Same contract as isOAuthForbiddenBodyString: the JSON text is consumed, so
 *  callers pass a pre-read string. */
export function isScopeLimitedBodyString(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      error?: { type?: string; message?: string };
    };
    return (
      parsed?.error?.type === 'permission_error' &&
      typeof parsed?.error?.message === 'string' &&
      SCOPE_REQUIREMENT_MESSAGE_RE.test(parsed.error.message)
    );
  } catch {
    // Unparseable body — can't prove scope-limited; caller falls through.
    return false;
  }
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
    authorization: `Bearer ${trimmed}`,
    'anthropic-beta': OAUTH_BETA,
    'content-type': 'application/json',
    accept: 'application/json',
  };

  let resp: SentinelResponse;
  try {
    resp = await sentinelRequest(`${baseUrl()}${USAGE_PATH}`, {
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
    if (isOAuthForbiddenBodyString(resp.body).forbidden) {
      return { snapshot: null, error: 'oauth_forbidden' };
    }
    // Token-scope 403: an inference-only `setup-token` credential asking an
    // OAuth-metadata endpoint. Report "no data, no failure" so the Usage tab
    // falls through to its plain rate-limit row rather than accusing a healthy
    // account of an expired sign-in.
    if (isScopeLimitedBodyString(resp.body)) {
      return { snapshot: null, error: null };
    }
    return { snapshot: null, error: 'auth_expired' };
  }
  if (resp.status === 401) {
    return { snapshot: null, error: 'auth_expired' };
  }
  if (resp.status === 429) {
    // Surface the server's Retry-After so the poller backs off instead of
    // re-polling in 90s — hammering through a 429 holds the per-org budget
    // at zero indefinitely (observed live: flat retry-after 3600 for days
    // while three accounts polled every 90s). Non-numeric or absent header
    // (the HTTP-date form, or nothing) falls back to a conservative wait;
    // the clamp keeps a hostile/buggy header from parking an account.
    const raSeconds = Number(headerValue(resp.headers, 'retry-after'));
    const retryAfterMs =
      Number.isFinite(raSeconds) && raSeconds > 0
        ? Math.min(raSeconds * 1000, RATE_LIMIT_MAX_BACKOFF_MS)
        : RATE_LIMIT_FALLBACK_BACKOFF_MS;
    return { snapshot: null, error: 'network', retryAfterMs };
  }
  if (resp.status < 200 || resp.status >= 300) {
    return { snapshot: null, error: 'network' };
  }

  let raw: RawUsageResponse;
  try {
    raw = JSON.parse(resp.body) as RawUsageResponse;
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
  // Exact display_name match: if Anthropic renames the scope (or adds more
  // weekly_scoped entries for other models), this degrades to "no Fable
  // data" — the UI hides the bar — rather than showing another model's
  // numbers under the Fable label.
  const fable =
    raw.limits?.find(
      (l) => l?.kind === 'weekly_scoped' && l?.scope?.model?.display_name === 'Fable',
    ) ?? null;
  const extra = raw.extra_usage ?? null;

  // The response carries the 5h window twice: the top-level `five_hour` block
  // and a redundant `limits[]` entry with `kind: 'session'` (same percent, same
  // resets_at — see the real capture in
  // packages/test-harness/src/fixtures/usage.response.json). We used to read
  // only `five_hour`, so a response that populated just the `limits[]` form
  // looked like "no 5h data" and left the countdown stale — which is a large
  // part of why the synthetic Haiku probe looked load-bearing. Prefer
  // `five_hour`, fall back to the session limit field-by-field so a partially
  // populated top-level block still gets completed rather than discarded.
  const session = raw.limits?.find((l) => l?.kind === 'session' || l?.group === 'session') ?? null;
  const fiveHourUtilizationRaw = fiveHour?.utilization ?? session?.percent ?? null;
  const fiveHourResetsAt = fiveHour?.resets_at ?? session?.resets_at ?? null;

  // claude.ai returns utilization as a percent on the 0-100 scale —
  // verified live for both Max (5h=36, 7d=3, extra_usage=77.22) and Team
  // (5h=7, 7d=1) responses. This matches how `extra_usage.utilization` is
  // consumed below (`/100` on line ~217).
  //
  // A prior heuristic ("if the value looks like a fraction ≤1.0, leave
  // alone; if it looks like a percent >1.01, scale down") tried to handle
  // a hypothetical rollout that used 0-1 fractions. It broke at the
  // 0-1% boundary: a real `seven_day.utilization = 1.0` (meaning 1%) was
  // left at 1.0 and `statusFor(1.0)` resolved to `'blocked'`, sticking
  // Team accounts into a permanent `unified-7d=blocked` state even when
  // claude.ai itself reported them far below saturation. Always scale.
  const utilFraction = (v: number | undefined | null): number | null => {
    if (v == null || !Number.isFinite(v)) return null;
    return v / 100;
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
    fiveHourUtilization: utilFraction(fiveHourUtilizationRaw),
    fiveHourResetsAt,
    sevenDayUtilization: utilFraction(sevenDay?.utilization),
    sevenDayResetsAt: sevenDay?.resets_at ?? null,
    sevenDayFableUtilization: utilFraction(fable?.percent),
    sevenDayFableResetsAt: fable?.resets_at ?? null,
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
 *  the user didn't know had been revoked. 90s is fast enough that the
 *  yellow banner appears within a minute or two of server-side
 *  revocation even if the user never opens the tray. It is NOT always
 *  below the endpoint's 429 threshold (observed live 2026-07: three
 *  accounts at 90s each held the per-org budget at zero for days) —
 *  recordFailure's Retry-After backoff is what keeps a rate-limited
 *  account from being polled straight back into the limit. */
const POLL_INTERVAL_MS = 90 * 1000;
/** Cadence once no real Claude Code request has been proxied for
 *  {@link ACTIVITY_WINDOW_MS}. The fast 90s cadence exists to catch a
 *  server-side-revoked token before Claude Code trips over it — which only
 *  matters while the user is actually driving Claude Code. Polling every
 *  account every 90s around the clock on an idle machine buys nothing and is
 *  precisely the fixed-grid, presence-independent pattern that makes Sentinel's
 *  traffic look automated rather than user-driven. */
const IDLE_POLL_INTERVAL_MS = 10 * 60 * 1000;
/** How long after the last proxied request we keep polling at the fast
 *  cadence. Generous: a user reading Claude Code's output between prompts is
 *  still "active", and re-entering the fast tier costs one poll. */
const ACTIVITY_WINDOW_MS = 15 * 60 * 1000;
/** Fraction of a computed delay to randomize, ±. Every scheduled wait in this
 *  store is jittered: without it, N accounts polled off one interval produce a
 *  perfectly periodic request train per credential, which is trivially
 *  distinguishable from human-driven use by inter-arrival regularity alone. */
const JITTER_RATIO = 0.2;
/** 429 backoff when Retry-After is absent or unparseable (HTTP-date form).
 *  Conservative: observed server cooldowns run 20-60 min. */
const RATE_LIMIT_FALLBACK_BACKOFF_MS = 15 * 60 * 1000;
/** Ceiling on a server-supplied Retry-After so a buggy header can't park
 *  an account's polling for a day. */
const RATE_LIMIT_MAX_BACKOFF_MS = 60 * 60 * 1000;
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
  /** Timestamp (ms) of the last genuinely-proxied Claude Code request, or
   *  null when the proxy has served none this run. Drives cadence tiering:
   *  poll at the fast cadence only while a real session is active, and fall
   *  back to the idle cadence otherwise. Wired to `getProxyActivity()` in
   *  index.ts, which already excludes Sentinel's own probe traffic. Omitted →
   *  always fast (legacy behavior), used by unit tests that don't care. */
  getLastClientActivityAt?: () => number | null;
  /** Test seam: swap fetch for a stub. */
  fetch?: typeof fetchOrgUsage;
  /** Test seam: deterministic clock. */
  now?: () => number;
  /** Test seam: deterministic jitter source. Must return [0, 1). */
  random?: () => number;
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
  /** Server-directed cooldowns (429 Retry-After) per account. Distinct from
   *  `nextPollAt`, which is our own cadence and which a user-initiated refresh
   *  is allowed to jump. This one nothing may jump — see `fetchOne`. */
  private cooldownUntil = new Map<string, number>();
  /** When each account last fetched successfully. The success-path cadence is
   *  measured from here so a cadence-tier change applies on the next tick — see
   *  `isDue`. */
  private lastSuccessAt = new Map<string, number>();
  /** Accounts whose stored credential is inference-only and therefore can never
   *  read this endpoint. Populated on first sight in `fetchOne` and consulted by
   *  `isDue` so the background poller skips them outright — otherwise every tick
   *  would re-derive the same verdict, and before this guard existed it spent a
   *  guaranteed-403 request doing so. Cleared automatically if the account is
   *  later given a profile-scoped token. */
  private inferenceOnly = new Set<string>();
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

  /** Spread a delay by ±{@link JITTER_RATIO} so repeated waits never land on a
   *  fixed grid. */
  private jitter(ms: number): number {
    const rand = this.deps.random ? this.deps.random() : Math.random();
    return Math.round(ms * (1 + (rand * 2 - 1) * JITTER_RATIO));
  }

  /** Fast cadence while a real Claude Code session is live, idle cadence
   *  otherwise. No activity dep → always fast. */
  private pollIntervalMs(): number {
    const lastActivity = this.deps.getLastClientActivityAt?.() ?? null;
    if (lastActivity == null && this.deps.getLastClientActivityAt) {
      return IDLE_POLL_INTERVAL_MS;
    }
    if (lastActivity == null) return POLL_INTERVAL_MS;
    return this.clock() - lastActivity <= ACTIVITY_WINDOW_MS
      ? POLL_INTERVAL_MS
      : IDLE_POLL_INTERVAL_MS;
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

  /** Whether the background poller should fetch this account now.
   *
   *  Two regimes, deliberately kept apart:
   *
   *  - **After a failure** (including a server 429), the recorded backoff is
   *    authoritative and is never shortened. An `oauth_forbidden` 24h wait must
   *    stay 24h no matter what else changes.
   *  - **After a success**, due-ness is recomputed against the *current* cadence
   *    tier rather than a delay frozen at store time. Otherwise a session
   *    resuming after an idle stretch would wait out the full idle interval
   *    before its first refresh — the tier would only take effect one poll late.
   */
  private isDue(accountId: string, now: number): boolean {
    // A scope-limited credential has no due-ness: the answer can't change until
    // the account is re-added with a different token, and that path calls
    // refresh() explicitly (which re-evaluates and clears the flag).
    if (this.inferenceOnly.has(accountId)) return false;
    if (this.lastError.get(accountId) != null) {
      return now >= (this.nextPollAt.get(accountId) ?? 0);
    }
    const last = this.lastSuccessAt.get(accountId);
    if (last == null) return true;
    return now - last >= this.jitter(this.pollIntervalMs());
  }

  private async tick(): Promise<void> {
    const now = this.clock();
    for (const accountId of this.deps.getAccountIds()) {
      if (!this.isDue(accountId, now)) continue;
      await this.fetchOne(accountId, /* force */ false);
    }
  }

  private async fetchOne(accountId: string, force: boolean): Promise<void> {
    const creds = readSentinelCredentials(accountId);

    // Decided before the cooldown gate on purpose. This branch issues no
    // request, so a server-directed backoff has no bearing on it — and an
    // account that hit a 429 while still being polled (which is how our own
    // guaranteed-403 traffic got itself rate-limited) would otherwise sit on
    // the stale "Sign-in expired" until the Retry-After elapsed. Deciding it
    // here clears that state on the very next tick after upgrade.
    if (creds?.accessToken?.startsWith(INFERENCE_ONLY_TOKEN_PREFIX)) {
      this.recordInferenceOnly(accountId);
      return;
    }

    // A server-directed 429 cooldown binds EVERY caller, including the
    // user-initiated refresh path. Previously `force` skipped this check
    // entirely, so the tray's on-focus refresh fan-out re-hit a rate-limited
    // endpoint on every window focus — which is what held an org's usage
    // budget pinned at zero for days (see POLL_INTERVAL_MS). `force` may still
    // jump our own 90s cadence; it may not jump the server's backoff.
    const cooldown = this.cooldownUntil.get(accountId) ?? 0;
    if (this.clock() < cooldown) {
      // Re-broadcast the cached state so a user-initiated refresh still
      // resolves the UI's loading indicator instead of hanging.
      if (force) {
        this.deps.ipcServer.broadcast({
          type: 'claude_ai_usage_updated',
          accountId,
          snapshot: this.snapshots.get(accountId) ?? null,
          error: this.lastError.get(accountId) ?? null,
        });
      }
      return;
    }

    const orgUuid = this.deps.getOrgUuid(accountId);
    if (!creds?.accessToken) {
      this.recordFailure(accountId, 'missing_key', force);
      return;
    }
    // Reached only by a profile-scoped token — undo any prior inference-only
    // verdict so an account re-added with a better token resumes polling.
    this.inferenceOnly.delete(accountId);
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
          this.recordFailure(accountId, retry.error ?? 'parse', force, retry.retryAfterMs);
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
      this.recordFailure(accountId, result.error, force, result.retryAfterMs);
      return;
    }
    if (!result.snapshot) {
      // `{ snapshot: null, error: null }` is fetchOrgUsage's scope-limited
      // signal (see UsageFetchResult) — the only way to reach here without an
      // error. Same end state as the prefix short-circuit above: nothing to
      // show, nothing to report, stop polling.
      this.recordInferenceOnly(accountId);
      return;
    }
    this.storeSnapshot(accountId, result.snapshot);
  }

  /**
   * Record that an account's credential can never read the usage endpoint.
   *
   * Clears any error left over from before the guard existed (users upgrading
   * mid-session would otherwise keep the stale "Sign-in expired" until restart),
   * drops the account out of the poll rotation, and broadcasts the empty-but-OK
   * state so a user-initiated Refresh resolves its spinner instead of hanging.
   */
  private recordInferenceOnly(accountId: string): void {
    this.inferenceOnly.add(accountId);
    this.lastError.delete(accountId);
    this.snapshots.delete(accountId);
    this.cooldownUntil.delete(accountId);
    this.nextPollAt.delete(accountId);
    this.deps.ipcServer.broadcast({
      type: 'claude_ai_usage_updated',
      accountId,
      snapshot: null,
      error: null,
    });
    this.fireSubscribers(accountId);
  }

  private storeSnapshot(accountId: string, snapshot: ClaudeAiUsageSnapshot): void {
    this.snapshots.set(accountId, snapshot);
    this.lastError.delete(accountId);
    this.cooldownUntil.delete(accountId);
    this.nextPollAt.delete(accountId);
    this.lastSuccessAt.set(accountId, this.clock());
    this.deps.ipcServer.broadcast({
      type: 'claude_ai_usage_updated',
      accountId,
      snapshot,
      error: null,
    });
    this.fireSubscribers(accountId);
  }

  private recordFailure(
    accountId: string,
    error: UsageFetchError,
    force: boolean,
    retryAfterMs?: number,
  ): void {
    // Per-error backoff. `force` (on-demand refresh) bypasses all cooldowns
    // EXCEPT a server-directed Retry-After — the user may re-click refresh
    // anytime (refresh() always fetches), but the background poller must
    // respect the 429 cooldown or it re-arms the rate limit forever.
    //   429 w/ Retry-After → server-directed (clamped in fetchOrgUsage)
    //   oauth_forbidden    → 24h (policy change is manual; polling burns quota)
    //   auth_expired       → 30min (refresh + retry already happened inline)
    //   other              → 5min (normal poll cadence)
    let backoff: number;
    if (retryAfterMs != null) {
      backoff = retryAfterMs;
    } else if (force) {
      backoff = this.pollIntervalMs();
    } else if (error === 'oauth_forbidden') {
      backoff = OAUTH_FORBIDDEN_BACKOFF_MS;
    } else if (error === 'auth_expired') {
      backoff = AUTH_EXPIRED_BACKOFF_MS;
    } else {
      backoff = this.pollIntervalMs();
    }
    // A server-directed Retry-After is recorded separately so no caller —
    // including a user-initiated refresh — can poll through it.
    if (retryAfterMs != null) {
      this.cooldownUntil.set(accountId, this.clock() + retryAfterMs);
    }
    // Deliberately NOT jittered. Jitter exists to break up the periodic grid of
    // *successful* polling; an error backoff is rare and event-driven, so it
    // contributes no grid. More importantly, jitter is two-sided: applying it to
    // a server-directed Retry-After would sometimes shorten it, which is the
    // exact behavior this whole change set is removing.
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
