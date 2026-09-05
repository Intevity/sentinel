/**
 * Pending-usage sweeper: commits staged rows whose OTEL claim never arrived.
 * The immediate startup tick is the restart-durability path — rows staged by
 * a previous daemon run commit the moment the sweeper starts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import type Database from 'better-sqlite3';
import {
  getDb,
  closeDb,
  getUsageEvents,
  getPendingUsageEvents,
  stagePendingUsageEvent,
} from './db.js';
import {
  startPendingUsageSweeper,
  PENDING_USAGE_GRACE_MS,
  type PendingUsageSweeperHandle,
} from './pending-usage-sweeper.js';
import { makeCapturingIpc, type CapturingIpcServer } from './proxy.test-helpers.js';

describe('pending-usage sweeper', () => {
  let dbPath: string;
  let db: Database.Database;
  let ipc: CapturingIpcServer;
  let sweeper: PendingUsageSweeperHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    dbPath = join(
      tmpdir(),
      `sentinel-sweeper-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = getDb(dbPath);
    ipc = makeCapturingIpc();
  });

  afterEach(() => {
    sweeper?.stop();
    sweeper = null;
    vi.useRealTimers();
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  function stage(requestId: string, stagedAt: number): void {
    stagePendingUsageEvent(db, {
      requestId,
      stagedAt,
      ts: stagedAt,
      accountId: 'acct-1',
      sessionId: null,
      model: 'claude-opus-4-7',
      costUsd: 0.05,
      inputTokens: 10,
      outputTokens: 1,
      cacheRead: null,
      cacheCreate: null,
      durationMs: 900,
    });
  }

  it('commits a stale row on the immediate startup tick (restart durability)', () => {
    const now = Date.now();
    // Staged 10 minutes ago by a "previous daemon run".
    stage('req_prev_run', now - 10 * 60_000);

    sweeper = startPendingUsageSweeper({ db, ipcServer: ipc, now: () => now });

    const events = getUsageEvents(db, {});
    expect(events).toHaveLength(1);
    expect(events[0]!.accountId).toBe('acct-1');
    expect(events[0]!.costUsd).toBe(0.05);
    expect(events[0]!.inputTokens).toBe(10);
    expect(getPendingUsageEvents(db)).toHaveLength(0);
    expect(ipc.broadcasts).toEqual([{ type: 'metrics_updated' }]);
  });

  it('leaves a fresh row pending until the grace window passes, then commits it', () => {
    let now = Date.now();
    stage('req_fresh', now);

    sweeper = startPendingUsageSweeper({
      db,
      ipcServer: ipc,
      intervalMs: 1_000,
      now: () => now,
    });
    // Startup tick: nothing stale, nothing broadcast.
    expect(getUsageEvents(db, {})).toHaveLength(0);
    expect(ipc.broadcasts).toEqual([]);

    // A few empty ticks inside the grace window.
    now += 30_000;
    vi.advanceTimersByTime(3_000);
    expect(getUsageEvents(db, {})).toHaveLength(0);

    // Past grace: the next tick commits and broadcasts exactly once.
    now += PENDING_USAGE_GRACE_MS;
    vi.advanceTimersByTime(1_000);
    expect(getUsageEvents(db, {})).toHaveLength(1);
    expect(getPendingUsageEvents(db)).toHaveLength(0);
    expect(ipc.broadcasts).toEqual([{ type: 'metrics_updated' }]);

    // Further ticks stay silent.
    vi.advanceTimersByTime(5_000);
    expect(ipc.broadcasts).toHaveLength(1);
  });

  it('stops sweeping after stop()', () => {
    let now = Date.now();
    sweeper = startPendingUsageSweeper({
      db,
      ipcServer: ipc,
      intervalMs: 1_000,
      now: () => now,
    });
    sweeper.stop();
    sweeper = null;

    stage('req_after_stop', now - 10 * 60_000);
    now += 60_000;
    vi.advanceTimersByTime(10_000);

    // No tick ran: the stale row is still pending.
    expect(getUsageEvents(db, {})).toHaveLength(0);
    expect(getPendingUsageEvents(db)).toHaveLength(1);
  });
});
