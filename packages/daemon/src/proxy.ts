import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import type { Server } from 'http';
import type { Database } from 'better-sqlite3';
import { OverageStateMachine } from './overage.js';
import { insertOverageEvent, insertNotification } from './db.js';
import type { IpcServer } from './ipc.js';
import type { RateLimitStore } from './rate-limit-store.js';

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

    // Persist overage event
    insertOverageEvent(opts.db, {
      ts: now,
      accountId,
      transition,
      status: state.status,
      resetsAt: state.resetsAt,
      disabledReason: state.disabledReason,
    });

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
  const { ipcServer } = opts;

  // Tracks the last broadcast time per account to debounce rapid-fire requests
  const lastBroadcast = new Map<string, number>();

  /**
   * Resolve the (token, accountId) pair for an outgoing request. When a
   * tokenProvider is configured (round-robin mode) it wins; otherwise we fall
   * back to the shared activeToken/activeAccountId refs.
   */
  const selectCredential = (): TokenSelection | null => {
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

    const credential = selectCredential();
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
    if (ANTHROPIC_PATHS.some((p) => url.startsWith(p))) {
      proxyToAnthropic(req, res, machine, rateLimitStore, perRequestAccountId, ipcServer, lastBroadcast).catch((err) => {
        console.error('[Proxy] Proxy error:', err);
        res.writeHead(502);
        res.end();
      });
      return;
    }

    // Default: proxy all other paths to Anthropic (future-proof)
    proxyToAnthropic(req, res, machine, rateLimitStore, perRequestAccountId, ipcServer, lastBroadcast).catch((err) => {
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
): Promise<void> {
  const body = await readBody(req);

  // Extract account UUID from request headers for overage tracking
  const accountId =
    (req.headers['x-account-uuid'] as string | undefined) ??
    extractAccountFromAuth(req.headers['authorization'] as string | undefined) ??
    'default';

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
        const rlKey = attributionAccountId ?? accountId;
        console.log(`[Proxy] ${req.method} ${req.url} → ${proxyRes.statusCode} (account: ${rlKey})`);

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

        // Forward response to Claude Code unmodified
        /* v8 ignore next 1 */
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on('end', resolve);
        proxyRes.on('error', reject);
      },
    );

    proxyReq.on('error', reject);

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
