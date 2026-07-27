/**
 * Tests for the transport behind every Sentinel-originated request.
 *
 * These run against a real `http.createServer` listener rather than a mocked
 * client, because the whole point of the module is which bytes reach the wire —
 * a mock of the request layer would assert nothing about that.
 */

import { describe, it, expect, afterAll, beforeAll, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildRequestOptions,
  headerValue,
  sentinelRequest,
  sentinelUserAgent,
} from './http-identity.js';

interface Received {
  method: string;
  url: string;
  rawHeaders: string[];
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('http-identity', () => {
  let server: Server;
  let origin: string;
  let received: Received[] = [];
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          rawHeaders: [...req.rawHeaders],
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
        if (handler) return handler(req, res);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    origin = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    received = [];
    handler = null;
    delete process.env.SENTINEL_VERSION;
  });

  describe('sentinelUserAgent', () => {
    it('reports the version the host stamped into the environment', () => {
      process.env.SENTINEL_VERSION = '0.9.2';
      expect(sentinelUserAgent()).toBe('Sentinel/0.9.2');
    });

    it('reports dev when no version is present, rather than inventing one', () => {
      delete process.env.SENTINEL_VERSION;
      expect(sentinelUserAgent()).toBe('Sentinel/dev');
    });

    it('treats a blank version as absent', () => {
      process.env.SENTINEL_VERSION = '   ';
      expect(sentinelUserAgent()).toBe('Sentinel/dev');
    });

    it('never claims to be Claude Code', () => {
      process.env.SENTINEL_VERSION = '1.2.3';
      expect(sentinelUserAgent()).not.toMatch(/claude/i);
    });
  });

  describe('buildRequestOptions', () => {
    it('selects TLS and the default port for a production https origin', () => {
      const { secure, options } = buildRequestOptions('https://api.anthropic.com/api/oauth/usage');
      expect(secure).toBe(true);
      // Port must be ABSENT, not 443 — an explicit '' from URL.port coerced to
      // Number would be 0 and fail to connect.
      expect(options.port).toBeUndefined();
      expect(options.hostname).toBe('api.anthropic.com');
      expect(options.path).toBe('/api/oauth/usage');
    });

    it('selects plaintext and an explicit port for a test origin', () => {
      const { secure, options } = buildRequestOptions(
        'http://127.0.0.1:54321/v1/messages?beta=true',
      );
      expect(secure).toBe(false);
      expect(options.port).toBe(54321);
      expect(options.path).toBe('/v1/messages?beta=true');
    });

    it('keeps the token endpoint on TLS with its own host', () => {
      const { secure, options } = buildRequestOptions(
        'https://platform.claude.com/v1/oauth/token',
        {
          method: 'POST',
          body: '{}',
        },
      );
      expect(secure).toBe(true);
      expect(options.hostname).toBe('platform.claude.com');
      expect(options.method).toBe('POST');
      expect(options.headers['content-length']).toBe('2');
    });
  });

  describe('sentinelRequest header set', () => {
    it('identifies as Sentinel and omits undici’s browser artifacts', async () => {
      process.env.SENTINEL_VERSION = '1.0.0';
      const res = await sentinelRequest(`${origin}/api/oauth/usage`);
      expect(res.status).toBe(200);
      expect(res.body).toBe('{"ok":true}');

      const hit = received[0]!;
      expect(hit.headers['user-agent']).toBe('Sentinel/1.0.0');
      // The three headers a bare `fetch()` added that we cannot suppress there.
      expect(hit.headers['sec-fetch-mode']).toBeUndefined();
      expect(hit.headers['accept-language']).toBeUndefined();
      // No compression negotiated: these are small JSON payloads and an
      // undecodable body is worse than an uncompressed one.
      expect(hit.headers['accept-encoding']).toBeUndefined();
    });

    it('lets callers override the user-agent explicitly', async () => {
      await sentinelRequest(`${origin}/x`, { headers: { 'user-agent': 'Sentinel/override' } });
      expect(received[0]!.headers['user-agent']).toBe('Sentinel/override');
    });

    it('passes through auth and beta headers verbatim', async () => {
      await sentinelRequest(`${origin}/api/oauth/usage`, {
        headers: { authorization: 'Bearer tok-123', 'anthropic-beta': 'oauth-2025-04-20' },
      });
      expect(received[0]!.headers['authorization']).toBe('Bearer tok-123');
      expect(received[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    });

    it('preserves the query string', async () => {
      await sentinelRequest(`${origin}/v1/messages?beta=true`);
      expect(received[0]!.url).toBe('/v1/messages?beta=true');
    });
  });

  describe('sentinelRequest bodies and methods', () => {
    it('sends a POST body with a computed content-length', async () => {
      const body = JSON.stringify({ grant_type: 'refresh_token' });
      await sentinelRequest(`${origin}/v1/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const hit = received[0]!;
      expect(hit.method).toBe('POST');
      expect(hit.body).toBe(body);
      expect(hit.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    });

    it('defaults to GET with no body', async () => {
      await sentinelRequest(`${origin}/ping`);
      expect(received[0]!.method).toBe('GET');
      expect(received[0]!.body).toBe('');
    });
  });

  describe('sentinelRequest responses', () => {
    it('surfaces non-2xx status and body instead of throwing', async () => {
      handler = (_req, res) => {
        res.writeHead(429, { 'retry-after': '600' });
        res.end('slow down');
      };
      const res = await sentinelRequest(`${origin}/api/oauth/usage`);
      expect(res.status).toBe(429);
      expect(res.body).toBe('slow down');
      expect(headerValue(res.headers, 'retry-after')).toBe('600');
    });

    it('rejects on a transport error so callers keep their try/catch', async () => {
      // Port 1 on loopback has nothing listening; connect fails fast.
      await expect(sentinelRequest('http://127.0.0.1:1/nope')).rejects.toThrow();
    });

    it('drives https URLs through the TLS client', async () => {
      // Exercises the `secure` arm — the production path for every real call —
      // without standing up a TLS listener: the connection is refused, which
      // still proves the request went out via https.request rather than
      // http.request (an http.request to an https URL would not even parse the
      // protocol the same way, and this asserts the rejection surfaces).
      await expect(sentinelRequest('https://127.0.0.1:1/nope')).rejects.toThrow();
    });

    it('rejects when the socket dies mid-body rather than resolving a truncated body', async () => {
      handler = (_req, res) => {
        // Promise a length we never deliver, then kill the socket. Resolving a
        // short body here would silently hand callers half a JSON document.
        res.writeHead(200, { 'content-length': '500' });
        res.write('{"partial":');
        res.socket?.destroy();
      };
      await expect(sentinelRequest(`${origin}/truncated`)).rejects.toThrow();
    });

    it('rejects when the response stalls past the timeout', async () => {
      handler = () => {
        // Never respond — exercise the timeout path.
      };
      await expect(sentinelRequest(`${origin}/hang`, { timeoutMs: 150 })).rejects.toThrow(
        /timed out/,
      );
    });
  });

  describe('headerValue', () => {
    it('reads a header case-insensitively', () => {
      expect(headerValue({ 'retry-after': '30' }, 'Retry-After')).toBe('30');
    });

    it('collapses the repeated-header array form to the first value', () => {
      expect(headerValue({ 'set-cookie': ['a=1', 'b=2'] }, 'set-cookie')).toBe('a=1');
    });

    it('returns null for an absent header', () => {
      expect(headerValue({}, 'retry-after')).toBeNull();
    });

    it('returns null for an empty array', () => {
      expect(headerValue({ 'x-multi': [] }, 'x-multi')).toBeNull();
    });
  });
});
