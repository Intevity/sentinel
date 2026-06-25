import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import type { Server } from 'http';
import { getProxyUpstream } from './hosts.js';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { OverageStateMachine } from './overage.js';
import { insertOverageEvent, insertNotification, insertCacheTtlEvent } from './db.js';
import type { IpcServer } from './ipc.js';
import type { RateLimitStore } from './rate-limit-store.js';
import type { SecurityScanner } from './security/scanner.js';
import type { PermissionsEnforcer } from './security/permissions/enforcer.js';
import { extractSessionInfo } from './security/permissions/enforcer.js';
import {
  createToolCallExtractor,
  applyToolResultBackfill,
  nextRequestSeqForSession,
} from './optimize/tool-call-extractor.js';
import { loadSettings } from './settings.js';
import { redactHeaders, type RequestLogStore } from './request-log-db.js';
import type { RequestAccountMap } from './request-account-map.js';
import { log } from './logger.js';
import {
  parseCacheControlMarkers,
  extractUsageFromJson,
  SseUsageExtractor,
} from './cache-ttl/parser.js';
import { computeCacheCosts } from './cache-ttl/pricing.js';
import { rewriteCacheControlTtl } from './cache-ttl/rewriter.js';
import { compressMessagesBody } from './optimize/compress/index.js';
import type { CompressionStats, CaptureRecord } from './optimize/compress/index.js';
import type {
  CompressionStatsStore,
  CompressionRetrievalRecord,
} from './optimize/compress/compression-stats-db.js';
import type { McpHttpHandler } from './optimize/compress/mcp-retrieve-server.js';
import type { CodeModeHttpHandler } from './optimize/code-mode/code-mode-server.js';
import { measureToolDefinitions } from './context-bloat/mcp-definition-cost.js';
import type { ContextCostStore } from './context-bloat/context-cost-db.js';
import type { PauseReason } from '@sentinel/shared';

export const DAEMON_PORT = 47284;

/**
 * Returns the port the daemon HTTP server listens on. Respects
 * SENTINEL_TEST_DAEMON_PORT so integration tests can bind an ephemeral
 * port and avoid colliding with the user's live daemon on 47284. Production
 * reads return 47284 unchanged (env var unset).
 */
export function getDaemonPort(): number {
  const env = process.env.SENTINEL_TEST_DAEMON_PORT;
  if (env) {
    const n = Number(env);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return DAEMON_PORT;
}
export const ANTHROPIC_HOST = 'api.anthropic.com';

// Paths that should be proxied to Anthropic
const ANTHROPIC_PATHS = ['/v1/messages', '/v1/complete', '/v1/models', '/v1/count_tokens'];

// OTEL paths handled locally
const OTEL_PATHS = ['/v1/metrics', '/v1/logs'];

// --- Proxy activity (idle gate for silent auto-updates) -------------------
// The Tauri updater asks for this via `get_proxy_activity` before silently
// installing an update: the restart kills the proxy, so an in-flight or very
// recent request means a live Claude Code session that must not be
// interrupted. Module-level on purpose — one proxy per daemon, mirroring
// getDaemonPort()'s module-level convention. Sentinel's own rate-limit
// probes (rate-limit-probe.ts routes them through this server) are excluded
// via their user-agent marker so background probing doesn't make an idle
// machine look busy.
const PROBE_USER_AGENT = 'claude-cli/sentinel-probe';

const proxyActivity = {
  inFlightRequests: 0,
  lastRequestTs: null as number | null,
};

/** Snapshot of upstream-bound proxy activity for the `get_proxy_activity`
 *  IPC handler. Mirrors `ProxyActivity` in @sentinel/shared. */
export function getProxyActivity(): { inFlightRequests: number; lastRequestTs: number | null } {
  return { ...proxyActivity };
}

/** Count an upstream-bound request toward activity. `close` fires exactly
 *  once per response on both clean finish and client abort, balancing the
 *  increment. */
function trackUpstreamRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.headers['user-agent'] === PROBE_USER_AGENT) return;
  proxyActivity.inFlightRequests += 1;
  proxyActivity.lastRequestTs = Date.now();
  res.once('close', () => {
    proxyActivity.inFlightRequests -= 1;
  });
}

/** Mutable reference to the active account's Bearer token for header injection. */
export interface ActiveToken {
  value: string | null;
}

/** Mutable reference to the active account's Sentinel key (orgUuid || accountUuid). */
export interface ActiveAccountId {
  value: string;
}

/** Per-request credential selection used by the proxy. Returned by either the
 *  active-account fallback or the round-robin rotator. */
export interface TokenSelection {
  token: string;
  accountId: string;
}

interface ProxyOptions {
  db: Database;
  ipcServer: IpcServer;
  overageMachine?: OverageStateMachine;
  /** When set, the proxy replaces the Authorization header on every upstream request. */
  activeToken?: ActiveToken;
  /** When set, rate limit headers are stored under this account's key. Updated on switch. */
  activeAccountId?: ActiveAccountId;
  /** When set, rate limit headers are parsed and stored per account after each request. */
  rateLimitStore?: RateLimitStore;
  /** When set, overrides the activeToken/activeAccountId pair on a per-request
   *  basis — used for round-robin mode. Returning null falls back to the
   *  activeToken/activeAccountId refs. `ctx.isSonnet` lets the rotator fold
   *  Sonnet-saturated accounts into the overage tier on Sonnet requests so
   *  the pool doesn't silently spill into overage when `unified-7d_sonnet`
   *  exhausts. Callers without model context pass undefined and the rotator
   *  falls back to the 5h-only gate (Opus-safe default). */
  tokenProvider?: (ctx?: { isSonnet: boolean }) => TokenSelection | null;
  /** Live accessor for the Sentinel-side paused-account set. When the
   *  account that a request is about to be attributed to is paused, the
   *  proxy short-circuits the request with 503 + Retry-After. The reset
   *  window used for Retry-After depends on the pause reason (see
   *  `getPauseReason`): 5-hour for `sentinel_budget`, 7-day for
   *  `sentinel_weekly_rate_limit`. Needed for `off` mode where the
   *  rotator's pause gate is bypassed. */
  getPausedAccountIds?: () => ReadonlySet<string>;
  /** Live accessor for the reason an account is paused. Consumed by the
   *  503 short-circuit to pick the correct error type and Retry-After
   *  source window. Returning null means "not paused" (or the caller
   *  didn't wire this up — the proxy falls back to the budget path for
   *  backwards compatibility). */
  getPauseReason?: (accountId: string) => PauseReason | null;
  /** Live accessor for the 5h reset timestamp (Unix seconds) per account.
   *  Used to populate the Retry-After header on the 503 short-circuit for
   *  budget-reason pauses. Returning null means "no reset info available";
   *  the proxy picks a conservative default. */
  getSessionResetAt?: (accountId: string) => number | null;
  /** Live accessor for the 7-day reset timestamp (Unix seconds) per
   *  account. Used in place of `getSessionResetAt` when a pause's reason
   *  is `sentinel_weekly_rate_limit` — Claude Code backing off to the 5h
   *  reset would retry hours before Anthropic will honour the request.
   *  Returning null falls back to the 5h reset. */
  getWeeklyResetAt?: (accountId: string) => number | null;
  /** Live accessor for the user's overage opt-in allow-list (Sentinel ids).
   *  Consulted by the Sonnet short-circuit: a Sonnet request whose selected
   *  account has `unified-7d_sonnet` saturated is refused with 503 unless
   *  the account is on this list. Defaults to an empty set (opt-in model),
   *  matching the rotator's default. */
  getOverageAllowedIds?: () => ReadonlySet<string>;
  /** Live accessor for the user's overage safety buffer (percent in
   *  [0, 50]). Same threshold the rotator uses — the short-circuit treats
   *  an account as saturated at `(1 − bufferPct/100)`. Defaults to 5. */
  getOverageBufferPct?: () => number;
  /** When set, every outbound /v1/messages POST is scanned (and optionally
   *  blocked) before upstream forwarding, and every response is tapped to
   *  surface risky tool_use proposals. No-op when settings disable it. */
  securityScanner?: SecurityScanner;
  /** When set, every outbound /v1/messages POST has its tools[] stripped
   *  of whole-tool deny rules, and every response is intercepted for
   *  sub-command level deny enforcement. No-op when settings disable it
   *  via `toolPermissionsEnabled`. */
  permissionsEnforcer?: PermissionsEnforcer;
  /** Dedicated store for captured request/response pairs. When set AND
   *  `settings.requestLoggingEnabled` is true at request time, the proxy
   *  records each proxied call here. Gated per-request so the toggle takes
   *  effect without a daemon restart. */
  requestLogStore?: RequestLogStore;
  /** Dedicated store for per-request tool_result compression stats. When set
   *  AND `settings.compressionEnabled` is true at request time, the proxy
   *  compresses the outbound /v1/messages body and records the savings here.
   *  Gated per-request so the toggle takes effect without a daemon restart. */
  compressionStore?: CompressionStatsStore;
  /** Dedicated store for measured MCP tool-definition costs. When set AND
   *  `settings.optimizeCaptureEnabled` is true at request time, the proxy
   *  measures the outbound /v1/messages tools[] array per MCP server and
   *  records the context-window tax here. Pure observer — never mutates
   *  the body. Gated per-request so the toggle takes effect without a
   *  daemon restart. */
  contextCostStore?: ContextCostStore;
  /** Handler for the local `/mcp` retrieval endpoint (reversible compression).
   *  When set, GET/POST/DELETE to `/mcp` are served by Sentinel's MCP server.
   *  Built in index.ts from the compression store + bearer token. */
  mcpHandler?: McpHttpHandler;
  /** Handler for the local `/code-mode/call` bridge endpoint. When set,
   *  POSTs there invoke tools on bridged MCP servers via the daemon's
   *  client manager. Built in index.ts from the manager + its own bearer
   *  token. */
  codeModeHandler?: CodeModeHttpHandler;
  /** Short-lived table mapping Anthropic `request-id` → per-request Sentinel
   *  key. Populated here on every upstream response that carries the header,
   *  consumed by OtelReceiver so round-robin-routed OTEL events land on the
   *  account whose token was actually used (not the one Claude Code is
   *  signed in as). */
  requestAccountMap?: RequestAccountMap;
  /** Called when an upstream Anthropic response returns 401 for an
   *  identified account. Wired in index.ts to call refreshIfNeeded(force=true)
   *  so a server-side-revoked-but-not-yet-locally-expired token gets
   *  refreshed (or, if the refresh itself fails, the refresher broadcasts
   *  token_refresh_failed so the UI's Re-authenticate banner lights up
   *  within seconds of the failing Claude Code request). Fire-and-forget —
   *  the proxy does not retry the current request, but the next one will
   *  use the freshly-refreshed token. Dedup of in-flight refreshes is the
   *  callback's responsibility. */
  onUpstreamAuthFailure?: (accountId: string) => void;
  /** Optimize feature: invoked once per /v1/messages response after the
   *  tool-call extractor has flushed a non-empty batch of rows into
   *  `tool_calls`. Wired to the analyzer's debounced `scheduleRun` so
   *  the dashboard updates within ~1.5s of the proxy completing a
   *  tool_use, mirroring the Metrics tab's near-real-time refresh.
   *  Optional — when unset, the analyzer relies solely on its periodic
   *  scan loop. */
  onToolCallsFlushed?: () => void;
  /** Sprint 9 health probe. Returns the per-component status of the
   *  daemon's critical subsystems (DB, scanner, enforcer). Used by
   *  `/health` to respond 503 when any component is degraded and by
   *  the proxy's `daemonHealthFailMode === 'closed'` short-circuit to
   *  refuse to forward requests. */
  getHealth?: () => DaemonHealthSnapshot;
  /** Live accessor for the user's `daemonHealthFailMode` setting.
   *  When `'closed'`, any unhealthy component synthesizes a 503 to
   *  Claude Code; when `'open'`, the proxy forwards anyway; the
   *  default `'warn'` logs but forwards. Returning undefined or no
   *  function disables the gate entirely (legacy behaviour). */
  getSettings?: () => { daemonHealthFailMode: 'closed' | 'open' | 'warn' };
}

/** Per-component health snapshot returned by `getHealth()`. Each
 *  field is either the literal `'ok'` or an arbitrary failure
 *  detail string. */
export interface DaemonHealthSnapshot {
  db: 'ok' | string;
  scanner: 'ok' | string;
  enforcer: 'ok' | string;
}

const HEALTH_LOG_THROTTLE_MS = 60_000;

/** Mutable capture state threaded through a single request's lifecycle.
 *  Built when capture is enabled, populated phase by phase, and handed to
 *  `RequestLogStore.enqueue()` on finalization. */
interface CaptureContext {
  requestId: string;
  startMs: number;
  maxBodyBytes: number;
  captureResponse: boolean;
  redactAuth: boolean;
  method: string;
  urlPath: string;
  requestHeaders: Record<string, string>;
  requestBody: Buffer | null;
  requestBodySize: number;
  requestBodyTruncated: boolean;
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseChunks: Buffer[];
  /** Total bytes actually appended to `responseChunks`. Tracked separately
   *  so the hot-path chunk handler stays O(1) instead of re-summing the
   *  array on every chunk — matters for long SSE streams. */
  responseStoredBytes: number;
  /** Total bytes seen on the wire, regardless of what was stored. Reported
   *  to the UI so truncation is visible even when the cap is tiny. */
  responseBodySize: number;
  responseBodyTruncated: boolean;
  isSse: boolean;
  errorMessage: string | null;
  finalized: boolean;
}

// Minimum milliseconds between rate_limits_updated broadcasts per account
// to avoid flooding the UI on rapid successive requests.
const RL_BROADCAST_DEBOUNCE_MS = 2_000;

// Cache TTL inserts happen once per /v1/messages response. Debounce the
// metrics_updated broadcast to this cadence so a burst of requests doesn't
// cause the UI to re-fetch on every single one.
const CACHE_TTL_BROADCAST_DEBOUNCE_MS = 1_000;

// Upstream socket inactivity timeout. Auto-resets on each read/write, so
// long-running SSE streams that keep producing chunks are never affected.
// A hung socket (pre-headers or mid-stream) is aborted here instead of
// waiting on the OS TCP retransmit budget (~50s on macOS surfacing as a
// less-actionable `read ETIMEDOUT`).
const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

/** Compact one-line summary of the overage/5h headers worth logging per
 *  response. Returns null when there are no rate-limit headers to summarize.
 *  Intentionally selective — full header dumps flood the log.
 *  Exported for tests. */
export function summarizeOverageHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const pick = (k: string): string | null => {
    const v = headers[k];
    if (v === undefined) return null;
    const str = Array.isArray(v) ? v[0] : v;
    return str ?? null;
  };
  const fields: Array<[string, string | null]> = [
    ['overage-status', pick('anthropic-ratelimit-unified-overage-status')],
    ['overage-in-use', pick('anthropic-ratelimit-unified-overage-in-use')],
    ['5h-status', pick('anthropic-ratelimit-unified-5h-status')],
    ['5h-util', pick('anthropic-ratelimit-unified-5h-utilization')],
  ];
  const nonNull = fields.filter(([, v]) => v !== null);
  if (nonNull.length === 0) return null;
  return nonNull.map(([k, v]) => `${k}=${v}`).join(' ');
}

/**
 * Creates and returns the main HTTP server for the sentinel daemon.
 * Routes:
 *   - OTEL paths      → handled by otelReceiver
 *   - Anthropic paths → proxied to api.anthropic.com
 *   - /health         → health check
 */
export function createProxyServer(
  opts: ProxyOptions,
  otelHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Server {
  const machine = opts.overageMachine ?? new OverageStateMachine();

  // Register overage transition handler
  machine.onTransition((event) => {
    const { accountId, transition, state } = event;
    const now = Date.now();

    // Persist overage event. `INSERT OR IGNORE` returns null when a row for
    // the same (accountId, resetsAt, transition) already exists — a defensive
    // layer under the state-machine dedup, catches daemon-restart races where
    // the in-memory `fired` map was not rehydrated yet. When skipped, we also
    // swallow the in-app notification row and IPC broadcast so the UI does
    // not see a ghost transition.
    const rowId = insertOverageEvent(opts.db, {
      ts: now,
      accountId,
      transition,
      status: state.status,
      resetsAt: state.resetsAt,
      disabledReason: state.disabledReason,
    });
    if (rowId === null) return;

    // Build notification
    let title: string;
    let body: string;

    if (transition === 'entered') {
      const resetDate = state.resetsAt
        ? new Date(state.resetsAt * 1000).toLocaleDateString()
        : 'unknown';
      title = `⚠️ Overage started — ${accountId}`;
      body = `Claude Code is now using your overage budget. Resets ${resetDate}.`;
    } else if (transition === 'disabled') {
      /* v8 ignore next 2 */
      const reason = state.disabledReason ?? 'budget exhausted';
      const resetDate = state.resetsAt
        ? new Date(state.resetsAt * 1000).toLocaleDateString()
        : 'unknown';
      title = `🚫 Overage limit reached — ${accountId}`;
      body = `Overage disabled (${reason}). Claude Code requests may be blocked until ${resetDate}.`;
    } else {
      title = `✅ Overage ended — ${accountId}`;
      body = `Claude Code is no longer using overage budget.`;
    }

    insertNotification(opts.db, {
      ts: now,
      accountId,
      /* v8 ignore next 1 */
      type: transition === 'entered' ? 'overage_entered' : 'overage_disabled',
      title,
      body,
    });

    // Notify Tauri app
    if (transition === 'entered') {
      opts.ipcServer.broadcast({ type: 'overage_entered', accountId, resetsAt: state.resetsAt });
    } else if (transition === 'disabled') {
      opts.ipcServer.broadcast({
        type: 'overage_disabled',
        accountId,
        /* v8 ignore next 1 */
        reason: state.disabledReason ?? 'unknown',
      });
    } else if (transition === 'exited') {
      opts.ipcServer.broadcast({ type: 'overage_exited', accountId });
    }
  });

  const activeToken = opts.activeToken ?? { value: null };
  const activeAccountId = opts.activeAccountId;
  const rateLimitStore = opts.rateLimitStore;
  const tokenProvider = opts.tokenProvider;
  const {
    ipcServer,
    securityScanner,
    permissionsEnforcer,
    requestLogStore,
    compressionStore,
    contextCostStore,
    mcpHandler,
    codeModeHandler,
    requestAccountMap,
    onUpstreamAuthFailure,
    onToolCallsFlushed,
  } = opts;
  const getPausedAccountIds = opts.getPausedAccountIds ?? (() => new Set<string>());
  const getPauseReason = opts.getPauseReason ?? (() => null);
  const getSessionResetAt = opts.getSessionResetAt ?? (() => null);
  const getWeeklyResetAt = opts.getWeeklyResetAt ?? (() => null);
  const getOverageAllowedIds = opts.getOverageAllowedIds ?? (() => new Set<string>());
  const getOverageBufferPct = opts.getOverageBufferPct ?? (() => 5);

  /** Pick the right 503 parameters for a paused account based on reason.
   *  Budget pauses release on the 5h reset; weekly-rate-limit pauses
   *  release on the 7d reset (clearer signal to Claude Code to stop
   *  retrying for hours, not minutes). Anthropic's own overage-disabled
   *  state falls through to the budget shape for backwards compatibility
   *  — the caller injected the pause for a reason we can't distinguish
   *  from budget at this layer. */
  const respondPaused = (res: ServerResponse, accountId: string): void => {
    const reason = getPauseReason(accountId);
    if (reason === 'sentinel_weekly_rate_limit') {
      const resetSec = getWeeklyResetAt(accountId) ?? getSessionResetAt(accountId);
      respond503(
        res,
        resetSec,
        'sentinel_weekly_rate_limit_paused',
        'Sentinel has paused this account because its weekly (7-day) rate limit was reached. ' +
          'It will resume automatically when the 7-day window resets. ' +
          'Switch accounts to unblock sooner.',
      );
      return;
    }
    respond503(
      res,
      getSessionResetAt(accountId),
      'sentinel_budget_paused',
      'Sentinel has paused this account because its weekly budget was reached. ' +
        'It will resume automatically when the 5-hour window resets. ' +
        'Switch accounts or raise the Sentinel budget in Settings to unblock sooner.',
    );
  };

  // Tracks the last broadcast time per account to debounce rapid-fire requests
  const lastBroadcast = new Map<string, number>();

  /**
   * Resolve the (token, accountId) pair for an outgoing request. Precedence:
   *   1. Per-request override via `x-sentinel-probe-token` + `x-sentinel-probe-account`
   *      — used by the background usage-probe to probe a non-active account
   *      without mutating the active-token refs. Headers are stripped before
   *      upstream forwarding so they never leak to Anthropic.
   *   2. `tokenProvider` (round-robin mode). `ctx.isSonnet` is threaded
   *      through so the rotator can fold Sonnet-saturated accounts into
   *      the overage tier on Sonnet requests.
   *   3. Shared `activeToken` / `activeAccountId` refs (default flow).
   */
  const selectCredential = (
    req: IncomingMessage,
    ctx?: { isSonnet: boolean },
  ): TokenSelection | null => {
    const probeToken = req.headers['x-sentinel-probe-token'];
    const probeAccount = req.headers['x-sentinel-probe-account'];
    if (
      typeof probeToken === 'string' &&
      typeof probeAccount === 'string' &&
      probeToken &&
      probeAccount
    ) {
      delete req.headers['x-sentinel-probe-token'];
      delete req.headers['x-sentinel-probe-account'];
      return { token: probeToken, accountId: probeAccount };
    }
    const fromProvider = tokenProvider?.(ctx);
    if (fromProvider) return fromProvider;
    if (activeToken.value) {
      return { token: activeToken.value, accountId: activeAccountId?.value ?? 'default' };
    }
    return null;
  };

  /**
   * Emit a Retry-After 503 to pause further client retries until the named
   * reset window rolls over. Shared between the Sentinel-budget pause and
   * the Sonnet-saturation gate so both surfaces render identical shape and
   * drop the client into the same exponential-backoff state machine.
   */
  const respond503 = (
    res: ServerResponse,
    resetSec: number | null,
    errorType: string,
    message: string,
  ): void => {
    const retryAfter =
      resetSec != null ? Math.max(1, resetSec - Math.floor(Date.now() / 1000)) : 300;
    res.writeHead(503, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter),
    });
    res.end(JSON.stringify({ error: { type: errorType, message } }));
  };

  /**
   * Async path for `/v1/messages*` POSTs. Buffers the request body so we
   * can inspect the `model` field before credential selection — this is
   * what lets the rotator route Sonnet-saturated accounts into the
   * overage tier without ever touching an Opus request. The buffered body
   * is forwarded into `proxyToAnthropic` via the final arg so it isn't
   * re-read downstream.
   */
  const handleMessagesPost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    const model = extractRequestModel(body);
    const isSonnet = isSonnetModel(model);

    const credential = selectCredential(req, { isSonnet });
    if (credential) {
      req.headers['authorization'] = `Bearer ${credential.token}`;
    }
    const perRequestAccountId = credential?.accountId ?? activeAccountId?.value;

    // Sentinel-side pause short-circuit. The rotator already skips paused
    // accounts in round-robin, so this only fires in `off` mode or when
    // a probe header landed on a paused account. Retry-After and error
    // type depend on the pause reason — see respondPaused for the split
    // between budget (5h reset) and weekly-rate-limit (7d reset).
    if (perRequestAccountId && getPausedAccountIds().has(perRequestAccountId)) {
      respondPaused(res, perRequestAccountId);
      return;
    }

    // Sonnet saturation short-circuit. Fires when the request is a Sonnet
    // model AND the selected account's `unified-7d_sonnet` utilization is
    // at or above the overage-buffer threshold AND the account is NOT
    // opted into overage. Without this, the request would silently spill
    // into the user's monthly overage budget even when `unified-5h` still
    // has room. The rotator applies the same gate for round-robin picks;
    // this catches single-account mode and the RR edge case where every
    // candidate is Sonnet-saturated (rotator returns null → fallback to
    // activeToken → this fires).
    if (isSonnet && perRequestAccountId && rateLimitStore) {
      if (!getOverageAllowedIds().has(perRequestAccountId)) {
        const sonnet = rateLimitStore
          .getAll(perRequestAccountId)
          .find((w) => w.name === 'unified-7d_sonnet');
        const rawBuffer = getOverageBufferPct();
        const clampedBuffer = Math.max(0, Math.min(50, rawBuffer));
        const threshold = 1 - clampedBuffer / 100;
        if (sonnet?.utilization != null && sonnet.utilization >= threshold) {
          respond503(
            res,
            sonnet.reset ?? null,
            'sentinel_sonnet_saturated',
            "Sentinel refused this Sonnet request because this account's " +
              'Sonnet 7-day quota is exhausted and the account is not opted ' +
              'into overage. Switch accounts, use a non-Sonnet model, or ' +
              'enable overage for this account in Settings.',
          );
          return;
        }
      }
    }

    // 429-retry callback. Only the messages path has a buffered body to
    // replay, so only this path offers retry. The provider picks a fresh
    // round-robin credential excluding the account that just 429'd — when
    // the rotator returns the same account (pool of one, or all others
    // unavailable), we skip the retry so the client sees the 429.
    const retryProvider = tokenProvider
      ? (currentAccountId: string): TokenSelection | null => {
          for (let i = 0; i < 5; i++) {
            const next = tokenProvider({ isSonnet });
            if (!next) return null;
            if (next.accountId !== currentAccountId) return next;
          }
          return null;
        }
      : undefined;

    await proxyToAnthropic(
      req,
      res,
      machine,
      rateLimitStore,
      perRequestAccountId,
      ipcServer,
      lastBroadcast,
      securityScanner,
      permissionsEnforcer,
      requestLogStore,
      opts.db,
      body,
      requestAccountMap,
      onUpstreamAuthFailure,
      retryProvider,
      onToolCallsFlushed,
      compressionStore,
      contextCostStore,
    );
  };

  // Sprint 9: throttle the warn-mode log so a degraded subsystem doesn't
  // flood daemon.log on every request. Per-component last-logged stamp.
  const lastDegradeLogAt: Record<keyof DaemonHealthSnapshot, number> = {
    db: 0,
    scanner: 0,
    enforcer: 0,
  };

  const evaluateHealth = (): {
    healthy: boolean;
    snapshot: DaemonHealthSnapshot;
  } => {
    if (!opts.getHealth) {
      return { healthy: true, snapshot: { db: 'ok', scanner: 'ok', enforcer: 'ok' } };
    }
    const snapshot = opts.getHealth();
    const healthy = snapshot.db === 'ok' && snapshot.scanner === 'ok' && snapshot.enforcer === 'ok';
    return { healthy, snapshot };
  };

  const server = createServer((req, res) => {
    /* v8 ignore next 1 */
    const url = req.url ?? '/';

    // Health check
    if (url === '/health') {
      const { healthy, snapshot } = evaluateHealth();
      const status = healthy ? 200 : 503;
      const body = {
        status: healthy ? 'ok' : 'degraded',
        pid: process.pid,
        components: snapshot,
      };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    // Sprint 9 fail-mode gate. Only consults health when the user wired
    // a probe in; legacy paths (no `getHealth`) skip this entirely so
    // existing tests don't change behaviour.
    if (opts.getHealth) {
      const { healthy, snapshot } = evaluateHealth();
      if (!healthy) {
        // `?? 'warn'` is the no-getSettings-wired fallback; in production
        // index.ts always wires both, so this default is reached only by
        // a partial-wiring test path that we don't exercise.
        /* v8 ignore next 1 */
        const failMode = opts.getSettings?.().daemonHealthFailMode ?? 'warn';
        // Throttled warn line for any failed component, regardless of
        // mode. Keeps operators informed without flooding the log.
        const now = Date.now();
        for (const k of Object.keys(snapshot) as Array<keyof DaemonHealthSnapshot>) {
          if (snapshot[k] !== 'ok' && now - lastDegradeLogAt[k] >= HEALTH_LOG_THROTTLE_MS) {
            console.warn(`[Health] degraded: ${k}=${snapshot[k]}`);
            lastDegradeLogAt[k] = now;
          }
        }
        if (failMode === 'closed') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'sentinel daemon degraded; refusing to forward',
              components: snapshot,
            }),
          );
          return;
        }
      }
    }

    if (OTEL_PATHS.some((p) => url.startsWith(p)) && req.method === 'POST') {
      otelHandler(req, res).catch((err) => {
        console.error('[Proxy] OTEL handler error:', err);
        res.writeHead(500);
        res.end();
      });
      return;
    }

    // Reversible-compression retrieval MCP endpoint. Served by Sentinel's own
    // MCP server, not proxied upstream. The handler validates the bearer token
    // and speaks the MCP streamable-HTTP protocol.
    if (mcpHandler && url.split('?')[0] === '/mcp') {
      void (async () => {
        const body = req.method === 'POST' ? await readBody(req) : null;
        await mcpHandler(req, res, body);
      })().catch((err) => {
        console.error('[Proxy] MCP handler error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
      return;
    }

    // Code-mode bridge endpoint. Invokes tools on bridged MCP servers via
    // the daemon's client manager; never proxied upstream. The handler
    // validates its own bearer token and enforces the server allowlist.
    if (codeModeHandler && url.split('?')[0] === '/code-mode/call') {
      void (async () => {
        const body = req.method === 'POST' ? await readBody(req) : null;
        await codeModeHandler(req, res, body);
      })().catch((err) => {
        console.error('[Proxy] code-mode handler error:', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
      return;
    }

    // `/v1/messages*` POSTs need the body buffered BEFORE credential
    // selection so the rotator can see the model. Every other path (GETs,
    // non-messages endpoints, probes with overrides) uses the sync fast
    // path — they don't depend on model identity for routing.
    if (req.method === 'POST' && url.startsWith('/v1/messages')) {
      trackUpstreamRequest(req, res);
      handleMessagesPost(req, res).catch((err) => {
        console.error('[Proxy] Messages POST handler error:', err);
        if (!res.headersSent) {
          res.writeHead(502);
          res.end();
        }
      });
      return;
    }

    const credential = selectCredential(req);
    if (credential) {
      req.headers['authorization'] = `Bearer ${credential.token}`;
    }

    // Proxy Anthropic API calls — attribute rate-limit headers to the
    // specific account whose token was used for this request (matters for
    // round-robin where that may differ from the primary active account).
    const perRequestAccountId = credential?.accountId ?? activeAccountId?.value;

    // Sentinel-side pause short-circuit for non-messages paths (probes,
    // /v1/models GETs, etc.). The messages path runs the same check inside
    // handleMessagesPost after the body is buffered.
    if (perRequestAccountId && getPausedAccountIds().has(perRequestAccountId)) {
      respondPaused(res, perRequestAccountId);
      return;
    }

    if (ANTHROPIC_PATHS.some((p) => url.startsWith(p))) {
      trackUpstreamRequest(req, res);
      proxyToAnthropic(
        req,
        res,
        machine,
        rateLimitStore,
        perRequestAccountId,
        ipcServer,
        lastBroadcast,
        securityScanner,
        permissionsEnforcer,
        requestLogStore,
        opts.db,
        undefined,
        requestAccountMap,
        onUpstreamAuthFailure,
        undefined,
        onToolCallsFlushed,
      ).catch((err) => {
        console.error('[Proxy] Proxy error:', err);
        res.writeHead(502);
        res.end();
      });
      return;
    }

    // Default: proxy all other paths to Anthropic (future-proof)
    proxyToAnthropic(
      req,
      res,
      machine,
      rateLimitStore,
      perRequestAccountId,
      ipcServer,
      lastBroadcast,
      undefined,
      undefined,
      requestLogStore,
      opts.db,
      undefined,
      requestAccountMap,
      onUpstreamAuthFailure,
      undefined,
      onToolCallsFlushed,
    ).catch((err) => {
      console.error('[Proxy] Default proxy error:', err);
      res.writeHead(502);
      res.end();
    });
  });

  return server;
}

/**
 * Forward a request to api.anthropic.com and inspect the response headers.
 *
 * `preReadBody` lets a caller that has already consumed the request body
 * (e.g. `handleMessagesPost`, which buffers the body to read the model
 * before picking a credential) pass it in so it isn't re-read from the
 * now-drained `req` stream.
 */
async function proxyToAnthropic(
  req: IncomingMessage,
  res: ServerResponse,
  machine: OverageStateMachine,
  rateLimitStore?: RateLimitStore,
  /** Account key to attribute this request's rate-limit headers under.
   *  Passed per-request so round-robin rotation stays correctly attributed. */
  attributionAccountId?: string,
  ipcServer?: IpcServer,
  lastBroadcast?: Map<string, number>,
  securityScanner?: SecurityScanner,
  permissionsEnforcer?: PermissionsEnforcer,
  requestLogStore?: RequestLogStore,
  db?: Database,
  preReadBody?: Buffer,
  /** Per-request correlation table. Populated here when the upstream response
   *  carries a `request-id` header so OtelReceiver can attribute OTEL
   *  api_request / api_error events to the correct account in round-robin mode. */
  requestAccountMap?: RequestAccountMap,
  /** Fire-and-forget hook invoked when an upstream response returns 401
   *  for an identified account. See ProxyOptions.onUpstreamAuthFailure. */
  onUpstreamAuthFailure?: (accountId: string) => void,
  /** Retry callback consulted only on a 429 response. Given the account id
   *  whose request just 429'd, returns a replacement credential to retry
   *  with (or null to forward the 429 unmodified). Only one retry is
   *  attempted per request; a second 429 is forwarded to the client.
   *  Not provided for non-messages endpoints (probes, GETs) — those have
   *  no buffered body to replay. */
  retryCredentialProvider?: (currentAccountId: string) => TokenSelection | null,
  /** Optimize feature: invoked when the per-request tool-call extractor
   *  flushes a non-empty batch. See ProxyOptions.onToolCallsFlushed. */
  onToolCallsFlushed?: () => void,
  /** Compression feature: dedicated store for per-request compression stats.
   *  See ProxyOptions.compressionStore. */
  compressionStore?: CompressionStatsStore,
  /** Optimize feature: dedicated store for measured MCP tool-definition
   *  costs. See ProxyOptions.contextCostStore. */
  contextCostStore?: ContextCostStore,
): Promise<void> {
  let body = preReadBody ?? (await readBody(req));

  // Build a capture context when request logging is enabled. Read settings
  // per-request so the toggle takes effect without a daemon restart. Probe
  // requests skip capture — they're internal noise, not user-originated.
  const settings = loadSettings();
  const isProbe = String(req.headers['user-agent'] ?? '').includes('sentinel-probe');
  const capture: CaptureContext | null =
    requestLogStore && settings.requestLoggingEnabled && !isProbe
      ? {
          requestId: randomUUID(),
          startMs: Date.now(),
          maxBodyBytes: settings.requestLogMaxBodyKb * 1024,
          captureResponse: settings.requestLogCaptureResponse,
          redactAuth: settings.requestLogRedactAuthHeaders,
          method: req.method ?? 'GET',
          urlPath: req.url ?? '/',
          requestHeaders: {},
          requestBody: null,
          requestBodySize: 0,
          requestBodyTruncated: false,
          responseStatus: null,
          responseHeaders: null,
          responseChunks: [],
          responseStoredBytes: 0,
          responseBodySize: 0,
          responseBodyTruncated: false,
          isSse: false,
          errorMessage: null,
          finalized: false,
        }
      : null;

  // Extract account UUID from request headers for overage tracking
  const accountId =
    (req.headers['x-account-uuid'] as string | undefined) ??
    extractAccountFromAuth(req.headers['authorization'] as string | undefined) ??
    'default';

  const rlKey = attributionAccountId ?? accountId;

  // Cache TTL tracking: one row per /v1/messages POST that yielded usage.
  // Independent of request-log capture so the feature is on even when the
  // broader logging toggle is off. count_tokens and probes are filtered out.
  const isMessagesPost =
    req.method === 'POST' &&
    (req.url?.startsWith('/v1/messages') ?? false) &&
    !(req.url?.includes('count_tokens') ?? false) &&
    !isProbe;
  const cacheTtlCtx: {
    db: Database;
    requestId: string;
    sessionId: string | null;
    markers5m: number;
    markers1h: number;
    sse: SseUsageExtractor;
    nonSseChunks: Buffer[];
    nonSseBytes: number;
    isSse: boolean;
  } | null =
    db && isMessagesPost
      ? {
          db,
          requestId: capture?.requestId ?? randomUUID(),
          sessionId: null,
          markers5m: 0,
          markers1h: 0,
          sse: new SseUsageExtractor(),
          nonSseChunks: [],
          nonSseBytes: 0,
          isSse: false,
        }
      : null;

  // Optimize feature: in-proxy tool-call extractor. Always on when the
  // settings toggle allows it. Pure observer — never participates in
  // forwarding, never blocks a chunk. Stores ONLY structured metadata
  // (tool_use_id, name, file_path when present, sizes) — never raw
  // tool input/output payloads. Disclosure copy lives in the Optimize
  // section of SettingsPanel.
  const toolCallCtx: {
    extractor: ReturnType<typeof createToolCallExtractor>;
    requestId: string;
  } | null =
    db && isMessagesPost && settings.optimizeCaptureEnabled
      ? (() => {
          const sessionInfo = extractSessionInfo(body);
          const sessionId = sessionInfo?.sessionId ?? null;
          const seq = nextRequestSeqForSession(sessionId, Date.now());
          const requestId = capture?.requestId ?? cacheTtlCtx?.requestId ?? randomUUID();
          // Backfill prior tool_calls' response_size_bytes and quote
          // detection from this request's tool_result and text blocks.
          // Best-effort; any parse error is silently ignored so the
          // proxy hot path never stalls on this side-channel.
          /* v8 ignore next 5 */
          try {
            applyToolResultBackfill(db, body, sessionId);
          } catch {
            /* swallow */
          }
          return {
            extractor: createToolCallExtractor({
              db,
              accountId: rlKey,
              sessionId,
              requestId,
              requestSeqInSession: seq,
              // Best-effort model extraction — extractor stores it on
              // every row so analyzer can scope by main-conversation
              // model. Fall back to empty string when missing; the
              // analyzer treats unknown-model rows as Opus-equivalent.
              model: (() => {
                try {
                  const parsed = JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
                  const m = parsed['model'];
                  return typeof m === 'string' ? m : '';
                  /* v8 ignore next 3 */
                } catch {
                  return '';
                }
              })(),
              deniedToolNames: new Set(),
              nowMs: Date.now(),
            }),
            requestId,
          };
        })()
      : null;

  // Auto-mode observation — always runs so the UI's "Claude Code is in auto
  // mode" indicator stays live even when Sentinel's own rule enforcement is
  // turned off. Scoped to /v1/messages POST (actual conversation requests),
  // not count_tokens or probes. The enforcer only reads the auto-mode beta
  // headers here; session identity (from the body) is handled separately on
  // the enforcement path below.
  if (
    permissionsEnforcer &&
    req.method === 'POST' &&
    req.url?.startsWith('/v1/messages') &&
    !req.url.includes('count_tokens') &&
    !String(req.headers['user-agent'] ?? '').includes('sentinel-probe')
  ) {
    permissionsEnforcer.observeRequest(req.headers);
  }

  // Tool permission enforcement — request side. Whole-tool deny rules strip
  // the matching `tools[]` entry from the body so the model never sees it.
  // Sub-command rules are handled at response time by the SSE interceptor.
  //
  // Auto mode is detected two ways (either skips enforcement when the user
  // has `toolPermissionSkipInAutoMode` on):
  //   1. Manual toggle in Settings
  //   2. `anthropic-beta: ...afk-mode-<date>...` header on this request
  // The header check is per-request so Claude Code sessions with different
  // modes (run in parallel) each get the right treatment.
  if (
    permissionsEnforcer?.isEnabled() &&
    !permissionsEnforcer.isSkippedForAutoMode(req.headers) &&
    req.method === 'POST' &&
    req.url?.startsWith('/v1/messages')
  ) {
    const rewritten = await permissionsEnforcer.stripDeniedTools(body, rlKey, req.headers);
    if (rewritten !== body) {
      body = rewritten;
      // Keep Content-Length honest so Node doesn't truncate or stall.
      req.headers['content-length'] = String(body.length);
    }
    // The SSE interceptor can't decompress gzip, so force identity encoding
    // from upstream when enforcement is live.
    delete req.headers['accept-encoding'];
  }

  // Cache TTL override — when the user has opted in, rewrite every existing
  // `cache_control` block on outbound /v1/messages (including subpath
  // /v1/messages/count_tokens) requests to `{type: 'ephemeral', ttl: '1h'}`.
  // Only mutates breakpoints the client already placed, so we stay under the
  // 4-breakpoint API cap automatically. The beta header was required when
  // 1h TTL was gated; it's GA now but harmless to include as insurance.
  if (
    settings.cacheTtlForceOneHour &&
    req.method === 'POST' &&
    req.url?.startsWith('/v1/messages')
  ) {
    const rewritten = rewriteCacheControlTtl(body, '1h');
    if (rewritten !== body) {
      body = rewritten;
      req.headers['content-length'] = String(body.length);
    }
    const existingBeta = req.headers['anthropic-beta'];
    const betaToken = 'extended-cache-ttl-2025-04-11';
    if (typeof existingBeta === 'string') {
      if (
        !existingBeta
          .split(',')
          .map((s) => s.trim())
          .includes(betaToken)
      ) {
        req.headers['anthropic-beta'] = `${existingBeta}, ${betaToken}`;
      }
    } else if (Array.isArray(existingBeta)) {
      req.headers['anthropic-beta'] = [...existingBeta, betaToken];
    } else {
      req.headers['anthropic-beta'] = betaToken;
    }
  }

  // Security scan — runs against the outbound JSON before we forward. In
  // block-mode, a finding at or above the severity floor returns
  // `pending`: the request is held open up to `securityApproveHoldSec`
  // while the user decides whether to approve. On approve, the held
  // body is forwarded upstream as if nothing happened. On deny or
  // timeout, a 403 is synthesized.
  if (securityScanner && req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
    // Extract sessionInfo so the scanner can populate the Sprint 8
    // forensic incident-replay buffer when the user opted in. Cheap
    // (single JSON.parse already paid by sessionInfo extraction in
    // most paths); a parse failure here just yields null and the
    // scanner skips replay capture for this request.
    const replaySessionInfo = extractSessionInfo(body);
    const decision = securityScanner.scanOutbound(body, rlKey, replaySessionInfo?.sessionId);

    const synthesize403 = (reason: string, tag: string): void => {
      const payload = JSON.stringify({
        type: 'error',
        error: {
          type: 'permission_denied',
          message: `Blocked by Sentinel: ${reason}`,
        },
      });
      console.log(`[Proxy] ${tag} ${req.method} ${req.url} (account: ${rlKey}) — ${reason}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(payload);
    };

    if (decision.action === 'pending') {
      // Abandon the hold if Claude Code hangs up before we decide, so the
      // pendingBlocks map doesn't leak stale entries. Any outcome is fine;
      // `timeout` is the semantically clearest for an upstream abort.
      const onClientClose = (): void => {
        securityScanner.resolvePending(decision.pendingId, 'deny');
      };
      req.on('close', onClientClose);

      const outcome = await securityScanner.awaitPendingResolution(decision.pendingId);
      req.off('close', onClientClose);

      if (outcome !== 'approve') {
        synthesize403(
          decision.blockReason,
          outcome === 'timeout' ? 'BLOCKED (timeout)' : 'BLOCKED (denied)',
        );
        return;
      }
      console.log(
        `[Proxy] APPROVED ${req.method} ${req.url} (account: ${rlKey}) — ${decision.blockReason}`,
      );
      // Fall through to normal upstream forwarding using the already-
      // buffered body.
    }
  }

  // Tool-result compression — opt-in, deterministic. Runs AFTER permissions
  // strip and the cache-TTL rewrite so the compressed body is the final
  // outbound body, and BEFORE the capture snapshot below so the logged
  // request reflects exactly what went upstream. The compressor never touches
  // cache_control, so the marker parse further down sees identical counts.
  // `isMessagesPost` already excludes count_tokens and probes; the size cap
  // and all skip reasons are handled inside compressMessagesBody.
  if (
    compressionStore &&
    isMessagesPost &&
    (settings.compressionEnabled || settings.optimizeCaptureEnabled)
  ) {
    const maxBodyBytes = settings.compressionMaxBodyKb * 1024;
    const originalBody = body; // pre-compression; the dry-run measures on this
    const requestId = cacheTtlCtx?.requestId ?? capture?.requestId ?? null;

    let realizedStats: CompressionStats | null = null;
    let captures: CaptureRecord[] = [];
    let realizedTokensSaved = 0;
    if (settings.compressionEnabled) {
      const r = compressMessagesBody(body, {
        level: settings.compressionLevel,
        maxBodyBytes,
        reversible: settings.compressionRetrievalEnabled,
      });
      if (r.body !== body) {
        body = r.body;
        // Keep Content-Length honest so Node doesn't truncate or stall.
        req.headers['content-length'] = String(body.length);
      }
      realizedStats = r.stats;
      captures = r.captures;
      realizedTokensSaved = r.stats.changed ? r.stats.estTokensIn - r.stats.estTokensOut : 0;
    }

    // Potential: a dry-run at the aggressive tier on the ORIGINAL body. It
    // never mutates what we forward — it only measures what enabling (or
    // raising) compression would save. Gated on the capture toggle; skipped
    // when compression is already on at aggressive (no headroom).
    let potentialTokens = 0;
    if (
      settings.optimizeCaptureEnabled &&
      !(settings.compressionEnabled && settings.compressionLevel === 'aggressive')
    ) {
      const dry = compressMessagesBody(originalBody, { level: 'aggressive', maxBodyBytes });
      const aggTokens = dry.stats.changed ? dry.stats.estTokensIn - dry.stats.estTokensOut : 0;
      potentialTokens = Math.max(0, aggTokens - realizedTokensSaved);
    }

    if (realizedStats) {
      compressionStore.enqueue({
        ts: Date.now(),
        accountId: rlKey,
        sessionId: extractSessionInfo(body)?.sessionId ?? null,
        requestId,
        model: extractRequestModel(body),
        level: settings.compressionLevel,
        bytesIn: realizedStats.bytesIn,
        bytesOut: realizedStats.bytesOut,
        estTokensIn: realizedStats.estTokensIn,
        estTokensOut: realizedStats.estTokensOut,
        changed: realizedStats.changed,
        skipReason: realizedStats.skipReason,
        perTool: realizedStats.perTool,
        perRule: realizedStats.perRule,
        estTokensPotential: potentialTokens,
      });
      // Persist elided originals so the retrieve tool can return them. Only
      // present when reversible mode is on and the compressed body shipped.
      if (captures.length > 0) {
        const ts = Date.now();
        const retrievals: CompressionRetrievalRecord[] = captures.map((c) => ({
          id: c.id,
          ts,
          accountId: rlKey,
          requestId,
          ruleId: c.ruleId,
          original: c.original,
        }));
        compressionStore.enqueueRetrievals(retrievals);
      }
    } else if (potentialTokens > 0) {
      // Compression is off but capture is on: record a measurement-only row
      // (no realized action) so the header can surface what enabling it saves.
      compressionStore.enqueue({
        ts: Date.now(),
        accountId: rlKey,
        sessionId: extractSessionInfo(originalBody)?.sessionId ?? null,
        requestId,
        model: extractRequestModel(originalBody),
        level: settings.compressionLevel,
        bytesIn: 0,
        bytesOut: 0,
        estTokensIn: 0,
        estTokensOut: 0,
        changed: false,
        skipReason: null,
        perTool: {},
        perRule: {},
        estTokensPotential: potentialTokens,
      });
    }
  }

  // MCP definition-cost measurement — pure observer behind the same
  // optimizeCaptureEnabled kill switch as the tool-call extractor. Measures
  // the tools[] array of the FINAL outbound body (post permissions-strip;
  // compression never touches tools[]) so the recorded context-window tax is
  // exactly what shipped upstream. Re-parses the body rather than sharing a
  // parse with compression/cache-TTL/extractor: each consumer parses
  // independently today, and threading one parsed object through all of them
  // is a refactor deliberately deferred.
  if (contextCostStore && isMessagesPost && settings.optimizeCaptureEnabled) {
    try {
      const m = measureToolDefinitions(JSON.parse(body.toString('utf-8')) as unknown);
      if (m.totalToolBytes > 0) {
        contextCostStore.enqueue({
          ts: Date.now(),
          accountId: rlKey,
          perServer: [...m.perServer.entries()].map(([server, s]) => ({
            server,
            defBytes: s.defBytes,
            toolCount: s.toolCount,
            toolNames: s.toolNames,
          })),
          nativeBytes: m.nativeBytes,
          nativeToolCount: m.nativeToolCount,
        });
      }
    } catch {
      // Malformed JSON body — skip measurement; never stall the hot path.
    }
  }

  // Snapshot the post-mutation request body (after any permissions strip) —
  // this is what actually goes upstream, which is what the user wants to see.
  if (capture) {
    capture.requestHeaders = redactHeaders(req.headers, capture.redactAuth);
    capture.requestBodySize = body.length;
    if (body.length <= capture.maxBodyBytes) {
      capture.requestBody = body;
    } else {
      capture.requestBody = body.subarray(0, capture.maxBodyBytes);
      capture.requestBodyTruncated = true;
    }
  }

  // Cache TTL: parse request-side cache_control markers once, and reuse the
  // session extractor that enforcer already has (same metadata.user_id).
  if (cacheTtlCtx) {
    const markers = parseCacheControlMarkers(body);
    cacheTtlCtx.markers5m = markers.markers5m;
    cacheTtlCtx.markers1h = markers.markers1h;
    const sessionInfo = extractSessionInfo(body);
    cacheTtlCtx.sessionId = sessionInfo?.sessionId ?? null;
  }

  const feedCacheTtl = (chunk: Buffer): void => {
    if (cacheTtlCtx) {
      if (cacheTtlCtx.isSse) {
        cacheTtlCtx.sse.onChunk(chunk);
      } else if (cacheTtlCtx.nonSseBytes < 256 * 1024) {
        // Non-SSE responses: buffer up to 256 KB for a final JSON parse.
        // That's plenty of headroom for a top-level usage object on a
        // non-streaming /v1/messages response; anything larger almost
        // certainly IS streaming misclassified by a gzip edge case, and
        // we'll simply skip the insert.
        cacheTtlCtx.nonSseChunks.push(chunk);
        cacheTtlCtx.nonSseBytes += chunk.length;
      }
    }
    // Optimize feature: pure observer. Only feed when this is an SSE
    // response — non-SSE /v1/messages responses don't carry tool_use
    // blocks in the same shape and would just confuse the parser.
    // The extractor's onChunk silently no-ops on non-SSE bytes anyway,
    // but skipping here keeps the hot path tighter.
    if (toolCallCtx && cacheTtlCtx?.isSse) {
      toolCallCtx.extractor.onChunk(chunk);
    }
  };

  const finalizeCacheTtl = (): void => {
    if (!cacheTtlCtx) return;
    let result = cacheTtlCtx.sse.getResult();
    if (!result && cacheTtlCtx.nonSseChunks.length > 0) {
      result = extractUsageFromJson(Buffer.concat(cacheTtlCtx.nonSseChunks));
    }
    if (!result) return;
    const model = result.model ?? 'unknown';
    const costs = computeCacheCosts(
      model,
      result.cacheCreate5m,
      result.cacheCreate1h,
      result.cacheRead,
    );
    try {
      insertCacheTtlEvent(cacheTtlCtx.db, {
        ts: Date.now(),
        accountId: rlKey,
        sessionId: cacheTtlCtx.sessionId,
        model,
        requestId: cacheTtlCtx.requestId,
        reqMarkers5m: cacheTtlCtx.markers5m,
        reqMarkers1h: cacheTtlCtx.markers1h,
        cacheCreate5m: result.cacheCreate5m,
        cacheCreate1h: result.cacheCreate1h,
        cacheRead: result.cacheRead,
        inputTokens: result.inputTokens,
        cost5mWrite: costs.cost5mWrite,
        cost1hWrite: costs.cost1hWrite,
        costRead: costs.costRead,
      });
    } catch (err) {
      /* v8 ignore next 2 */
      console.error('[Proxy] cache_ttl insert failed:', err);
      return;
    }
    // Debounced metrics_updated so rapid sequential requests don't flood IPC.
    // Keyed per account so one noisy account can't mask a quiet one's first
    // refresh.
    if (ipcServer && lastBroadcast) {
      const now = Date.now();
      const key = `metrics:${rlKey}`;
      const last = lastBroadcast.get(key) ?? 0;
      if (now - last >= CACHE_TTL_BROADCAST_DEBOUNCE_MS) {
        lastBroadcast.set(key, now);
        ipcServer.broadcast({ type: 'metrics_updated' });
      }
    }
  };

  const finalizeToolCalls = (): void => {
    if (!toolCallCtx) return;
    try {
      const flushed = toolCallCtx.extractor.flush();
      // Optimize feature: poke the analyzer when this turn captured at
      // least one tool_use. The analyzer's debounce collapses bursts
      // from a chatty session into a single runOnce; the dashboard
      // receives `optimization_metrics_updated` within ~1.5s.
      if (flushed.length > 0 && onToolCallsFlushed) {
        try {
          onToolCallsFlushed();
          /* v8 ignore next 3 */
        } catch (err) {
          console.error('[Optimize] onToolCallsFlushed failed:', err);
        }
      }
    } catch (err) {
      /* v8 ignore next 2 */
      console.error('[Optimize] tool_calls flush failed:', err);
    }
  };

  const finalizeCapture = (): void => {
    finalizeCacheTtl();
    finalizeToolCalls();
    if (!capture || !requestLogStore || capture.finalized) return;
    capture.finalized = true;
    const responseBody =
      capture.captureResponse && capture.responseChunks.length > 0
        ? Buffer.concat(capture.responseChunks)
        : null;
    requestLogStore.enqueue({
      requestId: capture.requestId,
      timestamp: capture.startMs,
      durationMs: capture.responseStatus !== null ? Date.now() - capture.startMs : null,
      method: capture.method,
      urlPath: capture.urlPath,
      statusCode: capture.responseStatus,
      requestHeaders: capture.requestHeaders,
      requestBody: capture.requestBody,
      requestBodyTruncated: capture.requestBodyTruncated,
      requestBodySize: capture.requestBodySize,
      responseHeaders: capture.responseHeaders,
      responseBody,
      responseBodyTruncated: capture.responseBodyTruncated,
      responseBodySize: capture.captureResponse ? capture.responseBodySize : null,
      isSse: capture.isSse,
      errorMessage: capture.errorMessage,
    });
    log.request({
      requestId: capture.requestId,
      method: capture.method,
      path: capture.urlPath,
      status: capture.responseStatus,
      durationMs: capture.responseStatus !== null ? Date.now() - capture.startMs : null,
      errored: capture.errorMessage !== null || capture.responseStatus === null,
    });
  };

  return new Promise((resolve, reject) => {
    const upstream = getProxyUpstream(settings.alternateApiUrl);
    const makeRequest = upstream.protocol === 'http:' ? httpRequest : httpsRequest;

    /** Dispatch one upstream attempt. On a 429 where a retry credential is
     *  available, drains the response and re-dispatches with the new
     *  credential — bounded to one retry per request to cap worst-case
     *  latency. Any other status code flows through the normal response
     *  forwarding path.
     *
     *  `currentRlKey` is the attribution id for this attempt: the initial
     *  attempt uses the caller-supplied rlKey; a retry uses the
     *  replacement account's id so its rate-limit headers land in the
     *  correct bucket. Captures and cache-ttl state are reused (they
     *  represent the caller's logical request, not the per-attempt wire
     *  exchange). */
    const dispatch = (
      attemptHeaders: Record<string, string | string[] | undefined>,
      currentRlKey: string,
      currentAccountId: string,
      retriesLeft: number,
    ): void => {
      const proxyReq = makeRequest(
        {
          hostname: upstream.hostname,
          port: upstream.port,
          path: req.url,
          method: req.method,
          headers: {
            ...attemptHeaders,
            host: upstream.hostname,
          },
        },
        (proxyRes) => {
          console.log(
            `[Proxy] ${req.method} ${req.url} → ${proxyRes.statusCode} (account: ${currentRlKey})`,
          );

          // 401 on an upstream request means the OAuth token was rejected —
          // typically a server-side revocation that the local `expiresAt`
          // check still thinks is valid, so the background token-refresher
          // never fired. Hand off to the daemon's callback which force-
          // refreshes inline; if the refresh itself fails, the refresher
          // broadcasts token_refresh_failed so the Re-authenticate banner
          // lights up within ~1s. We do not retry the current request (too
          // invasive — would require buffering the body), but the next one
          // will use the fresh token.
          if (proxyRes.statusCode === 401 && onUpstreamAuthFailure) {
            onUpstreamAuthFailure(currentRlKey);
          }

          // Inspect overage + rate-limit headers
          const headers: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            headers[k] = v;
          }
          machine.handleHeaders(accountId, headers);

          // Store rate limits FIRST (before the retry decision) so the
          // rotator/spend-tracker see the blocked state the 429 implies.
          // Otherwise a retry would pick the same account again.
          if (rateLimitStore) {
            const summary = summarizeOverageHeaders(headers);
            if (summary !== null) {
              console.log(`[Proxy] RL for ${currentRlKey}: ${summary}`);
            }
            rateLimitStore.update(currentRlKey, headers);
            const stored = rateLimitStore.getAll(currentRlKey);
            console.log(`[Proxy] RL store now has ${stored.length} window(s) for ${currentRlKey}`);
            // Broadcast to the app so UsageView can refresh immediately.
            // Debounce to avoid flooding on rapid sequential requests.
            if (ipcServer && lastBroadcast && stored.length > 0) {
              const now = Date.now();
              const last = lastBroadcast.get(currentRlKey) ?? 0;
              if (now - last >= RL_BROADCAST_DEBOUNCE_MS) {
                lastBroadcast.set(currentRlKey, now);
                ipcServer.broadcast({ type: 'rate_limits_updated', accountId: currentRlKey });
                console.log(`[Proxy] Broadcast rate_limits_updated for ${currentRlKey}`);
              }
            }
          }

          // 429 retry path: drain the upstream response and re-dispatch
          // with a different account's credentials when one is available.
          // The rate-limit store was just updated above so the rotator
          // won't re-pick the account we just hit. If the provider returns
          // the same account (pool of one, or all others paused), fall
          // through to the normal forwarding path so the client sees 429.
          if (proxyRes.statusCode === 429 && retriesLeft > 0 && retryCredentialProvider) {
            const next = retryCredentialProvider(currentAccountId);
            if (next && next.accountId !== currentAccountId) {
              console.log(`[Proxy] 429 on ${currentRlKey} → retrying with ${next.accountId}`);
              proxyRes.resume();
              proxyRes.on('end', () => {
                const nextHeaders = {
                  ...attemptHeaders,
                  authorization: `Bearer ${next.token}`,
                };
                dispatch(nextHeaders, next.accountId, next.accountId, retriesLeft - 1);
              });
              // Mid-drain error on the 429 response. Triggering this via
              // real HTTP requires the upstream to RST the socket after
              // sending a 429 with headers but before the end — very tight
              // window. Not worth a brittle test; cleanup path is identical
              // in shape to the already-covered primary response error.
              /* v8 ignore start */
              proxyRes.on('error', (err) => {
                if (capture) capture.errorMessage = err.message;
                finalizeCapture();
                reject(err);
              });
              /* v8 ignore stop */
              return;
            }
          }

          // Final response for this request — commit capture + forward.
          if (capture) {
            capture.responseStatus = proxyRes.statusCode ?? null;
            capture.responseHeaders = redactHeaders(proxyRes.headers, capture.redactAuth);
            const encodingHeader = proxyRes.headers['content-encoding'];
            capture.isSse =
              !encodingHeader &&
              req.method === 'POST' &&
              (req.url?.startsWith('/v1/messages') ?? false);
          }
          if (cacheTtlCtx) {
            const ct = String(proxyRes.headers['content-type'] ?? '');
            cacheTtlCtx.isSse = ct.includes('text/event-stream');
          }

          // Record requestId → account so OtelReceiver can re-bucket OTEL
          // api_request / api_error events that carry the same id. Anthropic
          // emits `request-id` on every /v1/messages response; only skip the
          // write when the header is absent (probes, early errors). Attribute
          // to the account that produced the forwarded response, not any
          // earlier attempt that was retried away from.
          if (requestAccountMap) {
            const reqIdRaw = proxyRes.headers['request-id'];
            const reqId = Array.isArray(reqIdRaw) ? reqIdRaw[0] : reqIdRaw;
            if (typeof reqId === 'string' && reqId) {
              requestAccountMap.set(reqId, currentRlKey);
            }
          }

          forwardResponse(proxyRes, currentRlKey);
        },
      );

      proxyReq.on('error', (err) => {
        if (capture) capture.errorMessage = err.message;
        finalizeCapture();
        reject(err);
      });

      // Bound a hung upstream socket. setTimeout(ms) installs a Node
      // inactivity timer that auto-resets on every read/write — a healthy
      // SSE stream that keeps emitting chunks is never affected, but a
      // socket that has gone quiet (either pre-headers or mid-stream) fires
      // here after `ms`. Destroying the request emits 'error' on
      // proxyReq, which the handler above already captures + rejects. We
      // prefer this to relying on the kernel's TCP retransmit timeout,
      // which on macOS can take ~50s to surface as a `read ETIMEDOUT` and
      // produces a less actionable error message.
      proxyReq.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
        proxyReq.destroy(
          new Error(`upstream idle timeout: no data for ${UPSTREAM_IDLE_TIMEOUT_MS / 1000}s`),
        );
      });

      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    };

    /** Stream the chosen upstream response back to the client. Shared
     *  between the first-attempt and retry-attempt paths — the attempt
     *  that actually reaches here is the one whose status code will be
     *  seen by Claude Code. */
    const forwardResponse = (proxyRes: IncomingMessage, currentRlKey: string): void => {
      // Forward response to Claude Code. When a security tap is active,
      // we hand chunks to the client synchronously and also feed a
      // non-blocking copy to the scanner. A slow tap can NEVER delay the
      // client because we don't let its backpressure reach proxyRes.
      /* v8 ignore next 1 */
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      const tap = securityScanner?.startResponseTap(currentRlKey, req.url) ?? null;
      const encoding = proxyRes.headers['content-encoding'];
      const tapActive = tap !== null && !encoding;
      if (tap !== null && encoding) {
        // Gzipped responses aren't scanned in v1 — keep parity honest.
        tap.destroy();
      }
      // Permission interceptor — rewrites denied tool_use blocks in place.
      // Only installed for SSE /v1/messages responses; gzip is ruled out
      // at the request layer (accept-encoding was stripped).
      const isSse = !encoding && req.url?.startsWith('/v1/messages') && req.method === 'POST';
      const interceptor = isSse
        ? (permissionsEnforcer?.createInterceptor(res, currentRlKey, req.headers, body) ?? null)
        : null;

      const captureChunk = (chunk: Buffer): void => {
        if (!capture || !capture.captureResponse) return;
        capture.responseBodySize += chunk.length;
        if (capture.responseBodyTruncated) return;
        const remaining = capture.maxBodyBytes - capture.responseStoredBytes;
        if (remaining <= 0) {
          capture.responseBodyTruncated = true;
          return;
        }
        if (chunk.length <= remaining) {
          capture.responseChunks.push(chunk);
          capture.responseStoredBytes += chunk.length;
        } else {
          capture.responseChunks.push(chunk.subarray(0, remaining));
          capture.responseStoredBytes += remaining;
          capture.responseBodyTruncated = true;
        }
      };

      if (interceptor !== null) {
        proxyRes.on('data', (chunk: Buffer) => {
          interceptor.push(chunk);
          if (tapActive && tap !== null) tap.push(chunk);
          captureChunk(chunk);
          feedCacheTtl(chunk);
        });
        proxyRes.on('end', () => {
          // Await every in-flight hold before flush + res.end. Without
          // this wait, a fast upstream stream that completes before
          // the user can decide would cause the interceptor's flush()
          // to fail-open (let the original tool_use through). The
          // user-stated contract is that every block offers an
          // approval window — honoring that requires holding the
          // response open until the decision settles.
          void interceptor
            .awaitSettlement()
            .catch(() => undefined)
            .then(() => {
              interceptor.flush();
              res.end();
              if (tapActive && tap !== null) tap.flush();
              finalizeCapture();
              resolve();
            });
        });
        // Mid-stream upstream error in the permissions-interceptor path.
        // The no-tap variant of this cleanup-and-reject pattern IS
        // integration-tested (proxy-capture.test.ts line ~507 —
        // "captures errorMessage on proxyRes 'error' when no tap /
        // interceptor is installed"). Reproducing this exact combination
        // through a real HTTP round-trip requires server-side RST
        // mid-chunk — Node's http layer on the client absorbs that as
        // 'aborted' rather than 'error' on most platforms, so ignoring
        // here is strictly safer than a brittle flake.
        /* v8 ignore start */
        proxyRes.on('error', (err) => {
          interceptor.destroy();
          if (tap !== null) tap.destroy();
          if (capture) capture.errorMessage = err.message;
          finalizeCapture();
          reject(err);
        });
        /* v8 ignore stop */
      } else if (tapActive && tap !== null) {
        proxyRes.on('data', (chunk: Buffer) => {
          res.write(chunk);
          tap.push(chunk);
          captureChunk(chunk);
          feedCacheTtl(chunk);
        });
        proxyRes.on('end', () => {
          res.end();
          tap.flush();
          finalizeCapture();
          resolve();
        });
        // Same rationale as the interceptor branch above — a near-
        // duplicate of the no-tap error handler that's integration-tested
        // in proxy-capture.test.ts.
        /* v8 ignore start */
        proxyRes.on('error', (err) => {
          tap.destroy();
          if (capture) capture.errorMessage = err.message;
          finalizeCapture();
          reject(err);
        });
        /* v8 ignore stop */
      } else {
        proxyRes.on('data', (chunk: Buffer) => {
          captureChunk(chunk);
          feedCacheTtl(chunk);
        });
        proxyRes.pipe(res);
        proxyRes.on('end', () => {
          finalizeCapture();
          resolve();
        });
        proxyRes.on('error', (err) => {
          if (capture) capture.errorMessage = err.message;
          finalizeCapture();
          reject(err);
        });
      }
    };

    // Kick off the first attempt. `rlKey` is already set above from the
    // per-request `attributionAccountId`. Retry budget = 1 by policy so
    // worst-case wall time is bounded to ~2x a single upstream round-trip.
    dispatch(
      { ...req.headers },
      rlKey,
      attributionAccountId ?? rlKey,
      retryCredentialProvider ? 1 : 0,
    );
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Attempt to derive an account identifier from the Authorization header.
 * Falls back to null if not parseable.
 */
function extractAccountFromAuth(auth: string | undefined): string | null {
  /* v8 ignore next 4 */
  if (!auth) return null;
  // In practice, the account UUID comes from API response headers or OTEL.
  // This is just a fallback identifier.
  return null;
}

/**
 * Parse the `model` field from an Anthropic `/v1/messages` request body.
 * The Anthropic SDK always places `model` at the JSON root for both
 * streaming and non-streaming requests, so a single `JSON.parse` suffices.
 *
 * Returns null on malformed JSON, an empty body, or a missing/non-string
 * `model`. Callers must treat null as "unknown model" and skip any
 * model-aware gating — never as "route as Sonnet by default."
 */
export function extractRequestModel(body: Buffer): string | null {
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
    return typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : null;
  } catch {
    return null;
  }
}

/**
 * True when the model identifier names a Sonnet variant. Case-insensitive
 * substring match rather than a prefix list so the check keeps working
 * across Anthropic release cadence (`claude-3-5-sonnet-*`,
 * `claude-sonnet-4-*`, future Sonnet releases). Null/empty input returns
 * false — unknown model never routes through the Sonnet gate.
 */
export function isSonnetModel(model: string | null): boolean {
  return model != null && model.toLowerCase().includes('sonnet');
}
