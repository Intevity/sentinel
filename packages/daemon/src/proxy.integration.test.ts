/**
 * Integration test: real proxy HTTP server ↔ real fake Anthropic server.
 *
 * Unlike proxy.test.ts (which mocks https.request), this exercises the
 * full end-to-end path: a client makes an HTTP request to the proxy, the
 * proxy forwards it over HTTP to the fake, the fake emits scenario-driven
 * rate-limit headers, and the proxy's header-inspection pipeline updates
 * RateLimitStore. Verifies the seam between the proxy and the outside
 * world without any vi.mock calls.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Server } from 'http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { createProxyServer, DAEMON_PORT } from './proxy.js';
import { getDb, closeDb, upsertAccount } from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import { RequestAccountMap } from './request-account-map.js';
import type { IpcServer } from './ipc.js';
import { startFakeAnthropic, type FakeAnthropic } from '@sentinel/test-harness';

const TEST_TOKEN = 'integration-token';

function makeMinimalIpc(): IpcServer {
  return {
    broadcast: vi.fn(),
    onMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    connectedClients: 0,
  } as unknown as IpcServer;
}

async function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
    });
  });
}

describe('proxy integration (real HTTP, real fake upstream)', () => {
  let fake: FakeAnthropic;
  let proxy: Server;
  let proxyPort: number;
  let rateLimitStore: RateLimitStore;
  let requestAccountMap: RequestAccountMap;
  let dbPath: string;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    fake.registerToken(TEST_TOKEN);
    process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;

    dbPath = join(tmpdir(), `sentinel-proxy-int-${randomUUID()}.db`);
    const db = getDb(dbPath);
    upsertAccount(db, {
      id: 'acct-int',
      accountUuid: 'acct-int',
      email: 'int@example.com',
      displayName: 'Integration',
      orgUuid: '',
      orgName: '',
      planType: 'max',
      isActive: true,
      createdAt: Date.now(),
      color: null,
    });

    rateLimitStore = new RateLimitStore();
    requestAccountMap = new RequestAccountMap();

    const activeToken = { value: TEST_TOKEN };
    const activeAccountId = { value: 'acct-int' };

    proxy = createProxyServer(
      {
        db,
        ipcServer: makeMinimalIpc(),
        activeToken,
        activeAccountId,
        rateLimitStore,
        requestAccountMap,
      },
      async (_req, res) => {
        // Stub OTEL handler: respond 200 without touching the socket.
        res.writeHead(200);
        res.end();
      },
    );
    proxyPort = await listenEphemeral(proxy);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await fake.close();
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    delete process.env.ANTHROPIC_UPSTREAM_URL;
  });

  beforeEach(() => {
    fake.setScenario('healthy-account');
    fake.resetRequests();
  });

  it('forwards /v1/messages to the fake and returns its body', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer client-supplied',
      },
      body: JSON.stringify({ model: 'claude-opus-4-7', messages: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; role: string };
    expect(body.id).toBe('msg_fake');
    expect(body.role).toBe('assistant');

    const upstreamHit = fake.requests().find((r) => r.url.startsWith('/v1/messages'));
    expect(upstreamHit).toBeDefined();
    // Proxy must have replaced the client's Authorization with the active token.
    expect(upstreamHit?.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it('parses fake rate-limit headers into RateLimitStore', async () => {
    fake.setScenario('5h-warning');
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer x' },
      body: JSON.stringify({ messages: [] }),
    });
    // Allow the proxy's async header pipeline a tick to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const windows = rateLimitStore.getAll('acct-int');
    const fiveH = windows.find((w) => w.name === 'unified-5h');
    expect(fiveH).toBeDefined();
    expect(fiveH?.status).toBe('allowed_warning');
    expect(fiveH?.utilization).toBeCloseTo(0.92, 2);
  });

  it('populates RequestAccountMap from the fake request-id header', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer x' },
      body: JSON.stringify({ messages: [] }),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const size = requestAccountMap.size();
    expect(size).toBeGreaterThan(0);
  });

  it('flips inUse when scenario switches to overage-in-use', async () => {
    fake.setScenario('overage-in-use');
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer x' },
      body: JSON.stringify({ messages: [] }),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const overage = rateLimitStore.getAll('acct-int').find((w) => w.name === 'unified-overage');
    expect(overage?.inUse).toBe(true);
    expect(overage?.status).toBe('allowed');
  });

  it('DAEMON_PORT constant is stable', () => {
    expect(DAEMON_PORT).toBe(47284);
  });
});
