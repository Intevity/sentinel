/**
 * Integration test: TokenRotator across three accounts, fed by REAL proxy
 * header traffic from the fake Anthropic server under different scenarios.
 *
 * Asserts the overage-gate invariant from
 * ~/.claude/projects/-Users-jeff-github-claude-sentinel/memory/feedback_overage_gate.md:
 * the rotator must drain all fresh 5h quota before spilling any account
 * into overage.
 *
 * Unlike token-rotator.test.ts (which seeds RateLimitStore by hand), this
 * test drives the store through the same header-parsing path the daemon
 * uses in production. If Anthropic changes a header name, this test fails;
 * the old seed-based one wouldn't.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { createProxyServer } from './proxy.js';
import { getDb, closeDb, upsertAccount } from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import { TokenRotator } from './token-rotator.js';
import type { IpcServer } from './ipc.js';
import * as accounts from './accounts.js';
import { startFakeAnthropic, type FakeAnthropic, SCENARIOS } from '@claude-sentinel/test-harness';
import type { ScenarioName } from '@claude-sentinel/test-harness';

const SEED: Array<{ id: string; scenario: ScenarioName }> = [
  { id: 'acct-fresh', scenario: 'healthy-account' },
  { id: 'acct-warning', scenario: '5h-warning' },
  { id: 'acct-overage', scenario: 'overage-in-use' },
];

function makeMinimalIpc(): IpcServer {
  return {
    broadcast: vi.fn(),
    onMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    connectedClients: 0,
  } as unknown as IpcServer;
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
    });
  });
}

describe('TokenRotator integration (real headers → store → rotator)', () => {
  let fake: FakeAnthropic;
  let proxy: Server;
  let proxyPort: number;
  let rateLimitStore: RateLimitStore;
  let dbPath: string;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    for (const s of SEED) fake.registerToken(`tok-${s.id}`);
    process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;

    // Make keychain reads return deterministic tokens keyed on accountId.
    vi.spyOn(accounts, 'readSentinelCredentials').mockImplementation((key: string) => ({
      accessToken: `tok-${key}`,
      refreshToken: '',
      expiresAt: 0,
      scopes: [],
    }));
    vi.spyOn(accounts, 'readActiveCredentials').mockReturnValue(null);

    dbPath = join(tmpdir(), `sentinel-rotator-int-${randomUUID()}.db`);
    const db = getDb(dbPath);
    for (const s of SEED) {
      upsertAccount(db, {
        id: s.id,
        accountUuid: s.id,
        email: `${s.id}@x`,
        displayName: s.id,
        orgUuid: '',
        orgName: '',
        planType: 'max',
        isActive: false,
        createdAt: Date.now(),
        color: null,
      });
    }

    rateLimitStore = new RateLimitStore();
    const activeAccountRef = { value: 'acct-fresh' };

    proxy = createProxyServer(
      {
        db,
        ipcServer: makeMinimalIpc(),
        activeToken: { value: `tok-acct-fresh` },
        activeAccountId: activeAccountRef,
        rateLimitStore,
        // Per-request override: use the caller-supplied x-seed-account header
        // to pick which account's scenario we're populating. The real daemon
        // does this via its round-robin rotator; this test uses a fixed map.
        tokenProvider: () => null,
      },
      async (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    );
    proxyPort = await listen(proxy);

    // Drive traffic to populate RateLimitStore for each account under its
    // scenario. The rotator reads from the store, not from the token, so
    // we reset the active-account ref between calls so headers land under
    // the right key.
    for (const s of SEED) {
      fake.setScenario(s.scenario);
      activeAccountRef.value = s.id;
      await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { Authorization: 'Bearer x' },
        body: JSON.stringify({ messages: [] }),
      });
    }
    // Allow async header pipeline to settle across all three accounts.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await fake.close();
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    vi.restoreAllMocks();
    delete process.env.ANTHROPIC_UPSTREAM_URL;
  });

  it('populates RateLimitStore with scenario-driven state for all three accounts', () => {
    for (const s of SEED) {
      const windows = rateLimitStore.getAll(s.id);
      const fiveH = windows.find((w) => w.name === 'unified-5h');
      expect(fiveH, `${s.id} should have unified-5h window`).toBeDefined();
    }
    const fresh = rateLimitStore.getAll('acct-fresh').find((w) => w.name === 'unified-5h');
    const warning = rateLimitStore
      .getAll('acct-warning')
      .find((w) => w.name === 'unified-5h');
    expect(fresh?.utilization).toBeCloseTo(0.1, 1);
    expect(warning?.utilization).toBeCloseTo(0.92, 2);
  });

  it('rotator drains all fresh 5h quota before touching overage accounts', () => {
    const db = getDb(dbPath);
    const rotator = new TokenRotator(
      db,
      rateLimitStore,
      { value: 'acct-fresh' },
      () => new Set(),
      () => 'balance',
      // Opt acct-overage in so it's eligible for the overage tier at all;
      // the rotator still must only pick from fresh while fresh has room.
      () => new Set(['acct-overage']),
      () => new Set(),
      () => 10, // 10% buffer — warning@0.92 is still under threshold 0.9? No, 0.92 > 0.90 so warning also drops out
    );

    // With buffer 10%, threshold = 0.90. fresh=0.10 stays in fresh; warning=0.92 drops into
    // overage tier but has no opt-in, so it is skipped entirely. overage acct is opted-in
    // AND has overage-in-use=true, so it falls into overage tier. Fresh > 0 so rotator
    // should ONLY return acct-fresh.
    const picks = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = rotator.pick();
      if (p) picks.add(p.accountId);
    }

    expect(picks.has('acct-fresh')).toBe(true);
    expect(picks.has('acct-overage')).toBe(false); // overage tier not used while fresh has room
    expect(SCENARIOS['overage-in-use'].label).toContain('overage');
  });
});
