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

export function getOAuthTokenUrl(): string {
  return process.env.OAUTH_TOKEN_URL ?? DEFAULT_TOKEN_URL;
}

export function getOAuthAuthUrl(): string {
  return process.env.OAUTH_AUTH_URL ?? DEFAULT_AUTH_URL;
}
