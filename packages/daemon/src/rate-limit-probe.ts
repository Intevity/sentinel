import { request as httpRequest } from 'http';
import { getDaemonPort } from './proxy.js';
import type { IpcServer } from './ipc.js';
import { isOAuthForbiddenBodyString } from './claude-ai-usage.js';

/**
 * Probe POST /v1/messages through the local proxy to obtain fresh
 * rate-limit headers for an account.
 *
 * Routing through the proxy (rather than calling api.anthropic.com directly)
 * lets the proxy inject the OAuth Bearer token and handle auth — direct calls
 * with OAuth tokens are rejected by Anthropic with "OAuth authentication is
 * currently not supported". The proxy also writes the parsed headers into the
 * RateLimitStore and broadcasts rate_limits_updated to connected clients.
 *
 * When `token` is omitted the proxy uses its active-token fallback (original
 * behavior — used by startup + switch paths). When `token` is supplied it is
 * forwarded via `x-sentinel-probe-token` / `x-sentinel-probe-account`
 * internal headers so the proxy routes THIS request under the given account
 * without mutating activeToken — used by the background usage-probe.
 *
 * Must be called AFTER the proxy server is listening.
 */
export function probeRateLimits(accountId: string, ipcServer?: IpcServer, token?: string): void {
  // Send a minimal inference request (max_tokens: 1) to obtain rate-limit headers.
  // count_tokens rejects OAuth tokens; /v1/messages accepts them as long as the
  // request includes the oauth-2025-04-20 beta flag and matches the shape
  // Claude Code itself sends. Without the beta header the endpoint 401s an
  // OAuth (claudeAiOauth) token even when it's valid. Cost: ~1 output token.
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });

  // Tell the UI a probe is in flight for this account so it can show a
  // loading indicator. Successful completion triggers rate_limits_updated
  // from the proxy; failures fall through to rate_limits_probe_ended below.
  ipcServer?.broadcast({ type: 'rate_limits_probing', accountId });

  const baseHeaders: Record<string, string | number> = {
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': 'claude-cli/sentinel-probe',
    accept: 'application/json',
    // Deliberately no accept-encoding — keeps failure bodies readable
    // in daemon.log instead of printing gzip binary.
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  };
  if (token) {
    baseHeaders['x-sentinel-probe-token'] = token;
    baseHeaders['x-sentinel-probe-account'] = accountId;
  }

  const req = httpRequest(
    {
      hostname: '127.0.0.1',
      port: getDaemonPort(),
      // `?beta=true` mirrors Claude Code's production request. The path-prefix
      // match in the proxy (ANTHROPIC_PATHS.some(p => url.startsWith(p)))
      // tolerates it.
      path: '/v1/messages?beta=true',
      method: 'POST',
      headers: baseHeaders,
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[RateLimit] Probe succeeded (HTTP ${res.statusCode}) for ${accountId}`);
          // Non-2xx responses don't emit rate_limits_updated from the proxy,
          // so we signal probe-end here for the UI. Successful probes are
          // already covered by the proxy's rate_limits_updated broadcast.
        } else {
          const fullBody = Buffer.concat(chunks).toString('utf-8');
          const bodyStr = fullBody.slice(0, 300);
          console.warn(`[RateLimit] Probe HTTP ${res.statusCode} for ${accountId}: ${bodyStr}`);
          // Surface the org-level OAuth-disabled 403 as a distinct broadcast
          // so the UI renders "OAuth access disabled" instead of the generic
          // "Sign-in expired" state. `rate_limits_probe_ended` still fires so
          // existing loading-indicator listeners keep working.
          if (res.statusCode === 403) {
            const verdict = isOAuthForbiddenBodyString(fullBody);
            if (verdict.forbidden) {
              console.warn(`[RateLimit] OAuth-disabled org for ${accountId}: ${verdict.message}`);
              ipcServer?.broadcast({
                type: 'rate_limits_oauth_forbidden',
                accountId,
                message: verdict.message,
              });
            }
          }
          ipcServer?.broadcast({ type: 'rate_limits_probe_ended', accountId });
        }
      });
    },
  );
  req.on('error', (err: Error) => {
    console.warn('[RateLimit] Probe error:', err.message);
    ipcServer?.broadcast({ type: 'rate_limits_probe_ended', accountId });
  });
  req.write(body);
  req.end();
}
