import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type Database from 'better-sqlite3';
import { estimateTokensFromBytes } from '@claude-sentinel/shared';
import { getDb, closeDb, insertToolCall } from '../db.js';
import { ContextCostStore } from './context-cost-db.js';
import {
  buildMcpContextInsights,
  sanitizeServerName,
  CODE_MODE_MIN_DEF_TOKENS,
  CODE_MODE_MAX_CALLS_7D,
} from './mcp-insights.js';
import { getBaseInputPricePerMillion, CACHE_WRITE_5M_MULTIPLIER } from '../cache-ttl/pricing.js';

const stamp = (): string => `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe('buildMcpContextInsights', () => {
  let db: Database.Database;
  let dbPath: string;
  let store: ContextCostStore;
  let storePath: string;
  let claudeJsonPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `sentinel-insights-${stamp()}.db`);
    process.env['CLAUDE_SENTINEL_TEST_DB_FILE'] = dbPath;
    db = getDb(dbPath);
    db.exec('DELETE FROM tool_calls');

    storePath = join(tmpdir(), `sentinel-insights-cost-${stamp()}.db`);
    store = new ContextCostStore({ dbPath: storePath });

    claudeJsonPath = join(tmpdir(), `sentinel-insights-claude-${stamp()}.json`);
    process.env['CLAUDE_SENTINEL_TEST_CLAUDE_JSON'] = claudeJsonPath;
  });

  afterEach(() => {
    closeDb();
    store.close();
    delete process.env['CLAUDE_SENTINEL_TEST_DB_FILE'];
    delete process.env['CLAUDE_SENTINEL_TEST_CLAUDE_JSON'];
    for (const p of [dbPath, storePath]) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(p + suffix)) rmSync(p + suffix);
      }
    }
    if (existsSync(claudeJsonPath)) unlinkSync(claudeJsonPath);
  });

  function writeClaudeJson(obj: unknown): void {
    writeFileSync(claudeJsonPath, JSON.stringify(obj), 'utf-8');
  }

  function seedUsage(toolName: string, opts: { calls?: number; outBytes?: number } = {}): void {
    const calls = opts.calls ?? 1;
    for (let i = 0; i < calls; i++) {
      insertToolCall(db, {
        ts: Date.now(),
        accountId: 'a1',
        sessionId: `s-${i % 3}`,
        requestId: `r-${stamp()}`,
        requestSeqInSession: 1,
        toolUseId: `tu-${stamp()}`,
        toolName,
        filePath: null,
        inputSizeBytes: 100,
        responseSizeBytes: opts.outBytes ?? 1000,
        denied: false,
        model: 'claude-opus-4-8',
      });
    }
  }

  function seedMeasured(
    server: string,
    defBytes: number,
    toolNames: string[],
    toolCount = toolNames.length,
  ): void {
    store.enqueue({
      ts: Date.now(),
      accountId: 'a1',
      perServer: [{ server, defBytes, toolCount, toolNames }],
      nativeBytes: 9000,
      nativeToolCount: 12,
    });
    store.flush();
  }

  function build(migrations: Parameters<typeof buildMcpContextInsights>[0]['migrations'] = []) {
    return buildMcpContextInsights({ db, contextStore: store, migrations });
  }

  it('joins config + measured + usage into one insight per server', () => {
    writeClaudeJson({
      mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } },
      projects: { '/repo': { mcpServers: { github: {} } } },
    });
    seedMeasured('github', 35_000, ['mcp__github__search_code', 'mcp__github__list_issues']);
    seedUsage('mcp__github__search_code', { calls: 3, outBytes: 5_000 });

    const out = build();
    const gh = out.insights.find((i) => i.server === 'github');
    expect(gh).toBeDefined();
    expect(gh?.projects).toEqual(['/repo']);
    expect(gh?.global).toBe(true);
    expect(gh?.enabled).toBe(true);
    expect(gh?.definition).toEqual({
      bytes: 35_000,
      estTokens: estimateTokensFromBytes(35_000),
      toolCount: 2,
      requestCount: 1,
      measured: true,
    });
    expect(gh?.usage7d.calls).toBe(3);
    expect(gh?.bridgeStatus).toBe('native');
    expect(out.nativeDefBytes).toBe(9000);
    expect(out.measuredRequests).toBe(1);
  });

  it('matches sanitized config names to measured tool-name servers', () => {
    writeClaudeJson({
      projects: { '/p': { mcpServers: { 'plugin:mongodb:mongodb': {} } } },
    });
    seedMeasured('plugin_mongodb_mongodb', 19_000, ['mcp__plugin_mongodb_mongodb__find']);
    const out = build();
    const row = out.insights.find((i) => i.server === 'plugin:mongodb:mongodb');
    expect(row).toBeDefined();
    expect(row?.definition.measured).toBe(true);
    expect(row?.definition.bytes).toBe(19_000);
    expect(sanitizeServerName('plugin:mongodb:mongodb')).toBe('plugin_mongodb_mongodb');
  });

  it('flags unused: measured in traffic, enabled, zero calls in 7d', () => {
    writeClaudeJson({ mcpServers: { idle: {} } });
    seedMeasured('idle', 8_000, ['mcp__idle__tool_a']);
    const out = build();
    const idle = out.insights.find((i) => i.server === 'idle');
    expect(idle?.recommendations.map((r) => r.kind)).toContain('unused');
  });

  it('flags code-mode at the documented thresholds and not below them', () => {
    // Above the token floor, below the call ceiling: qualifies.
    const qualifyingBytes = CODE_MODE_MIN_DEF_TOKENS * 4; // 3.5 B/tok ⇒ comfortably above
    writeClaudeJson({ mcpServers: { heavy: {}, light: {} } });
    seedMeasured('heavy', qualifyingBytes, ['mcp__heavy__a']);
    seedMeasured('light', 350, ['mcp__light__a']); // ~100 tokens: below floor
    const out = build();
    const heavy = out.insights.find((i) => i.server === 'heavy');
    const light = out.insights.find((i) => i.server === 'light');
    expect(heavy?.recommendations.map((r) => r.kind)).toContain('code-mode');
    expect(light?.recommendations.map((r) => r.kind)).not.toContain('code-mode');
  });

  it('suppresses code-mode above the call ceiling', () => {
    writeClaudeJson({ mcpServers: { busy: {} } });
    seedMeasured('busy', 70_000, ['mcp__busy__a']);
    seedUsage('mcp__busy__a', { calls: CODE_MODE_MAX_CALLS_7D + 1 });
    const out = build();
    const busy = out.insights.find((i) => i.server === 'busy');
    expect(busy?.recommendations.map((r) => r.kind)).not.toContain('code-mode');
  });

  it('flags duplicates by tool-suffix overlap across name variants', () => {
    writeClaudeJson({
      mcpServers: { 'mongodb-mcp-server': {} },
      projects: { '/p': { mcpServers: { 'plugin:mongodb:mongodb': {} } } },
    });
    seedMeasured('mongodb-mcp-server', 35_000, [
      'mcp__mongodb-mcp-server__find',
      'mcp__mongodb-mcp-server__aggregate',
      'mcp__mongodb-mcp-server__count',
    ]);
    seedMeasured('plugin_mongodb_mongodb', 19_000, [
      'mcp__plugin_mongodb_mongodb__find',
      'mcp__plugin_mongodb_mongodb__aggregate',
    ]);
    const out = build();
    const plugin = out.insights.find((i) => i.server === 'plugin:mongodb:mongodb');
    const dup = plugin?.recommendations.find((r) => r.kind === 'duplicate');
    expect(dup).toBeDefined();
    expect(dup?.detail).toBe('mongodb-mcp-server');
  });

  it('flags disabled servers and skips other recommendations for them', () => {
    writeClaudeJson({
      projects: { '/p': { mcpServers: {}, disabledMcpServers: ['figma'] } },
    });
    const out = build();
    const figma = out.insights.find((i) => i.server === 'figma');
    expect(figma?.enabled).toBe(false);
    expect(figma?.recommendations).toEqual([{ kind: 'disabled' }]);
  });

  it('marks bridged servers and suppresses code-mode/unused on them', () => {
    writeClaudeJson({ mcpServers: { github: {} } });
    seedMeasured('github', 70_000, ['mcp__github__search_code']);
    const out = build([
      {
        server: 'github',
        scope: 'user',
        directory: null,
        originalEntry: {},
        migratedAt: Date.now(),
      },
    ]);
    const gh = out.insights.find((i) => i.server === 'github');
    expect(gh?.bridgeStatus).toBe('bridged');
    expect(gh?.recommendations.map((r) => r.kind)).not.toContain('code-mode');
    expect(gh?.recommendations.map((r) => r.kind)).not.toContain('unused');
  });

  it('always includes bridged servers, even with no config entry and no measured traffic', () => {
    // Migration removes the config entry; a fresh bridge has no traffic yet.
    writeClaudeJson({ mcpServers: {} });
    const out = build([
      {
        server: 'plugin:mongodb:mongodb',
        scope: 'user',
        directory: null,
        originalEntry: { type: 'http', url: 'x' },
        migratedAt: 1,
      },
    ]);
    const row = out.insights.find((i) => i.server === 'plugin:mongodb:mongodb');
    expect(row).toBeDefined();
    expect(row?.bridgeStatus).toBe('bridged');
    expect(row?.definition.measured).toBe(false);
  });

  it('bridged servers carry no badges at all, even with disabled config markers left behind', () => {
    // After a full migration the surviving config rows are the
    // disabledMcpServers markers; those must not earn a 'disabled' badge
    // next to the bridged pill.
    writeClaudeJson({
      projects: { '/p': { mcpServers: {}, disabledMcpServers: ['github'] } },
    });
    seedMeasured('github', 70_000, ['mcp__github__search_code']);
    const out = build([
      { server: 'github', scope: 'user', directory: null, originalEntry: {}, migratedAt: 1 },
    ]);
    const gh = out.insights.find((i) => i.server === 'github');
    expect(gh?.bridgeStatus).toBe('bridged');
    expect(gh?.recommendations).toEqual([]);
  });

  it('marks unavailable bridged servers', () => {
    writeClaudeJson({ mcpServers: { flaky: {} } });
    const out = buildMcpContextInsights({
      db,
      contextStore: store,
      migrations: [
        { server: 'flaky', scope: 'user', directory: null, originalEntry: {}, migratedAt: 1 },
      ],
      unavailableServers: new Set(['flaky']),
    });
    expect(out.insights.find((i) => i.server === 'flaky')?.bridgeStatus).toBe('unavailable');
  });

  it('computes the cache-write estimate from def tokens, dominant-model price, and sessions', () => {
    writeClaudeJson({ mcpServers: { github: {} } });
    seedMeasured('github', 35_000, ['mcp__github__search_code']);
    seedUsage('mcp__github__search_code', { calls: 3 }); // 3 calls across 3 sessions, opus model
    const out = build();
    const gh = out.insights.find((i) => i.server === 'github');
    const defTokens = estimateTokensFromBytes(35_000);
    const expected =
      (defTokens / 1_000_000) *
      getBaseInputPricePerMillion('claude-opus-4-8') *
      CACHE_WRITE_5M_MULTIPLIER *
      3;
    expect(gh?.cacheWriteEstUsd).toBeCloseTo(expected, 10);
  });

  it('computes realized savings for a bridged server from post-migration traffic', () => {
    writeClaudeJson({ mcpServers: {} });
    const DAY = 24 * 60 * 60 * 1000;
    const migratedAt = Date.now() - 5 * DAY;
    // Pre-migration: github definitions rode on one request (sets the
    // all-time defBytesMax the counterfactual uses).
    store.enqueue({
      ts: migratedAt - 2 * DAY,
      accountId: 'a1',
      perServer: [{ server: 'github', defBytes: 35_000, toolCount: 43, toolNames: [] }],
      nativeBytes: 9_000,
      nativeToolCount: 12,
    });
    // Post-migration: three requests with NO github definitions (only the
    // native row counts them).
    for (let i = 0; i < 3; i++) {
      store.enqueue({
        ts: Date.now() - DAY + i * 1000,
        accountId: 'a1',
        perServer: [],
        nativeBytes: 9_000,
        nativeToolCount: 12,
      });
    }
    store.flush();

    const out = build([
      { server: 'github', scope: 'user', directory: null, originalEntry: {}, migratedAt },
    ]);
    const defTokens = estimateTokensFromBytes(35_000);
    expect(out.savings.realized.estTokens).toBe(defTokens * 3);
    expect(out.savings.byServer).toEqual([
      expect.objectContaining({ server: 'github', estTokens: defTokens * 3, requests: 3 }),
    ]);
    // No tool_calls seeded → 0 sessions → only the cache-read component.
    const expectedUsd =
      ((defTokens * 3) / 1_000_000) * getBaseInputPricePerMillion('claude-sonnet-4-6') * 0.1;
    expect(out.savings.realized.estUsd).toBeCloseTo(expectedUsd, 10);
  });

  it('subtracts requests that still carried the definitions (migration day, drift)', () => {
    writeClaudeJson({ mcpServers: {} });
    const DAY = 24 * 60 * 60 * 1000;
    const migratedAt = Date.now() - 5 * DAY;
    // Post-migration day: 4 requests total, but 1 still carried the
    // definitions (e.g. fired before the restart picked up the migration).
    store.enqueue({
      ts: Date.now() - DAY,
      accountId: 'a1',
      perServer: [{ server: 'github', defBytes: 35_000, toolCount: 43, toolNames: [] }],
      nativeBytes: 9_000,
      nativeToolCount: 12,
    });
    for (let i = 0; i < 3; i++) {
      store.enqueue({
        ts: Date.now() - DAY + 1000 + i,
        accountId: 'a1',
        perServer: [],
        nativeBytes: 9_000,
        nativeToolCount: 12,
      });
    }
    store.flush();
    const out = build([
      { server: 'github', scope: 'user', directory: null, originalEntry: {}, migratedAt },
    ]);
    // 4 native requests since migration, 1 still carried defs → 3 saved.
    expect(out.savings.byServer[0]?.requests).toBe(3);
  });

  it('reports zero realized savings for a bridge with no measured history', () => {
    writeClaudeJson({ mcpServers: {} });
    const out = build([
      { server: 'ghosty', scope: 'user', directory: null, originalEntry: {}, migratedAt: 1 },
    ]);
    expect(out.savings.realized).toEqual({ estTokens: 0, estUsd: 0 });
    expect(out.savings.byServer).toEqual([
      { server: 'ghosty', estTokens: 0, estUsd: 0, requests: 0 },
    ]);
  });

  it('sums potential from code-mode-recommended servers only (bytes actually carried)', () => {
    writeClaudeJson({ mcpServers: { heavy: {}, light: {} } });
    // heavy qualifies for the code-mode badge and carried defs on 2 requests.
    seedMeasured('heavy', 35_000, ['mcp__heavy__a']);
    seedMeasured('heavy', 35_000, ['mcp__heavy__a']);
    // light is below the badge threshold: excluded from potential.
    seedMeasured('light', 350, ['mcp__light__a']);
    const out = build();
    expect(out.savings.potential.estTokens).toBe(estimateTokensFromBytes(70_000));
    expect(out.savings.potential.estUsd).toBeGreaterThan(0);
    expect(out.savings.realized.estTokens).toBe(0);
  });

  it('sorts insights by definition tokens descending', () => {
    writeClaudeJson({ mcpServers: { small: {}, big: {} } });
    seedMeasured('small', 1_000, ['mcp__small__a']);
    seedMeasured('big', 50_000, ['mcp__big__a']);
    const out = build();
    const order = out.insights.map((i) => i.server);
    expect(order.indexOf('big')).toBeLessThan(order.indexOf('small'));
  });

  it('handles a missing claude.json: measured-only servers still appear, enabled', () => {
    // No claude.json written.
    seedMeasured('ghosty', 5_000, ['mcp__ghosty__t']);
    const out = build();
    const g = out.insights.find((i) => i.server === 'ghosty');
    expect(g?.enabled).toBe(true);
    expect(g?.projects).toEqual([]);
    expect(g?.global).toBe(false);
  });
});
