import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, rmSync } from 'fs';
import type { IpcServer } from '../ipc.js';
import {
  ContextCostStore,
  getContextCostStore,
  closeContextCostStore,
  localDay,
  NATIVE_SERVER_KEY,
  type ContextCostEventRecord,
} from './context-cost-db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpPath(prefix: string): string {
  return join(
    tmpdir(),
    `sentinel-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function rmDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }
}

function record(over: Partial<ContextCostEventRecord> = {}): ContextCostEventRecord {
  return {
    ts: Date.now(),
    accountId: 'acc-1',
    perServer: [
      {
        server: 'github',
        defBytes: 35000,
        toolCount: 43,
        toolNames: ['mcp__github__search_code', 'mcp__github__list_issues'],
      },
    ],
    nativeBytes: 57000,
    nativeToolCount: 18,
    ...over,
  };
}

describe('ContextCostStore upserts', () => {
  let dbPath: string;
  let store: ContextCostStore;

  beforeEach(() => {
    dbPath = tmpPath('context-cost');
    store = new ContextCostStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    rmDb(dbPath);
  });

  it('upserts two same-day requests into one row with request_count=2, MAX bytes, freshest names', () => {
    const ts = Date.now();
    store.enqueue(record({ ts })); // default github slice: 35000 bytes, 43 tools
    store.enqueue(record({ ts: ts + 1000, perServer: [serverSlice('github', 36000, 44)] }));
    const aggs = store.getServerDefinitionCosts();
    const gh = aggs.find((a) => a.server === 'github');
    expect(gh).toEqual({
      server: 'github',
      defBytesMax: 36000,
      // SUM across both requests: the exact bytes carried over the window.
      defBytesSum: 71000,
      toolCountMax: 44,
      requestCount: 2,
      lastSeenMs: ts + 1000,
      // last_tool_names refreshes to the most recent request's sample.
      toolNames: ['mcp__github__tool'],
    });
  });

  it('folds native definitions into the reserved __native__ row', () => {
    store.enqueue(record({ nativeBytes: 57000, nativeToolCount: 18 }));
    const native = store.getServerDefinitionCosts().find((a) => a.server === NATIVE_SERVER_KEY);
    expect(native?.defBytesMax).toBe(57000);
    expect(native?.toolCountMax).toBe(18);
    expect(native?.requestCount).toBe(1);
    expect(native?.toolNames).toEqual([]);
  });

  it('skips the native row when the request carried no native tools', () => {
    store.enqueue(record({ nativeBytes: 0, nativeToolCount: 0 }));
    const servers = store.getServerDefinitionCosts().map((a) => a.server);
    expect(servers).toEqual(['github']);
  });

  it('caps the stored tool-name sample at 50 names', () => {
    const names = Array.from({ length: 80 }, (_, i) => `mcp__big__tool_${i}`);
    store.enqueue(
      record({
        perServer: [{ server: 'big', defBytes: 100, toolCount: 80, toolNames: names }],
      }),
    );
    const big = store.getServerDefinitionCosts().find((a) => a.server === 'big');
    expect(big?.toolNames).toHaveLength(50);
    expect(big?.toolNames[0]).toBe('mcp__big__tool_0');
    expect(big?.toolNames[49]).toBe('mcp__big__tool_49');
  });

  it('separates rows per account and aggregates across them in queries', () => {
    const ts = Date.now();
    store.enqueue(record({ ts, accountId: 'acc-1', perServer: [serverSlice('s', 100, 1)] }));
    store.enqueue(record({ ts, accountId: 'acc-2', perServer: [serverSlice('s', 200, 2)] }));
    const s = store.getServerDefinitionCosts().find((a) => a.server === 's');
    expect(s?.requestCount).toBe(2);
    expect(s?.defBytesMax).toBe(200);
  });

  it('windows by local day: a sinceMs after a row’s day excludes it', () => {
    const old = Date.now() - 10 * DAY_MS;
    const now = Date.now();
    store.enqueue(record({ ts: old, perServer: [serverSlice('old-server', 500, 5)] }));
    store.enqueue(record({ ts: now, perServer: [serverSlice('new-server', 900, 9)] }));
    const all = store.getServerDefinitionCosts();
    expect(all.map((a) => a.server).sort()).toContain('old-server');
    const recent = store.getServerDefinitionCosts({ sinceMs: now - DAY_MS });
    expect(recent.map((a) => a.server)).not.toContain('old-server');
    expect(recent.map((a) => a.server)).toContain('new-server');
    // untilMs is exclusive but day-granular: a window ending before the old
    // row's day excludes the new one.
    const oldOnly = store.getServerDefinitionCosts({ untilMs: old + DAY_MS });
    expect(oldOnly.map((a) => a.server)).toContain('old-server');
    expect(oldOnly.map((a) => a.server)).not.toContain('new-server');
  });

  it('purgeOlderThan deletes stale rows and keeps current ones', () => {
    const old = Date.now() - 10 * DAY_MS;
    store.enqueue(record({ ts: old, perServer: [serverSlice('stale', 1, 1)] }));
    store.enqueue(record({ ts: Date.now(), perServer: [serverSlice('fresh', 2, 1)] }));
    store.flush();
    const deleted = store.purgeOlderThan(Date.now() - 7 * DAY_MS);
    // The stale server row AND its same-record __native__ row both purge.
    expect(deleted).toBe(2);
    const servers = store.getServerDefinitionCosts().map((a) => a.server);
    expect(servers).not.toContain('stale');
    expect(servers).toContain('fresh');
    expect(store.purgeOlderThan(0)).toBe(0); // nothing left to purge
  });

  it('clearAll empties both tables and the queue', () => {
    store.enqueue(record());
    store.recordCall({
      ts: Date.now(),
      server: 's',
      tool: 't',
      ok: true,
      bytesOut: 10,
      durationMs: 5,
    });
    store.flush();
    expect(store.clearAll()).toBeGreaterThan(0);
    expect(store.getServerDefinitionCosts()).toEqual([]);
    expect(store.getAudit()).toEqual([]);
  });

  it('enqueue after close is a no-op', () => {
    store.close();
    store.enqueue(record());
    // No throw; nothing to assert beyond construction safety on a closed DB.
    expect(() => store.close()).not.toThrow();
    // Re-open at the same path to confirm nothing was written.
    const reopened = new ContextCostStore({ dbPath });
    expect(reopened.getServerDefinitionCosts()).toEqual([]);
    reopened.close();
  });
});

describe('ContextCostStore audit', () => {
  let dbPath: string;
  let store: ContextCostStore;

  beforeEach(() => {
    dbPath = tmpPath('context-cost-audit');
    store = new ContextCostStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    rmDb(dbPath);
  });

  it('records calls and returns them newest first with exact shapes', () => {
    store.recordCall({
      ts: 1000,
      server: 'github',
      tool: 'search_code',
      ok: true,
      bytesOut: 2048,
      durationMs: 120,
    });
    store.recordCall({
      ts: 2000,
      server: 'github',
      tool: 'get_file_contents',
      ok: false,
      bytesOut: 0,
      durationMs: 30,
    });
    expect(store.getAudit()).toEqual([
      {
        ts: 2000,
        server: 'github',
        tool: 'get_file_contents',
        ok: false,
        bytesOut: 0,
        durationMs: 30,
      },
      {
        ts: 1000,
        server: 'github',
        tool: 'search_code',
        ok: true,
        bytesOut: 2048,
        durationMs: 120,
      },
    ]);
  });

  it('honors window bounds and clamps limit to [1, 500]', () => {
    for (let i = 0; i < 5; i++) {
      store.recordCall({
        ts: 1000 + i,
        server: 's',
        tool: `t${i}`,
        ok: true,
        bytesOut: i,
        durationMs: i,
      });
    }
    expect(store.getAudit({ sinceMs: 1002 })).toHaveLength(3);
    expect(store.getAudit({ untilMs: 1002 })).toHaveLength(2); // exclusive upper bound
    expect(store.getAudit({}, 0)).toHaveLength(1); // clamped up to 1
    expect(store.getAudit({}, 2)).toHaveLength(2);
  });

  it('recordCall after close is a no-op', () => {
    store.close();
    expect(() =>
      store.recordCall({ ts: 1, server: 's', tool: 't', ok: true, bytesOut: 0, durationMs: 0 }),
    ).not.toThrow();
    const reopened = new ContextCostStore({ dbPath });
    expect(reopened.getAudit()).toEqual([]);
    reopened.close();
  });
});

describe('ContextCostStore broadcasts', () => {
  let dbPath: string;
  let store: ContextCostStore;
  // Plain recording closure instead of a vitest stub: keeps the mock budget
  // flat while asserting the same call count + payload.
  let broadcasts: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    dbPath = tmpPath('context-cost-bcast');
    broadcasts = [];
    const captured = broadcasts;
    store = new ContextCostStore({
      dbPath,
      ipcServer: {
        broadcast: (msg: unknown) => {
          captured.push(msg);
        },
      } as unknown as IpcServer,
    });
  });

  afterEach(() => {
    store.close();
    rmDb(dbPath);
    vi.useRealTimers();
  });

  it('fires one debounced mcp_context_costs_updated after a committed flush', () => {
    store.enqueue(record());
    vi.advanceTimersByTime(100); // flush timer
    expect(broadcasts).toHaveLength(0); // still debouncing
    vi.advanceTimersByTime(1500);
    expect(broadcasts).toEqual([{ type: 'mcp_context_costs_updated' }]);
  });

  it('does not broadcast when a flush commits nothing', () => {
    store.enqueue(
      record({ perServer: [], nativeBytes: 0, nativeToolCount: 0 }), // nothing to upsert
    );
    vi.advanceTimersByTime(2000);
    expect(broadcasts).toHaveLength(0);
  });

  it('coalesces broadcasts across back-to-back flushes', () => {
    store.enqueue(record());
    vi.advanceTimersByTime(100);
    store.enqueue(record());
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(1500);
    expect(broadcasts).toHaveLength(1);
  });

  it('cancels a pending broadcast on close', () => {
    store.enqueue(record());
    vi.advanceTimersByTime(100);
    store.close();
    vi.advanceTimersByTime(5000);
    expect(broadcasts).toHaveLength(0);
  });
});

describe('singleton accessor + env seam', () => {
  const envKey = 'CLAUDE_SENTINEL_TEST_CONTEXT_COST_DB_FILE';
  let envPath: string;

  beforeEach(() => {
    envPath = tmpPath('context-cost-env');
    process.env[envKey] = envPath;
  });

  afterEach(() => {
    closeContextCostStore();
    delete process.env[envKey];
    rmDb(envPath);
  });

  it('getContextCostStore returns one instance and honors the env seam', () => {
    const a = getContextCostStore();
    const b = getContextCostStore();
    expect(a).toBe(b);
    a.enqueue(record());
    a.flush();
    expect(existsSync(envPath)).toBe(true);
    closeContextCostStore();
    // A fresh singleton re-opens the same env-pointed file and sees the row.
    const c = getContextCostStore();
    expect(c.getServerDefinitionCosts().map((r) => r.server)).toContain('github');
  });
});

describe('localDay', () => {
  it('formats local-midnight day buckets with zero padding', () => {
    // 2026-01-05T08:09:10 local
    const d = new Date(2026, 0, 5, 8, 9, 10);
    expect(localDay(d.getTime())).toBe('2026-01-05');
  });
});

function serverSlice(
  server: string,
  defBytes: number,
  toolCount: number,
): ContextCostEventRecord['perServer'][number] {
  return {
    server,
    defBytes,
    toolCount,
    toolNames: [`mcp__${server}__tool`],
  };
}
