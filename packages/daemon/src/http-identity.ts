import { request as httpRequest, type IncomingHttpHeaders } from 'http';
import { request as httpsRequest } from 'https';

/**
 * Identity and transport for the daemon's OWN outbound calls to Anthropic.
 *
 * Sentinel originates a handful of non-inference metadata requests (token
 * refresh, OAuth profile, usage, run budget). Those used to go out through a
 * bare `fetch`, which meant undici's defaults reached Anthropic verbatim:
 *
 *     user-agent: node
 *     accept-language: *
 *     sec-fetch-mode: cors
 *
 * That is a bad combination to present while carrying a subscription OAuth
 * token: a generic Node bot UA plus two browser-only Fetch-metadata headers no
 * server-side client would emit. Setting a `user-agent` on a `fetch()` call
 * fixes only the first line — undici appends the other two unconditionally, so
 * the only way to control the full header set is to drive the request
 * ourselves. Hence this module.
 *
 * The goal is honesty, not camouflage: Sentinel identifies itself by name so
 * its traffic is attributable and distinguishable from the Claude Code client
 * whose requests it proxies. It deliberately does NOT imitate Claude Code or a
 * browser.
 */

/** Version stamped into the daemon's env by the Tauri host at spawn time (see
 *  `packages/app/src-tauri/src/daemon.rs`). Absent when the daemon is run
 *  directly (dev, tests, CLI) — `dev` is the honest answer there. */
function sentinelVersion(): string {
  const v = process.env.SENTINEL_VERSION?.trim();
  return v ? v : 'dev';
}

/** User-Agent for every Sentinel-originated request. */
export function sentinelUserAgent(): string {
  return `Sentinel/${sentinelVersion()}`;
}

export interface SentinelRequestOptions {
  method?: string;
  /** Merged over the defaults; keys are sent as given (lower-case preferred). */
  headers?: Record<string, string>;
  /** Serialized request body. `content-length` is set automatically. */
  body?: string;
  /** Hard deadline for the whole exchange. Rejects when exceeded. */
  timeoutMs?: number;
}

export interface SentinelResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Read a single header value, collapsing the array form Node uses for
 *  repeated headers. Mirrors `Headers.get()` closely enough for our callers. */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Perform a Sentinel-originated HTTP(S) request with a controlled header set.
 *
 * Chooses http/https by URL protocol so tests can point the same call sites at
 * the fake-Anthropic listener over plain HTTP via `ANTHROPIC_UPSTREAM_URL` /
 * `OAUTH_TOKEN_URL`.
 *
 * Deliberately omits `accept-encoding`: these are small JSON payloads, and not
 * negotiating compression keeps the response readable without a decompression
 * path. Omitting it is ordinary for a server-side API client.
 *
 * Rejects on transport error or timeout — callers keep the same try/catch shape
 * they had around `fetch`.
 */
/** The exact request options a given call will use. Split out from
 *  {@link sentinelRequest} so protocol/port/header resolution is unit-testable
 *  without standing up a TLS listener or making a real outbound call. */
export function buildRequestOptions(
  url: string,
  opts: SentinelRequestOptions = {},
): {
  secure: boolean;
  options: {
    protocol: string;
    hostname: string;
    port?: number;
    path: string;
    method: string;
    headers: Record<string, string>;
  };
} {
  const target = new URL(url);
  const headers: Record<string, string> = {
    'user-agent': sentinelUserAgent(),
    ...opts.headers,
  };
  if (opts.body != null) {
    headers['content-length'] = String(Buffer.byteLength(opts.body));
  }
  return {
    secure: target.protocol === 'https:',
    options: {
      protocol: target.protocol,
      hostname: target.hostname,
      // `target.port` is '' for default ports; omit so Node picks 80/443.
      ...(target.port ? { port: Number(target.port) } : {}),
      path: `${target.pathname}${target.search}`,
      method: opts.method ?? 'GET',
      headers,
    },
  };
}

export async function sentinelRequest(
  url: string,
  opts: SentinelRequestOptions = {},
): Promise<SentinelResponse> {
  const { secure, options } = buildRequestOptions(url, opts);
  const doRequest = secure ? httpsRequest : httpRequest;
  const host = options.hostname;

  return new Promise<SentinelResponse>((resolve, reject) => {
    const req = doRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          /* v8 ignore next -- Node types statusCode as optional, but it is
           * always set on a response that reached this handler; the coalesce
           * exists only to satisfy the type. */
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
      res.on('error', reject);
    });

    if (opts.timeoutMs != null) {
      // `setTimeout` here is inactivity-based; destroy() surfaces as an
      // 'error' on the request, which the handler below turns into a reject.
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy(new Error(`Sentinel request to ${host} timed out`));
      });
    }
    req.on('error', reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}
