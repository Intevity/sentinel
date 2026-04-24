/**
 * Integration test: TokenRotator across multiple accounts, fed by REAL
 * proxy header traffic from the fake Anthropic server under different
 * scenarios.
 *
 * Asserts the overage-gate invariant from
 * ~/.claude/projects/-Users-jeff-github-claude-sentinel/memory/feedback_overage_gate.md:
 * the rotator must drain all fresh 5h quota before spilling any account
 * into overage.
 *
 * Unlike `token-rotator.test.ts` (which seeds RateLimitStore by hand),
 * this test drives the store through the same header-parsing path the
 * daemon uses in production. If Anthropic renames a header, this test
 * fails; the unit version wouldn't.
 *
 * Credential resolution flows through the REAL keychain code via the
 * test-keychain adapter (`CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE`). No spies
 * on `accounts.*`. IPC broadcasts land in a real capturing IPC stub
 * (`makeCapturingIpc`) — no `vi.fn()` sites.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { createProxyServer } from './proxy.js';
import { getDb, closeDb, upsertAccount } from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import { TokenRotator } from './token-rotator.js';
import { writeSentinelCredentials } from './accounts.js';
import { makeCapturingIpc } from './proxy.test-helpers.js';
import { startFakeAnthropic, type FakeAnthropic, SCENARIOS } from '@claude-sentinel/test-harness';
import type { ScenarioName } from '@claude-sentinel/test-harness';

const SEED: Array<{ id: string; scenario: ScenarioName }> = [
  { id: 'acct-fresh', scenario: 'healthy-account' },
  { id: 'acct-warning', scenario: '5h-warning' },
  { id: 'acct-overage', scenario: 'overage-in-use' },
  { id: 'acct-sonnet-saturation', scenario: 'sonnet-saturation' },
  { id: 'acct-overage-disabled', scenario: 'overage-disabled' },
];

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
  let keychainFile: string;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    for (const s of SEED) fake.registerToken(`tok-${s.id}`);
    process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;

    // Write real Sentinel credentials to the test-keychain JSON file; the
    // rotator's real `readSentinelCredentials` picks them up via the
    // adapter at accounts.ts:115.
    keychainFile = join(tmpdir(), `sentinel-rotator-int-kc-${randomUUID()}.json`);
    process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = keychainFile;
    for (const s of SEED) {
      writeSentinelCredentials(s.id, {
        accessToken: `tok-${s.id}`,
        refreshToken: '',
        expiresAt: 0,
        scopes: [],
      });
    }

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
        ipcServer: makeCapturingIpc(),
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
    // Allow async header pipeline to settle across all accounts.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await fake.close();
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(keychainFile)) unlinkSync(keychainFile);
    delete process.env.ANTHROPIC_UPSTREAM_URL;
    delete process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE;
  });

  it('populates RateLimitStore with scenario-driven state for all seeded accounts', () => {
    for (const s of SEED) {
      const windows = rateLimitStore.getAll(s.id);
      const fiveH = windows.find((w) => w.name === 'unified-5h');
      expect(fiveH, `${s.id} should have unified-5h window`).toBeDefined();
    }
    const fresh = rateLimitStore.getAll('acct-fresh').find((w) => w.name === 'unified-5h');
    const warning = rateLimitStore.getAll('acct-warning').find((w) => w.name === 'unified-5h');
    expect(fresh?.utilization).toBeCloseTo(0.1, 1);
    expect(warning?.utilization).toBeCloseTo(0.92, 2);

    // Sonnet scenario emits a `unified-7d_sonnet` window separately.
    const sonnet = rateLimitStore
      .getAll('acct-sonnet-saturation')
      .find((w) => w.name === 'unified-7d_sonnet');
    expect(sonnet?.utilization).toBeCloseTo(0.95, 2);

    // overage-disabled's overage window should have status=disabled.
    const overageDisabled = rateLimitStore
      .getAll('acct-overage-disabled')
      .find((w) => w.name === 'unified-overage');
    expect(overageDisabled?.status).toBe('disabled');
  });

  it('rotator drains all fresh 5h quota before touching overage accounts', () => {
    const db = getDb(dbPath);
    // Pool down to the original three accounts so the existing invariant
    // assertion stays crisp; the extra sonnet/overage-disabled accounts
    // would obscure the fresh-vs-overage contrast.
    const excluded = new Set(['acct-sonnet-saturation', 'acct-overage-disabled']);
    const rotator = new TokenRotator(
      db,
      rateLimitStore,
      { value: 'acct-fresh' },
      () => excluded,
      () => 'balance',
      // Opt acct-overage in so it's eligible for the overage tier at all;
      // the rotator still must only pick from fresh while fresh has room.
      () => new Set(['acct-overage']),
      () => new Set(),
      () => 10, // 10% buffer — warning@0.92 drops to overage but has no opt-in
    );

    const picks = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = rotator.pick();
      if (p) picks.add(p.accountId);
    }

    expect(picks.has('acct-fresh')).toBe(true);
    expect(picks.has('acct-overage')).toBe(false); // overage tier not used while fresh has room
    expect(SCENARIOS['overage-in-use'].label).toContain('overage');
  });

  it('warning account with no overage window is skipped even when opted in', () => {
    // 5h-warning scenario emits no overage headers. At util 0.92 with
    // buffer=10 (threshold 0.90), the account drops out of the fresh tier.
    // Opting it into overage can't save it: canUseOverage requires
    // overage.status === 'allowed', and the window is absent entirely
    // (overageWindow is undefined → `?.status === 'allowed'` is false).
    const db = getDb(dbPath);
    const excluded = new Set(SEED.map((s) => s.id).filter((id) => id !== 'acct-warning'));
    const rotator = new TokenRotator(
      db,
      rateLimitStore,
      { value: 'acct-warning' },
      () => excluded,
      () => 'balance',
      () => new Set(['acct-warning']),
      () => new Set(),
      () => 10,
    );
    expect(rotator.pick()).toBeNull();
  });

  it('sonnet-saturated account is skipped when isSonnet=true without opt-in but selectable for Opus traffic', () => {
    // sonnet-saturation scenario: 5h util 0.45 (fresh tier under buffer 10),
    // unified-7d_sonnet util 0.95 (above 0.90 threshold), no overage window.
    // isSonnet=true folds the sonnet window into the overage gate; with no
    // overage window the account is unconditionally skipped. isSonnet=false
    // leaves it in the fresh tier.
    const db = getDb(dbPath);
    const excluded = new Set(SEED.map((s) => s.id).filter((id) => id !== 'acct-sonnet-saturation'));
    const rotator = new TokenRotator(
      db,
      rateLimitStore,
      { value: 'acct-sonnet-saturation' },
      () => excluded,
      () => 'balance',
      () => new Set(), // not opted into overage
      () => new Set(),
      () => 10,
    );

    // Sonnet request: at-threshold path, no overage → null.
    expect(rotator.pick({ isSonnet: true })).toBeNull();

    // Opus / ctx-less request: 5h util 0.45 < 0.90, stays in fresh tier.
    expect(rotator.pick()?.accountId).toBe('acct-sonnet-saturation');
    expect(rotator.pick({ isSonnet: false })?.accountId).toBe('acct-sonnet-saturation');
  });

  it('overage-disabled account is never selected regardless of opt-in', () => {
    // overage-disabled scenario: 5h blocked (status=blocked, util=1.0) and
    // overage.status=disabled. windows.some(status='blocked') is true, so
    // the account enters the blocked branch; canUseOverage requires
    // overage.status==='allowed' AND opt-in, so disabled short-circuits
    // even with the account on the allow-list.
    const db = getDb(dbPath);
    const excluded = new Set(SEED.map((s) => s.id).filter((id) => id !== 'acct-overage-disabled'));
    const rotator = new TokenRotator(
      db,
      rateLimitStore,
      { value: 'acct-overage-disabled' },
      () => excluded,
      () => 'balance',
      () => new Set(['acct-overage-disabled']), // opted in — should not matter
      () => new Set(),
      () => 10,
    );
    expect(rotator.pick()).toBeNull();
  });
});
