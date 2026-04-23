/**
 * Fake Anthropic API server. One HTTP listener that multiplexes every
 * endpoint the daemon talks to. Tests point the daemon at this server
 * via ANTHROPIC_UPSTREAM_URL / OAUTH_TOKEN_URL env vars (see
 * packages/daemon/src/hosts.ts).
 *
 * Design:
 *  - Real HTTP listener on a random port (NOT fetch/https interception).
 *    The daemon's real proxy code, real URL parser, real header
 *    forwarding all execute end-to-end.
 *  - Scenario presets (scenarios.ts) drive rate-limit header state.
 *  - Fault injection API for one-shot overrides (setScenario / queueResponse).
 *  - SSE streaming support on /v1/messages when content-type is text/event-stream.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { SCENARIOS, scenarioHeaders, type ScenarioName } from './scenarios.js';

export interface FakeScenario {
  /** Override status code for the next response. */
  status?: number;
  /** Override JSON body. If omitted, a default body is synthesized per endpoint. */
  body?: unknown;
  /** Extra headers to inject on top of scenario-preset headers. */
  extraHeaders?: Record<string, string>;
  /** Emit a Server-Sent Events stream instead of a JSON body (for /v1/messages). */
  sse?: boolean;
}

export interface TokenRecord {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: 'Bearer';
}

export interface FakeAnthropic {
  /** Base origin, e.g. http://127.0.0.1:54321 — set this as ANTHROPIC_UPSTREAM_URL. */
  readonly origin: string;
  /** Full token URL — set this as OAUTH_TOKEN_URL. */
  readonly tokenUrl: string;
  /** Full auth URL — set this as OAUTH_AUTH_URL. Clicks aren't automated; the
   *  daemon just opens a browser. Callback flow isn't exercised here; use
   *  injectCallback() to drive it. */
  readonly authUrl: string;
  /** Change the active scenario; affects subsequent /v1/messages responses. */
  setScenario(name: ScenarioName): void;
  /** Queue a single override applied to the next matching request, then popped. */
  queueResponse(endpoint: EndpointMatcher, override: FakeScenario): void;
  /** Register a valid access token. Requests without Bearer or with unknown
   *  tokens return 401. Call this before exercising authed endpoints. */
  registerToken(token: string, profile?: Partial<FakeProfile>): void;
  /** Return list of recorded requests for assertions. */
  requests(): FakeRequestRecord[];
  /** Clear recorded requests (useful between test cases). */
  resetRequests(): void;
  /** Shut down the HTTP listener. */
  close(): Promise<void>;
}

export interface FakeRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  timestamp: number;
}

export interface FakeProfile {
  email: string;
  display_name: string;
  uuid: string;
  has_claude_max: boolean;
  org_uuid: string;
  org_name: string;
  org_type: 'claude_pro' | 'claude_max' | 'claude_team' | 'claude_enterprise' | '';
  rate_limit_tier: string;
  organization_role: 'user' | 'admin' | 'primary_owner';
  has_extra_usage_enabled: boolean;
}

const DEFAULT_PROFILE: FakeProfile = {
  email: 'test@example.com',
  display_name: 'Test User',
  uuid: '00000000-0000-0000-0000-000000000001',
  has_claude_max: true,
  org_uuid: '00000000-0000-0000-0000-000000000002',
  org_name: 'Test Org',
  org_type: 'claude_max',
  rate_limit_tier: 'default',
  organization_role: 'primary_owner',
  has_extra_usage_enabled: true,
};

type EndpointMatcher = '/v1/messages' | '/v1/oauth/token' | '/api/oauth/profile' | '/api/oauth/usage' | '/v1/code/routines/run-budget' | '/v1/models' | '/v1/count_tokens' | '/v1/complete';

export async function startFakeAnthropic(init: { scenario?: ScenarioName } = {}): Promise<FakeAnthropic> {
  let activeScenario: ScenarioName = init.scenario ?? 'healthy-account';
  const tokens = new Map<string, FakeProfile>();
  const queuedOverrides = new Map<EndpointMatcher, FakeScenario[]>();
  const requestLog: FakeRequestRecord[] = [];

  const server = createServer((req, res) => handle(req, res));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requestLog.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: { ...req.headers },
        body,
        timestamp: Date.now(),
      });
      route(req, res, body);
    });
  }

  function route(req: IncomingMessage, res: ServerResponse, body: string): void {
    const url = req.url ?? '';
    const path = url.split('?')[0] ?? '';

    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', fake: true }));
      return;
    }

    if (path.startsWith('/v1/messages')) {
      return handleMessages(req, res);
    }

    if (path === '/v1/oauth/token') {
      return handleToken(res, body);
    }

    if (path === '/api/oauth/profile') {
      return handleProfile(req, res);
    }

    if (path === '/api/oauth/usage') {
      return handleUsage(req, res);
    }

    if (path === '/v1/code/routines/run-budget') {
      return handleRunBudget(req, res);
    }

    if (path === '/v1/models') {
      if (!requireAuth(req, res)) return;
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': randomUUID() });
      res.end(JSON.stringify({ data: [{ id: 'claude-opus-4-7', display_name: 'Opus 4.7' }] }));
      return;
    }

    if (path === '/v1/count_tokens') {
      if (!requireAuth(req, res)) return;
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': randomUUID() });
      res.end(JSON.stringify({ input_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));
      return;
    }

    if (path === '/v1/complete') {
      if (!requireAuth(req, res)) return;
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': randomUUID() });
      res.end(JSON.stringify({ completion: 'hello', stop_reason: 'end_turn' }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `no fake handler for ${path}` }));
  }

  function handleMessages(req: IncomingMessage, res: ServerResponse): void {
    if (!requireAuth(req, res)) return;
    const override = popOverride('/v1/messages');
    const scenario = SCENARIOS[activeScenario];
    const status = override?.status ?? scenario.messagesStatus ?? 200;
    const headers: Record<string, string> = {
      ...scenarioHeaders(activeScenario),
      ...(override?.extraHeaders ?? {}),
    };

    if (override?.sse) {
      res.writeHead(status, { 'content-type': 'text/event-stream', ...headers });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fake","model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
      return;
    }

    const defaultBody = {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(override?.body ?? defaultBody));
  }

  function handleToken(res: ServerResponse, body: string): void {
    const scenario = SCENARIOS[activeScenario];
    const override = popOverride('/v1/oauth/token');
    const status = override?.status ?? scenario.tokenStatus ?? 200;
    if (status >= 400) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token revoked' }));
      return;
    }
    let parsed: { client_id?: string; grant_type?: string } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      // tolerate
    }
    const token: TokenRecord = {
      access_token: `fake-access-${randomUUID()}`,
      refresh_token: `fake-refresh-${randomUUID()}`,
      expires_in: 3600,
      scope: 'user:profile user:inference',
      token_type: 'Bearer',
    };
    tokens.set(token.access_token, { ...DEFAULT_PROFILE });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(override?.body ?? token));
    void parsed;
  }

  function handleProfile(req: IncomingMessage, res: ServerResponse): void {
    const profile = resolveAuth(req);
    if (!profile) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        account: {
          uuid: profile.uuid,
          email: profile.email,
          display_name: profile.display_name,
          has_claude_max: profile.has_claude_max,
        },
        organization: {
          uuid: profile.org_uuid,
          name: profile.org_name,
          organization_type: profile.org_type,
          rate_limit_tier: profile.rate_limit_tier,
          organization_role: profile.organization_role,
          workspace_role: null,
          has_extra_usage_enabled: profile.has_extra_usage_enabled,
        },
      }),
    );
  }

  function handleUsage(req: IncomingMessage, res: ServerResponse): void {
    if (!requireAuth(req, res)) return;
    // Shape matches claude-ai-usage.ts RawUsageResponse
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        five_hour: {
          utilization: 0.1,
          resets_at: new Date(Date.now() + 3600_000).toISOString(),
        },
        seven_day: {
          utilization: 0.2,
          resets_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
        },
        seven_day_sonnet: {
          utilization: 0.05,
          resets_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
        },
        extra_usage: {
          is_enabled: true,
          utilization_pct: 0,
        },
      }),
    );
  }

  function handleRunBudget(req: IncomingMessage, res: ServerResponse): void {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        limit: 10_000,
        used: 1_234,
        unified_billing_enabled: true,
      }),
    );
  }

  function popOverride(endpoint: EndpointMatcher): FakeScenario | undefined {
    const queue = queuedOverrides.get(endpoint);
    if (!queue || queue.length === 0) return undefined;
    return queue.shift();
  }

  function resolveAuth(req: IncomingMessage): FakeProfile | null {
    const header = req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw || !raw.startsWith('Bearer ')) return null;
    const token = raw.slice('Bearer '.length);
    return tokens.get(token) ?? null;
  }

  function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (resolveAuth(req)) return true;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }

  return {
    origin,
    tokenUrl: `${origin}/v1/oauth/token`,
    authUrl: `${origin}/cai/oauth/authorize`,
    setScenario(name) {
      activeScenario = name;
    },
    queueResponse(endpoint, override) {
      const queue = queuedOverrides.get(endpoint) ?? [];
      queue.push(override);
      queuedOverrides.set(endpoint, queue);
    },
    registerToken(token, profile = {}) {
      tokens.set(token, { ...DEFAULT_PROFILE, ...profile });
    },
    requests() {
      return [...requestLog];
    },
    resetRequests() {
      requestLog.length = 0;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export type { Server };
