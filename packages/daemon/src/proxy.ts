import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import type { Server } from 'http';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { OverageStateMachine } from './overage.js';
import { insertOverageEvent, insertNotification, insertCacheTtlEvent } from './db.js';
import type { IpcServer } from './ipc.js';
import type { RateLimitStore } from './rate-limit-store.js';
import type { SecurityScanner } from './security/scanner.js';
import type { PermissionsEnforcer } from './security/permissions/enforcer.js';
import { extractSessionInfo } from './security/permissions/enforcer.js';
import { loadSettings } from './settings.js';
import { redactHeaders, type RequestLogStore } from './request-log-db.js';
import { log } from './logger.js';
import {
  parseCacheControlMarkers,
  extractUsageFromJson,
  SseUsageExtractor,
} from './cache-ttl/parser.js';
import { computeCacheCosts } from './cache-ttl/pricing.js';
import { rewriteCacheControlTtl } from './cache-ttl/rewriter.js';

export const DAEMON_PORT = 47284;
export const ANTHROPIC_HOST = 'api.anthropic.com';

// Paths that should be proxied to Anthropic
const ANTHROPIC_PATHS = ['/v1/messages', '/v1/complete', '/v1/models', '/v1/count_tokens'];

// OTEL paths handled locally
const OTEL_PATHS = ['/v1/metrics', '/v1/logs'];

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
   *  proxy short-circuits the request with 503 + Retry-After pointing at
   *  the 5h rollover. Needed for `off` mode where the rotator's pause gate
   *  is bypassed. Ignored in round-robin (the rotator already skips paused
   *  accounts so no short-circuit is needed there). */
  getPausedAccountIds?: () => ReadonlySet<string>;
  /** Live accessor for the 5h reset timestamp (Unix seconds) per account.
   *  Used to populate the Retry-After header on the 503 short-circuit.
   *  Returning null means "no reset info available"; the proxy picks a
   *  conservative default. */
  getSessionResetAt?: (accountId: string) => number | null;
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
}

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
  const { ipcServer, securityScanner, permissionsEnforcer, requestLogStore } = opts;
  const getPausedAccountIds = opts.getPausedAccountIds ?? (() => new Set<string>());
  const getSessionResetAt = opts.getSessionResetAt ?? (() => null);
  const getOverageAllowedIds = opts.getOverageAllowedIds ?? (() => new Set<string>());
  const getOverageBufferPct = opts.getOverageBufferPct ?? (() => 5);

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
  const handleMessagesPost = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
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
    // a probe header landed on a paused account. Retry-After points at
    // the 5h rollover so Claude Code backs off until Sentinel re-evaluates.
    if (perRequestAccountId && getPausedAccountIds().has(perRequestAccountId)) {
      respond503(
        res,
        getSessionResetAt(perRequestAccountId),
        'sentinel_budget_paused',
        'Sentinel has paused this account because its weekly budget was reached. ' +
          'It will resume automatically when the 5-hour window resets. ' +
          'Switch accounts or raise the Sentinel budget in Settings to unblock sooner.',
      );
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
    );
  };

  const server = createServer((req, res) => {
    /* v8 ignore next 1 */
    const url = req.url ?? '/';

    // Health check
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
      return;
    }

    if (OTEL_PATHS.some((p) => url.startsWith(p)) && req.method === 'POST') {
      otelHandler(req, res).catch((err) => {
        console.error('[Proxy] OTEL handler error:', err);
        res.writeHead(500);
        res.end();
      });
      return;
    }

    // `/v1/messages*` POSTs need the body buffered BEFORE credential
    // selection so the rotator can see the model. Every other path (GETs,
    // non-messages endpoints, probes with overrides) uses the sync fast
    // path — they don't depend on model identity for routing.
    if (req.method === 'POST' && url.startsWith('/v1/messages')) {
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
      respond503(
        res,
        getSessionResetAt(perRequestAccountId),
        'sentinel_budget_paused',
        'Sentinel has paused this account because its weekly budget was reached. ' +
          'It will resume automatically when the 5-hour window resets. ' +
          'Switch accounts or raise the Sentinel budget in Settings to unblock sooner.',
      );
      return;
    }

    if (ANTHROPIC_PATHS.some((p) => url.startsWith(p))) {
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

  // Auto-mode observation — always runs so the UI's "Claude Code is in auto
  // mode" indicator stays live even when Sentinel's own rule enforcement is
  // turned off. Scoped to /v1/messages POST (actual conversation requests),
  // not count_tokens or probes.
  //
  // We extract the session identifier from `metadata.user_id` in the body so
  // the enforcer can track one entry per Claude Code session — critical when
  // the user runs multiple sessions in parallel (e.g. 1 auto + 4 normal).
  if (
    permissionsEnforcer &&
    req.method === 'POST' &&
    req.url?.startsWith('/v1/messages') &&
    !req.url.includes('count_tokens') &&
    !String(req.headers['user-agent'] ?? '').includes('sentinel-probe')
  ) {
    const sessionInfo = extractSessionInfo(body);
    permissionsEnforcer.observeRequest(req.headers, sessionInfo);
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
      if (!existingBeta.split(',').map((s) => s.trim()).includes(betaToken)) {
        req.headers['anthropic-beta'] = `${existingBeta}, ${betaToken}`;
      }
    } else if (Array.isArray(existingBeta)) {
      req.headers['anthropic-beta'] = [...existingBeta, betaToken];
    } else {
      req.headers['anthropic-beta'] = betaToken;
    }
  }

  // Security scan — runs against the outbound JSON before we forward. In
  // block-mode, a finding at or above the severity floor triggers one of:
  //  - `pending`: the request is held open up to `securityApproveHoldSec`
  //    while the user decides whether to approve. On approve, the held
  //    body is forwarded upstream as if nothing happened. On deny or
  //    timeout, a 403 is synthesized.
  //  - `block_immediate`: 403 fires without any hold (user disabled the
  //    hold feature).
  if (securityScanner && req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
    const decision = securityScanner.scanOutbound(body, rlKey);

    const synthesize403 = (reason: string, tag: string): void => {
      const payload = JSON.stringify({
        type: 'error',
        error: {
          type: 'permission_denied',
          message: `Blocked by Claude Sentinel: ${reason}`,
        },
      });
      console.log(`[Proxy] ${tag} ${req.method} ${req.url} (account: ${rlKey}) — ${reason}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(payload);
    };

    if (decision.action === 'block_immediate') {
      synthesize403(decision.blockReason, 'BLOCKED');
      return;
    }

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
    if (!cacheTtlCtx) return;
    if (cacheTtlCtx.isSse) {
      cacheTtlCtx.sse.onChunk(chunk);
      return;
    }
    // Non-SSE responses: buffer up to 256 KB for a final JSON parse. That's
    // plenty of headroom for a top-level usage object on a non-streaming
    // /v1/messages response; anything larger almost certainly IS streaming
    // misclassified by a gzip edge case, and we'll simply skip the insert.
    if (cacheTtlCtx.nonSseBytes >= 256 * 1024) return;
    cacheTtlCtx.nonSseChunks.push(chunk);
    cacheTtlCtx.nonSseBytes += chunk.length;
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

  const finalizeCapture = (): void => {
    finalizeCacheTtl();
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
    const proxyReq = httpsRequest(
      {
        hostname: ANTHROPIC_HOST,
        port: 443,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: ANTHROPIC_HOST,
        },
      },
      (proxyRes) => {
        console.log(
          `[Proxy] ${req.method} ${req.url} → ${proxyRes.statusCode} (account: ${rlKey})`,
        );

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

        // Inspect overage + rate-limit headers
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          headers[k] = v;
        }
        machine.handleHeaders(accountId, headers);
        // Store rate limits under the active account's sentinel key so
        // get_rate_limits can find them by the same key.
        if (rateLimitStore) {
          const summary = summarizeOverageHeaders(headers);
          if (summary !== null) {
            console.log(`[Proxy] RL for ${rlKey}: ${summary}`);
          }
          rateLimitStore.update(rlKey, headers);
          const stored = rateLimitStore.getAll(rlKey);
          console.log(`[Proxy] RL store now has ${stored.length} window(s) for ${rlKey}`);
          // Broadcast to the app so UsageView can refresh immediately.
          // Debounce to avoid flooding on rapid sequential requests.
          if (ipcServer && lastBroadcast && stored.length > 0) {
            const now = Date.now();
            const last = lastBroadcast.get(rlKey) ?? 0;
            if (now - last >= RL_BROADCAST_DEBOUNCE_MS) {
              lastBroadcast.set(rlKey, now);
              ipcServer.broadcast({ type: 'rate_limits_updated', accountId: rlKey });
              console.log(`[Proxy] Broadcast rate_limits_updated for ${rlKey}`);
            }
          }
        }

        // Forward response to Claude Code. When a security tap is active,
        // we hand chunks to the client synchronously and also feed a
        // non-blocking copy to the scanner. A slow tap can NEVER delay the
        // client because we don't let its backpressure reach proxyRes.
        /* v8 ignore next 1 */
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        const tap = securityScanner?.startResponseTap(rlKey, req.url) ?? null;
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
          ? (permissionsEnforcer?.createInterceptor(res, rlKey, req.headers) ?? null)
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
            interceptor.flush();
            res.end();
            if (tapActive && tap !== null) tap.flush();
            finalizeCapture();
            resolve();
          });
          proxyRes.on('error', (err) => {
            interceptor.destroy();
            if (tap !== null) tap.destroy();
            if (capture) capture.errorMessage = err.message;
            finalizeCapture();
            reject(err);
          });
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
          proxyRes.on('error', (err) => {
            tap.destroy();
            if (capture) capture.errorMessage = err.message;
            finalizeCapture();
            reject(err);
          });
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
      },
    );

    proxyReq.on('error', (err) => {
      if (capture) capture.errorMessage = err.message;
      finalizeCapture();
      reject(err);
    });

    if (body.length > 0) {
      proxyReq.write(body);
    }
    proxyReq.end();
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
