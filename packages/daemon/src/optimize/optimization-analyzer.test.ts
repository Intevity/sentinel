/**
 * Unit tests for the analyzer's core flow. Uses a real on-disk SQLite
 * (no mocks) and a stub IpcServer to capture broadcasts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getDb,
  closeDb,
  insertToolCall,
  upsertSubagentInstall,
  getOptimizationMetrics,
  listRecentOptimizationEvents,
} from '../db.js';
import { createOptimizationAnalyzer, scoreOpportunity } from './optimization-analyzer.js';
import type { IpcServer } from '../ipc.js';
import type { DaemonToAppMessage } from '@claude-sentinel/shared';

const TMP_DB = `/tmp/sentinel-analyzer-test-${process.pid}-${Date.now()}.db`;

function makeIpc(): IpcServer & { broadcasts: DaemonToAppMessage[] } {
  const broadcasts: DaemonToAppMessage[] = [];
  return {
    broadcasts,
    broadcast(m: DaemonToAppMessage) {
      broadcasts.push(m);
    },
    onMessage() {
      /* unused */
    },
    /* v8 ignore next 4 */
    start() {},
    close() {},
    connectedClients: 0,
  } as unknown as IpcServer & { broadcasts: DaemonToAppMessage[] };
}

function seedRead(
  db: Database.Database,
  args: {
    sessionId: string;
    accountId?: string;
    toolUseId: string;
    filePath: string;
    responseSizeBytes: number;
    wasQuoted?: boolean;
    ts?: number;
  },
): number {
  const id = insertToolCall(db, {
    ts: args.ts ?? Date.now(),
    accountId: args.accountId ?? 'a1',
    sessionId: args.sessionId,
    requestId: `req-${args.toolUseId}`,
    requestSeqInSession: 1,
    toolUseId: args.toolUseId,
    toolName: 'Read',
    filePath: args.filePath,
    inputSizeBytes: 50,
    responseSizeBytes: args.responseSizeBytes,
    denied: false,
    model: 'claude-opus-4-7',
  });
  if (args.wasQuoted !== undefined) {
    db.prepare('UPDATE tool_calls SET was_quoted_in_later_turn = ? WHERE id = ?').run(
      args.wasQuoted ? 1 : 0,
      id,
    );
  }
  return id;
}

describe('createOptimizationAnalyzer.runOnce', () => {
  let db: Database.Database;
  let ipc: ReturnType<typeof makeIpc>;

  beforeEach(() => {
    process.env['CLAUDE_SENTINEL_TEST_DB_FILE'] = TMP_DB;
    db = getDb(TMP_DB);
    db.exec(
      'DELETE FROM tool_calls; DELETE FROM optimization_events; DELETE FROM subagent_installs',
    );
    ipc = makeIpc();
  });
  afterEach(() => {
    closeDb();
    delete process.env['CLAUDE_SENTINEL_TEST_DB_FILE'];
    try {
      require('fs').unlinkSync(TMP_DB);
    } catch {
      /* ignore */
    }
  });

  it('writes a measured row when a heuristic fires', () => {
    seedRead(db, {
      sessionId: 'sess-A',
      toolUseId: 'toolu_1',
      filePath: '/big.log',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: ipc });
    const written = analyzer.runOnce();
    expect(written).toBe(1);
    const measured = listRecentOptimizationEvents(db, { kind: 'measured' });
    expect(measured).toHaveLength(1);
    expect(measured[0]?.curatedId).toBe('file-explorer');
    expect(measured[0]?.pattern).toBe('short_turn_after_large_read');
  });

  it('broadcasts optimization_metrics_updated when new rows are written', () => {
    seedRead(db, {
      sessionId: 'sess-B',
      toolUseId: 'toolu_b',
      filePath: '/other.log',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: ipc });
    analyzer.runOnce();
    expect(ipc.broadcasts.some((b) => b.type === 'optimization_metrics_updated')).toBe(true);
  });

  it('does not broadcast when no new rows are written', () => {
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: ipc });
    analyzer.runOnce();
    expect(ipc.broadcasts.some((b) => b.type === 'optimization_metrics_updated')).toBe(false);
  });

  it('dedups within the 7-day window', () => {
    seedRead(db, {
      sessionId: 'sess-C',
      toolUseId: 'toolu_c',
      filePath: '/dup.log',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: ipc });
    expect(analyzer.runOnce()).toBe(1);
    expect(analyzer.runOnce()).toBe(0); // second pass: dedup hits
    expect(listRecentOptimizationEvents(db, { kind: 'measured' })).toHaveLength(1);
  });

  it('produces a positive savings number on a fully-uncached Read', () => {
    seedRead(db, {
      sessionId: 'sess-pos',
      toolUseId: 'toolu_pos',
      filePath: '/big.log',
      responseSizeBytes: 60_000,
      wasQuoted: false,
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: ipc });
    analyzer.runOnce();
    const m = listRecentOptimizationEvents(db, { kind: 'measured' });
    expect(m[0]?.savingsUsd).not.toBeNull();
    expect(m[0]?.savingsUsd ?? 0).toBeGreaterThan(0);
  });

  it('skips sessions with no opportunity', () => {
    insertToolCall(db, {
      ts: Date.now(),
      accountId: 'a1',
      sessionId: 'sess-empty',
      requestId: 'r1',
      requestSeqInSession: 1,
      toolUseId: 'toolu_empty',
      toolName: 'Read',
      filePath: '/tiny.txt',
      inputSizeBytes: 10,
      responseSizeBytes: 100, // way below the 32 KB threshold
      denied: false,
      model: 'claude-opus-4-7',
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: ipc });
    expect(analyzer.runOnce()).toBe(0);
  });

  it('skips tool_calls without a session_id', () => {
    insertToolCall(db, {
      ts: Date.now(),
      accountId: 'a1',
      sessionId: null,
      requestId: 'r1',
      requestSeqInSession: 1,
      toolUseId: 'toolu_nosess',
      toolName: 'Read',
      filePath: '/x.log',
      inputSizeBytes: 10,
      responseSizeBytes: 100_000,
      denied: false,
      model: 'claude-opus-4-7',
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: ipc });
    expect(analyzer.runOnce()).toBe(0);
  });
});

describe('scoreOpportunity', () => {
  it('returns null when no source calls match the row set', () => {
    const r = scoreOpportunity(
      {
        curatedId: 'file-explorer',
        pattern: 'short_turn_after_large_read',
        sourceToolCallIds: [9999],
        totalResponseBytes: 1000,
      },
      [],
    );
    expect(r).toBeNull();
  });

  it('returns null when total response bytes is zero', () => {
    // Synthesize a single row with id=1 and zero responseSizeBytes.
    const r = scoreOpportunity(
      {
        curatedId: 'file-explorer',
        pattern: 'short_turn_after_large_read',
        sourceToolCallIds: [1],
        totalResponseBytes: 0,
      },
      [
        {
          id: 1,
          ts: 0,
          accountId: 'a',
          sessionId: 's',
          requestId: 'r',
          requestSeqInSession: 1,
          toolUseId: 'toolu',
          toolName: 'Read',
          filePath: '/x',
          inputSizeBytes: 0,
          responseSizeBytes: 0,
          wasQuotedInLaterTurn: null,
          denied: false,
          model: 'claude-opus-4-7',
          attributedInputTokens: null,
          attributedCachedTokens: null,
        },
      ],
    );
    expect(r).toBeNull();
  });
});

describe('getOptimizationMetrics — realized vs potential split', () => {
  let db: Database.Database;

  beforeEach(() => {
    process.env['CLAUDE_SENTINEL_TEST_DB_FILE'] = TMP_DB;
    db = getDb(TMP_DB);
    db.exec(
      'DELETE FROM tool_calls; DELETE FROM optimization_events; DELETE FROM subagent_installs',
    );
  });
  afterEach(() => {
    closeDb();
    delete process.env['CLAUDE_SENTINEL_TEST_DB_FILE'];
    try {
      require('fs').unlinkSync(TMP_DB);
    } catch {
      /* ignore */
    }
  });

  it('reports installs=N for active subagent_installs rows (the bug fix)', () => {
    upsertSubagentInstall(db, {
      name: 'file-explorer',
      source: 'curated',
      curatedId: 'file-explorer',
      gapFingerprint: 'fp1',
      mdPath: '/tmp/file-explorer.md',
      mdHash: 'h',
      installedAt: Date.now(),
    });
    upsertSubagentInstall(db, {
      name: 'log-analyzer',
      source: 'curated',
      curatedId: 'log-analyzer',
      gapFingerprint: 'fp2',
      mdPath: '/tmp/log-analyzer.md',
      mdHash: 'h',
      installedAt: Date.now(),
    });
    expect(getOptimizationMetrics(db).totals.installs).toBe(2);
  });

  it('does not count uninstalled rows', () => {
    upsertSubagentInstall(db, {
      name: 'gone',
      source: 'curated',
      curatedId: 'gone',
      gapFingerprint: 'fp',
      mdPath: '/tmp/gone.md',
      mdHash: 'h',
      installedAt: Date.now() - 1000,
    });
    db.prepare('UPDATE subagent_installs SET uninstalled_at = ? WHERE name = ?').run(
      Date.now(),
      'gone',
    );
    expect(getOptimizationMetrics(db).totals.installs).toBe(0);
  });

  it('buckets a measured row as realized when an active install covers its timestamp', () => {
    seedRead(db, {
      sessionId: 'sess-r',
      toolUseId: 'toolu_r',
      filePath: '/foo.log',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    // Install BEFORE the analyzer runs, so the analyzer's `ts` falls
    // inside the install window.
    upsertSubagentInstall(db, {
      name: 'file-explorer',
      source: 'curated',
      curatedId: 'file-explorer',
      gapFingerprint: 'fp',
      mdPath: '/tmp/file-explorer.md',
      mdHash: 'h',
      installedAt: Date.now() - 5000,
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: makeIpc() });
    analyzer.runOnce();

    const m = getOptimizationMetrics(db);
    expect(m.totals.savingsUsdRealized).toBeGreaterThan(0);
    expect(m.totals.savingsUsdPotential).toBe(0);
  });

  it('buckets as potential when no install covers the timestamp', () => {
    seedRead(db, {
      sessionId: 'sess-p',
      toolUseId: 'toolu_p',
      filePath: '/bar.log',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: makeIpc() });
    analyzer.runOnce();
    const m = getOptimizationMetrics(db);
    expect(m.totals.savingsUsdRealized).toBe(0);
    expect(m.totals.savingsUsdPotential).toBeGreaterThan(0);
  });

  it('builds a daily series sorted ascending by date', () => {
    seedRead(db, {
      sessionId: 'sess-day1',
      toolUseId: 'toolu_d1',
      filePath: '/one.log',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: makeIpc() });
    analyzer.runOnce();
    const m = getOptimizationMetrics(db);
    expect(m.daily.length).toBeGreaterThanOrEqual(1);
    const days = m.daily.map((d) => d.day);
    expect([...days].sort()).toEqual(days);
  });

  it('splits totals across curated_ids in bySubagent, with the right realized/potential bucket per row', () => {
    // Seed a Read opportunity (→ file-explorer) and a Bash log
    // opportunity (→ log-analyzer) in two distinct sessions. Install
    // file-explorer BEFORE the analyzer runs so its row is realized;
    // log-analyzer is uninstalled, so its row is potential.
    seedRead(db, {
      sessionId: 'sess-fe',
      toolUseId: 'toolu_fe',
      filePath: '/big.txt',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    insertToolCall(db, {
      ts: Date.now(),
      accountId: 'a1',
      sessionId: 'sess-la',
      requestId: 'req-la',
      requestSeqInSession: 1,
      toolUseId: 'toolu_la',
      toolName: 'Bash',
      filePath: 'cat /var/log/app.log',
      inputSizeBytes: 30,
      responseSizeBytes: 40_000,
      denied: false,
      model: 'claude-opus-4-7',
    });
    upsertSubagentInstall(db, {
      name: 'file-explorer',
      source: 'curated',
      curatedId: 'file-explorer',
      gapFingerprint: 'fp',
      mdPath: '/tmp/file-explorer.md',
      mdHash: 'h',
      installedAt: Date.now() - 5000,
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: makeIpc() });
    analyzer.runOnce();

    const m = getOptimizationMetrics(db);
    const ids = m.bySubagent.map((s) => s.curatedId).sort();
    expect(ids).toEqual(['file-explorer', 'log-analyzer']);

    const fe = m.bySubagent.find((s) => s.curatedId === 'file-explorer');
    expect(fe?.savingsRealized).toBeGreaterThan(0);
    expect(fe?.savingsPotential).toBe(0);
    expect(fe?.opportunities).toBe(1);

    const la = m.bySubagent.find((s) => s.curatedId === 'log-analyzer');
    expect(la?.savingsRealized).toBe(0);
    expect(la?.savingsPotential).toBeGreaterThan(0);
    expect(la?.opportunities).toBe(1);

    // Per-row sums match the headline totals exactly. This is the
    // cross-check that prevents drift between the dashboard's two
    // surfaces — header totals vs per-row badges.
    const sumRealized = m.bySubagent.reduce((s, x) => s + x.savingsRealized, 0);
    const sumPotential = m.bySubagent.reduce((s, x) => s + x.savingsPotential, 0);
    expect(sumRealized).toBeCloseTo(m.totals.savingsUsdRealized, 6);
    expect(sumPotential).toBeCloseTo(m.totals.savingsUsdPotential, 6);
  });

  it('sorts bySubagent by combined impact desc so the highest-impact row reads first', () => {
    // Two file-explorer opportunities (one large read, one repeat-read
    // pattern) plus one log-analyzer opportunity. file-explorer should
    // outweigh log-analyzer by aggregate.
    seedRead(db, {
      sessionId: 'sess-1',
      toolUseId: 'toolu_1',
      filePath: '/a.txt',
      responseSizeBytes: 80_000,
      wasQuoted: false,
    });
    seedRead(db, {
      sessionId: 'sess-2',
      toolUseId: 'toolu_2',
      filePath: '/b.txt',
      responseSizeBytes: 80_000,
      wasQuoted: false,
    });
    insertToolCall(db, {
      ts: Date.now(),
      accountId: 'a1',
      sessionId: 'sess-3',
      requestId: 'req-3',
      requestSeqInSession: 1,
      toolUseId: 'toolu_3',
      toolName: 'Bash',
      filePath: 'tail -f /var/log/app.log',
      inputSizeBytes: 30,
      responseSizeBytes: 20_000,
      denied: false,
      model: 'claude-opus-4-7',
    });
    const analyzer = createOptimizationAnalyzer({ db, ipcServer: makeIpc() });
    analyzer.runOnce();

    const m = getOptimizationMetrics(db);
    expect(m.bySubagent[0]?.curatedId).toBe('file-explorer');
    expect(m.bySubagent[1]?.curatedId).toBe('log-analyzer');
  });

  it('returns an empty bySubagent array on a fresh database', () => {
    const m = getOptimizationMetrics(db);
    expect(m.bySubagent).toEqual([]);
  });
});

describe('analyzer schedule', () => {
  it('start/stop is safe and idempotent', () => {
    const ipc = makeIpc();
    process.env['CLAUDE_SENTINEL_TEST_DB_FILE'] = TMP_DB;
    const db = getDb(TMP_DB);
    const analyzer = createOptimizationAnalyzer({
      db,
      ipcServer: ipc,
      intervalMs: 60_000,
    });
    analyzer.start();
    analyzer.start(); // double-start is a no-op
    analyzer.stop();
    analyzer.stop(); // double-stop is a no-op
    closeDb();
    delete process.env['CLAUDE_SENTINEL_TEST_DB_FILE'];
    try {
      require('fs').unlinkSync(TMP_DB);
    } catch {
      /* ignore */
    }
  });

  it('start fires the interval callback, which runs runOnce', async () => {
    process.env['CLAUDE_SENTINEL_TEST_DB_FILE'] = TMP_DB;
    const db = getDb(TMP_DB);
    db.exec('DELETE FROM tool_calls; DELETE FROM optimization_events');
    const ipc = makeIpc();
    seedRead(db, {
      sessionId: 'sess-tick',
      toolUseId: 'toolu_tick',
      filePath: '/tick.log',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    // 5ms interval — the test waits 25ms so we're guaranteed to see at
    // least one tick fire. Real production interval is 5min.
    const analyzer = createOptimizationAnalyzer({
      db,
      ipcServer: ipc,
      intervalMs: 5,
    });
    analyzer.start();
    await new Promise((r) => setTimeout(r, 30));
    analyzer.stop();
    expect(ipc.broadcasts.some((b) => b.type === 'optimization_metrics_updated')).toBe(true);
    closeDb();
    delete process.env['CLAUDE_SENTINEL_TEST_DB_FILE'];
    try {
      require('fs').unlinkSync(TMP_DB);
    } catch {
      /* ignore */
    }
  });
});

describe('analyzer scheduleRun (debounced trigger)', () => {
  let db: Database.Database;
  let ipc: ReturnType<typeof makeIpc>;

  beforeEach(() => {
    process.env['CLAUDE_SENTINEL_TEST_DB_FILE'] = TMP_DB;
    db = getDb(TMP_DB);
    db.exec(
      'DELETE FROM tool_calls; DELETE FROM optimization_events; DELETE FROM subagent_installs',
    );
    ipc = makeIpc();
  });
  afterEach(() => {
    closeDb();
    delete process.env['CLAUDE_SENTINEL_TEST_DB_FILE'];
    try {
      require('fs').unlinkSync(TMP_DB);
    } catch {
      /* ignore */
    }
  });

  it('coalesces a burst of scheduleRun calls into a single runOnce', async () => {
    seedRead(db, {
      sessionId: 'sess-burst',
      toolUseId: 'toolu_burst',
      filePath: '/burst.log',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    const analyzer = createOptimizationAnalyzer({
      db,
      ipcServer: ipc,
      // No periodic interval so we can attribute every broadcast to scheduleRun.
      intervalMs: 60_000_000,
      debounceMs: 30,
    });
    analyzer.start();
    // 5 rapid calls within the debounce window.
    for (let i = 0; i < 5; i++) analyzer.scheduleRun();
    // Wait past the debounce; runOnce should fire exactly once.
    await new Promise((r) => setTimeout(r, 80));
    analyzer.stop();
    const measured = listRecentOptimizationEvents(db, { kind: 'measured' });
    // Heuristic dedup means we'd never get more than one row anyway, but
    // the broadcast count is the cleaner real-time signal:
    const broadcasts = ipc.broadcasts.filter((b) => b.type === 'optimization_metrics_updated');
    expect(broadcasts.length).toBe(1);
    expect(measured.length).toBe(1);
  });

  it('stop cancels a pending debounced runOnce', async () => {
    seedRead(db, {
      sessionId: 'sess-cancel',
      toolUseId: 'toolu_cancel',
      filePath: '/cancel.log',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    const analyzer = createOptimizationAnalyzer({
      db,
      ipcServer: ipc,
      intervalMs: 60_000_000,
      debounceMs: 100,
    });
    analyzer.start();
    analyzer.scheduleRun();
    analyzer.stop(); // cancel before debounce expires
    await new Promise((r) => setTimeout(r, 200));
    expect(ipc.broadcasts.some((b) => b.type === 'optimization_metrics_updated')).toBe(false);
    expect(listRecentOptimizationEvents(db, { kind: 'measured' })).toHaveLength(0);
  });

  it('a second scheduleRun pushes the deadline forward', async () => {
    seedRead(db, {
      sessionId: 'sess-push',
      toolUseId: 'toolu_push',
      filePath: '/push.log',
      responseSizeBytes: 50_000,
      wasQuoted: false,
    });
    const analyzer = createOptimizationAnalyzer({
      db,
      ipcServer: ipc,
      intervalMs: 60_000_000,
      debounceMs: 60,
    });
    analyzer.start();
    analyzer.scheduleRun();
    // Fire another schedule before the first deadline; first timer
    // should be cleared and a new one started.
    await new Promise((r) => setTimeout(r, 30));
    analyzer.scheduleRun();
    // After the FIRST original deadline (60ms total) but before the
    // SECOND deadline (90ms total), no broadcast yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(ipc.broadcasts.some((b) => b.type === 'optimization_metrics_updated')).toBe(false);
    // After the second deadline expires, exactly one broadcast.
    await new Promise((r) => setTimeout(r, 80));
    expect(ipc.broadcasts.filter((b) => b.type === 'optimization_metrics_updated')).toHaveLength(1);
    analyzer.stop();
  });
});
