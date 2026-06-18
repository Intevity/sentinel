import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type Database from 'better-sqlite3';
import { estimateTokensFromBytes, type CodeModeMigration } from '@sentinel/shared';
import { getDb, closeDb, insertToolCall } from '../db.js';
import { ContextCostStore } from './context-cost-db.js';
import {
  buildMcpContextInsights,
  sanitizeServerName,
  backfillMigrationBaselines,
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
    process.env['SENTINEL_TEST_DB_FILE'] = dbPath;
    db = getDb(dbPath);
    db.exec('DELETE FROM tool_calls');

    storePath = join(tmpdir(), `sentinel-insights-cost-${stamp()}.db`);
    store = new ContextCostStore({ dbPath: storePath });

    claudeJsonPath = join(tmpdir(), `sentinel-insights-claude-${stamp()}.json`);
    process.env['SENTINEL_TEST_CLAUDE_JSON'] = claudeJsonPath;
  });

  afterEach(() => {
    closeDb();
    store.close();
    delete process.env['SENTINEL_TEST_DB_FILE'];
    delete process.env['SENTINEL_TEST_CLAUDE_JSON'];
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
      {
        server: 'github',
        scope: 'user',
        directory: null,
        originalEntry: {},
        migratedAt,
        // Baseline snapshot at migration: the one pre-migration request had
        // already been observed for both native and github.
        baselineNativeRequests: 1,
        baselineServerRequests: 1,
      },
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
      {
        server: 'github',
        scope: 'user',
        directory: null,
        originalEntry: {},
        migratedAt,
        // No traffic preceded the migration, so the baseline is zero.
        baselineNativeRequests: 0,
        baselineServerRequests: 0,
      },
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

  it('detects .mcp.json project-scope servers: original name, mcpJsonProjects, managed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-insights-mcpjson-'));
    try {
      writeFileSync(
        join(dir, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'team-memory': { command: 'x' } } }),
      );
      writeClaudeJson({ projects: { [dir]: {} } });
      seedMeasured('team-memory', 8_000, ['mcp__team-memory__recall']);
      const out = build();
      const row = out.insights.find((i) => i.server === 'team-memory');
      expect(row?.managed).toBe(true);
      expect(row?.mcpJsonProjects).toEqual([dir]);
      expect(row?.projects).toEqual([]);
      expect(row?.enabled).toBe(true);
      expect(row?.definition.measured).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a .mcp.json with no mcpServers key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-insights-mcpjson-empty-'));
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ unrelated: true }));
      writeClaudeJson({ projects: { [dir]: {} } });
      const out = build();
      expect(out.insights).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks measured-only servers unmanaged and never recommends code-mode for them', () => {
    // Plugin-provided server shape: heavy definitions, low usage, but no
    // config entry anywhere Sentinel can disable — bridging it would
    // double-load the definitions.
    writeClaudeJson({ mcpServers: {} });
    seedMeasured('plugin_mongodb_mongodb', 70_000, ['mcp__plugin_mongodb_mongodb__find']);
    const out = build();
    const row = out.insights.find((i) => i.server === 'plugin_mongodb_mongodb');
    expect(row?.managed).toBe(false);
    expect(row?.mcpJsonProjects).toEqual([]);
    expect(row?.recommendations.map((r) => r.kind)).not.toContain('code-mode');
    // ...and it contributes nothing to potential savings.
    expect(out.savings.potential.estTokens).toBe(0);
  });

  it('keeps a user-scope stash-disabled server visible: managed, global, disabled badge', () => {
    // A plain Disable at user scope removes the entry from ~/.claude.json
    // outright; only the stash proves it exists and is restorable.
    writeClaudeJson({ mcpServers: {} });
    seedMeasured('github', 35_000, ['mcp__github__search_code']);
    const out = buildMcpContextInsights({
      db,
      contextStore: store,
      migrations: [],
      disabledStashes: [
        { server: 'github', scope: 'user', directory: null, originalEntry: {}, migratedAt: 1 },
      ],
    });
    const gh = out.insights.find((i) => i.server === 'github');
    expect(gh?.managed).toBe(true);
    expect(gh?.global).toBe(true);
    expect(gh?.enabled).toBe(false);
    expect(gh?.recommendations.map((r) => r.kind)).toEqual(['disabled']);
  });

  it('surfaces a project-scope stash in mcpJsonProjects so Enable targets the right scope', () => {
    writeClaudeJson({ projects: { '/repo': {} } });
    const out = buildMcpContextInsights({
      db,
      contextStore: store,
      migrations: [],
      disabledStashes: [
        {
          server: 'team-memory',
          scope: 'project',
          directory: '/repo',
          originalEntry: {},
          migratedAt: 1,
        },
      ],
    });
    const row = out.insights.find((i) => i.server === 'team-memory');
    expect(row?.managed).toBe(true);
    expect(row?.mcpJsonProjects).toEqual(['/repo']);
    expect(row?.projects).toEqual([]);
    expect(row?.enabled).toBe(false);
    expect(row?.recommendations.map((r) => r.kind)).toEqual(['disabled']);
  });

  it('bridged servers stay managed even with no surviving config entry', () => {
    writeClaudeJson({ mcpServers: {} });
    const out = build([
      { server: 'github', scope: 'user', directory: null, originalEntry: {}, migratedAt: 1 },
    ]);
    const gh = out.insights.find((i) => i.server === 'github');
    expect(gh?.bridgeStatus).toBe('bridged');
    expect(gh?.managed).toBe(true);
  });

  it('counts zero realized requests right after a same-day mid-day bridge', () => {
    // Regression: bridging mid-day must not credit the whole day's bucket of
    // pre-migration native traffic (the bogus "~1200 requests" the user saw).
    writeClaudeJson({ mcpServers: {} });
    const now = Date.now();
    // One earlier-today request carried github defs (sets defBytesMax) ...
    store.enqueue({
      ts: now,
      accountId: 'a1',
      perServer: [{ server: 'github', defBytes: 35_000, toolCount: 5, toolNames: [] }],
      nativeBytes: 9_000,
      nativeToolCount: 12,
    });
    // ... plus heavy native-only traffic earlier today, before bridging.
    for (let i = 0; i < 4; i++) {
      store.enqueue({
        ts: now,
        accountId: 'a1',
        perServer: [],
        nativeBytes: 9_000,
        nativeToolCount: 12,
      });
    }
    store.flush();
    // Bridge NOW: baseline = the counts just observed (native 5, github 1).
    const migration: CodeModeMigration = {
      server: 'github',
      scope: 'user',
      directory: null,
      originalEntry: {},
      migratedAt: now,
      baselineNativeRequests: 5,
      baselineServerRequests: 1,
    };
    const out = build([migration]);
    expect(out.savings.byServer[0]?.requests).toBe(0);
    expect(out.savings.realized.estTokens).toBe(0);

    // A genuine post-migration request increments the count by exactly one.
    store.enqueue({
      ts: now + 1000,
      accountId: 'a1',
      perServer: [],
      nativeBytes: 9_000,
      nativeToolCount: 12,
    });
    store.flush();
    expect(build([migration]).savings.byServer[0]?.requests).toBe(1);
  });

  it('defaults a baseline-less legacy migration to zero, never an inflated count', () => {
    writeClaudeJson({ mcpServers: {} });
    const now = Date.now();
    store.enqueue({
      ts: now,
      accountId: 'a1',
      perServer: [{ server: 'github', defBytes: 35_000, toolCount: 5, toolNames: [] }],
      nativeBytes: 9_000,
      nativeToolCount: 12,
    });
    for (let i = 0; i < 3; i++) {
      store.enqueue({
        ts: now,
        accountId: 'a1',
        perServer: [],
        nativeBytes: 9_000,
        nativeToolCount: 12,
      });
    }
    store.flush();
    // No baseline fields → defaults to the current counts → zero saved so far.
    const out = build([
      { server: 'github', scope: 'user', directory: null, originalEntry: {}, migratedAt: now },
    ]);
    expect(out.savings.byServer[0]?.requests).toBe(0);
  });

  it('uses the day-bucketed window count when the window starts after the migration', () => {
    writeClaudeJson({ mcpServers: {} });
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    // Bridged 10 days ago; an old request set defBytesMax.
    store.enqueue({
      ts: now - 10 * DAY,
      accountId: 'a1',
      perServer: [{ server: 'github', defBytes: 35_000, toolCount: 5, toolNames: [] }],
      nativeBytes: 9_000,
      nativeToolCount: 12,
    });
    // In-window traffic (2 days ago): 1 still carried github + 3 native-only.
    store.enqueue({
      ts: now - 2 * DAY,
      accountId: 'a1',
      perServer: [{ server: 'github', defBytes: 35_000, toolCount: 5, toolNames: [] }],
      nativeBytes: 9_000,
      nativeToolCount: 12,
    });
    for (let i = 0; i < 3; i++) {
      store.enqueue({
        ts: now - 2 * DAY,
        accountId: 'a1',
        perServer: [],
        nativeBytes: 9_000,
        nativeToolCount: 12,
      });
    }
    store.flush();
    // Window opens 3 days ago, after the migration → day-bucketed path. The
    // baseline is present but deliberately ignored on this branch.
    const out = buildMcpContextInsights({
      db,
      contextStore: store,
      migrations: [
        {
          server: 'github',
          scope: 'user',
          directory: null,
          originalEntry: {},
          migratedAt: now - 10 * DAY,
          baselineNativeRequests: 0,
          baselineServerRequests: 0,
        },
      ],
      window: { sinceMs: now - 3 * DAY },
    });
    // In window: 4 native, 1 still carried → 3 saved.
    expect(out.savings.byServer[0]?.requests).toBe(3);
  });

  it('honors an explicit window end (untilMs) when counting from the baseline', () => {
    writeClaudeJson({ mcpServers: {} });
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    // Migrated a day ago, baseline native 1 / github 1 captured then.
    store.enqueue({
      ts: now - DAY,
      accountId: 'a1',
      perServer: [{ server: 'github', defBytes: 35_000, toolCount: 5, toolNames: [] }],
      nativeBytes: 9_000,
      nativeToolCount: 12,
    });
    for (let i = 0; i < 3; i++) {
      store.enqueue({
        ts: now - DAY + 1000 + i,
        accountId: 'a1',
        perServer: [],
        nativeBytes: 9_000,
        nativeToolCount: 12,
      });
    }
    store.flush();
    const out = buildMcpContextInsights({
      db,
      contextStore: store,
      migrations: [
        {
          server: 'github',
          scope: 'user',
          directory: null,
          originalEntry: {},
          migratedAt: now - DAY,
          baselineNativeRequests: 1,
          baselineServerRequests: 1,
        },
      ],
      window: { sinceMs: now - 5 * DAY, untilMs: now + 5 * DAY },
    });
    expect(out.savings.byServer[0]?.requests).toBe(3);
  });

  it('backfillMigrationBaselines fills missing baselines from current counts, idempotently', () => {
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      store.enqueue({
        ts: now,
        accountId: 'a1',
        perServer: [{ server: 'github', defBytes: 35_000, toolCount: 5, toolNames: [] }],
        nativeBytes: 9_000,
        nativeToolCount: 12,
      });
    }
    for (let i = 0; i < 5; i++) {
      store.enqueue({
        ts: now,
        accountId: 'a1',
        perServer: [],
        nativeBytes: 9_000,
        nativeToolCount: 12,
      });
    }
    store.flush();
    // Now: native requestCount = 7, github = 2.
    const migrations: CodeModeMigration[] = [
      { server: 'github', scope: 'user', directory: null, originalEntry: {}, migratedAt: 1 },
      {
        server: 'other',
        scope: 'user',
        directory: null,
        originalEntry: {},
        migratedAt: 1,
        baselineNativeRequests: 99,
        baselineServerRequests: 3,
      },
    ];
    const r = backfillMigrationBaselines(migrations, store);
    expect(r.changed).toBe(true);
    expect(r.migrations[0]?.baselineNativeRequests).toBe(7);
    expect(r.migrations[0]?.baselineServerRequests).toBe(2);
    // An existing baseline is preserved untouched.
    expect(r.migrations[1]?.baselineNativeRequests).toBe(99);
    // Idempotent: a second pass changes nothing and returns the same array.
    const r2 = backfillMigrationBaselines(r.migrations, store);
    expect(r2.changed).toBe(false);
    expect(r2.migrations).toBe(r.migrations);
  });
});
