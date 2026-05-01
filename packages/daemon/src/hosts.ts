/**
 * Endpoint configuration. Production defaults are baked in; tests override
 * via env vars so a fake Anthropic server can take their place without
 * patching fetch/https at the call site.
 *
 * Envs:
 *   ANTHROPIC_UPSTREAM_URL  e.g. http://127.0.0.1:12345  (default https://api.anthropic.com)
 *   OAUTH_TOKEN_URL         e.g. http://127.0.0.1:12345/v1/oauth/token  (default platform.claude.com)
 *   OAUTH_AUTH_URL          e.g. http://127.0.0.1:12345/cai/oauth/authorize  (default claude.com)
 *
 * Production reads are unaffected when these env vars are unset.
 */

export interface AnthropicUpstream {
  hostname: string;
  port: number;
  protocol: 'https:' | 'http:';
  origin: string;
}

const DEFAULT_ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
const DEFAULT_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_AUTH_URL = 'https://claude.com/cai/oauth/authorize';

export function getAnthropicUpstream(): AnthropicUpstream {
  const origin = process.env.ANTHROPIC_UPSTREAM_URL ?? DEFAULT_ANTHROPIC_ORIGIN;
  const u = new URL(origin);
  const protocol: 'https:' | 'http:' = u.protocol === 'http:' ? 'http:' : 'https:';
  const port = u.port ? Number(u.port) : protocol === 'https:' ? 443 : 80;
  return { hostname: u.hostname, port, protocol, origin: u.origin };
}

export function getAnthropicOrigin(): string {
  return getAnthropicUpstream().origin;
}

/**
 * Upstream for the Claude Code proxy. Prefers the user-configured
 * `alternateApiUrl` setting (e.g. a model router like Herma) when set;
 * otherwise falls back to `getAnthropicUpstream()` (which itself respects
 * `ANTHROPIC_UPSTREAM_URL` for tests).
 *
 * Used ONLY by the request-forwarding path in `proxy.ts`. Daemon-originated
 * calls (OAuth profile, /api/oauth/usage, /v1/code/routines/run-budget) keep
 * using `getAnthropicOrigin()` and remain on the canonical Anthropic API.
 *
 * Invalid input (non-http(s) protocol, malformed URL) silently falls back to
 * the canonical upstream — the settings coercer is the validation gate; this
 * function is the runtime safety net.
 */
export function getProxyUpstream(alternateApiUrl: string | null): AnthropicUpstream {
  if (alternateApiUrl) {
    try {
      const u = new URL(alternateApiUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const protocol: 'https:' | 'http:' = u.protocol === 'http:' ? 'http:' : 'https:';
        const port = u.port ? Number(u.port) : protocol === 'https:' ? 443 : 80;
        return { hostname: u.hostname, port, protocol, origin: u.origin };
      }
    } catch {
      // fall through to canonical
    }
  }
  return getAnthropicUpstream();
}

export function getOAuthTokenUrl(): string {
  return process.env.OAUTH_TOKEN_URL ?? DEFAULT_TOKEN_URL;
}

export function getOAuthAuthUrl(): string {
  return process.env.OAUTH_AUTH_URL ?? DEFAULT_AUTH_URL;
}
