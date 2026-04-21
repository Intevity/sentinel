import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import type { Server } from 'http';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { OverageStateMachine } from './overage.js';
import { insertOverageEvent, insertNotification } from './db.js';
import type { IpcServer } from './ipc.js';
import type { RateLimitStore } from './rate-limit-store.js';
import type { SecurityScanner } from './security/scanner.js';
import type { PermissionsEnforcer } from './security/permissions/enforcer.js';
import { extractSessionInfo } from './security/permissions/enforcer.js';
import { loadSettings } from './settings.js';
import { redactHeaders, type RequestLogStore } from './request-log-db.js';
import { log } from './logger.js';

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
   *  activeToken/activeAccountId refs. */
  tokenProvider?: () => TokenSelection | null;
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
    ['5h-status',      pick('anthropic-ratelimit-unified-5h-status')],
    ['5h-util',        pick('anthropic-ratelimit-unified-5h-utilization')],
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
      const resetDate = state.resetsAt ? new Date(state.resetsAt * 1000).toLocaleDateString() : 'unknown';
      title = `⚠️ Overage started — ${accountId}`;
      body = `Claude Code is now using your overage budget. Resets ${resetDate}.`;
    } else if (transition === 'disabled') {
      /* v8 ignore next 2 */
      const reason = state.disabledReason ?? 'budget exhausted';
      const resetDate = state.resetsAt ? new Date(state.resetsAt * 1000).toLocaleDateString() : 'unknown';
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

  // Tracks the last broadcast time per account to debounce rapid-fire requests
  const lastBroadcast = new Map<string, number>();

  /**
   * Resolve the (token, accountId) pair for an outgoing request. Precedence:
   *   1. Per-request override via `x-sentinel-probe-token` + `x-sentinel-probe-account`
   *      — used by the background usage-probe to probe a non-active account
   *      without mutating the active-token refs. Headers are stripped before
   *      upstream forwarding so they never leak to Anthropic.
   *   2. `tokenProvider` (round-robin mode).
   *   3. Shared `activeToken` / `activeAccountId` refs (default flow).
   */
  const selectCredential = (req: IncomingMessage): TokenSelection | null => {
    const probeToken = req.headers['x-sentinel-probe-token'];
    const probeAccount = req.headers['x-sentinel-probe-account'];
    if (typeof probeToken === 'string' && typeof probeAccount === 'string' && probeToken && probeAccount) {
      delete req.headers['x-sentinel-probe-token'];
      delete req.headers['x-sentinel-probe-account'];
      return { token: probeToken, accountId: probeAccount };
    }
    const fromProvider = tokenProvider?.();
    if (fromProvider) return fromProvider;
    if (activeToken.value) {
      return { token: activeToken.value, accountId: activeAccountId?.value ?? 'default' };
    }
    return null;
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

    const credential = selectCredential(req);
    if (credential) {
      req.headers['authorization'] = `Bearer ${credential.token}`;
    }

    if (OTEL_PATHS.some((p) => url.startsWith(p)) && req.method === 'POST') {
      otelHandler(req, res).catch((err) => {
        console.error('[Proxy] OTEL handler error:', err);
        res.writeHead(500);
        res.end();
      });
      return;
    }

    // Proxy Anthropic API calls — attribute rate-limit headers to the
    // specific account whose token was used for this request (matters for
    // round-robin where that may differ from the primary active account).
    const perRequestAccountId = credential?.accountId ?? activeAccountId?.value;

    // Sentinel-side pause short-circuit. The rotator already skips paused
    // accounts in round-robin, so this only matters when the credential came
    // from the active-token fallback (typical `off` mode) or the per-request
    // probe headers landed on a paused account. Respond 503 with Retry-After
    // pointing at the 5h rollover so Claude Code backs off until Sentinel
    // re-evaluates.
    if (perRequestAccountId && getPausedAccountIds().has(perRequestAccountId)) {
      const resetSec = getSessionResetAt(perRequestAccountId);
      // Retry-After accepts delta-seconds; fall back to 5 minutes when the
      // reset is missing (unlikely in practice — rate-limit headers arrive
      // on the first response for a new account).
      const retryAfter =
        resetSec != null
          ? Math.max(1, resetSec - Math.floor(Date.now() / 1000))
          : 300;
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      });
      res.end(JSON.stringify({
        error: {
          type: 'sentinel_budget_paused',
          message:
            'Sentinel has paused this account because its weekly budget was reached. ' +
            'It will resume automatically when the 5-hour window resets. ' +
            'Switch accounts or raise the Sentinel budget in Settings to unblock sooner.',
        },
      }));
      return;
    }

    if (ANTHROPIC_PATHS.some((p) => url.startsWith(p))) {
      proxyToAnthropic(req, res, machine, rateLimitStore, perRequestAccountId, ipcServer, lastBroadcast, securityScanner, permissionsEnforcer, requestLogStore).catch((err) => {
        console.error('[Proxy] Proxy error:', err);
        res.writeHead(502);
        res.end();
      });
      return;
    }

    // Default: proxy all other paths to Anthropic (future-proof)
    proxyToAnthropic(req, res, machine, rateLimitStore, perRequestAccountId, ipcServer, lastBroadcast, undefined, undefined, requestLogStore).catch((err) => {
      console.error('[Proxy] Default proxy error:', err);
      res.writeHead(502);
      res.end();
    });
  });

  return server;
}

/**
 * Forward a request to api.anthropic.com and inspect the response headers.
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
): Promise<void> {
  let body = await readBody(req);

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

  // Security scan — runs against the outbound JSON before we forward. In
  // block-mode, a finding at or above the severity floor triggers one of:
  //  - `pending`: the request is held open up to `securityApproveHoldSec`
  //    while the user decides whether to approve. On approve, the held
  //    body is forwarded upstream as if nothing happened. On deny or
  //    timeout, a 403 is synthesized.
  //  - `block_immediate`: 403 fires without any hold (user disabled the
  //    hold feature).
  if (
    securityScanner &&
    req.method === 'POST' &&
    req.url?.startsWith('/v1/messages')
  ) {
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
        synthesize403(decision.blockReason, outcome === 'timeout' ? 'BLOCKED (timeout)' : 'BLOCKED (denied)');
        return;
      }
      console.log(`[Proxy] APPROVED ${req.method} ${req.url} (account: ${rlKey}) — ${decision.blockReason}`);
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

  const finalizeCapture = (): void => {
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
        console.log(`[Proxy] ${req.method} ${req.url} → ${proxyRes.statusCode} (account: ${rlKey})`);

        if (capture) {
          capture.responseStatus = proxyRes.statusCode ?? null;
          capture.responseHeaders = redactHeaders(proxyRes.headers, capture.redactAuth);
          const encodingHeader = proxyRes.headers['content-encoding'];
          capture.isSse =
            !encodingHeader &&
            req.method === 'POST' &&
            (req.url?.startsWith('/v1/messages') ?? false);
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
          ? permissionsEnforcer?.createInterceptor(res, rlKey, req.headers) ?? null
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
          proxyRes.on('data', captureChunk);
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
