/**
 * Unit: process-tree walking and the platform branches of reaping. The
 * signalling paths are exercised against REAL processes in
 * `mcp-client-manager.lifecycle.integration.test.ts`; this file covers the
 * parsing, the tree walk, and the branches that would otherwise need a
 * Windows box.
 */

import { describe, it, expect } from 'vitest';
import { parsePsSnapshot, listDescendants, reapPids, isAlive } from './process-tree.js';

describe('parsePsSnapshot', () => {
  it('parses pid/ppid pairs and skips anything that is not two integers', () => {
    const rows = parsePsSnapshot(
      ['  501   1', '1234 501', 'garbage line', '  PID  PPID', '', '  7 1234 '].join('\n'),
    );
    expect(rows).toEqual([
      [501, 1],
      [1234, 501],
      [7, 1234],
    ]);
  });
});

describe('listDescendants', () => {
  const snapshot: Array<[number, number]> = [
    [100, 1],
    [200, 100],
    [300, 200],
    [400, 100],
    [500, 999],
  ];

  it('walks the whole subtree, shallowest first, and excludes unrelated pids', async () => {
    expect(await listDescendants(100, { snapshot, platform: 'darwin' })).toEqual([200, 400, 300]);
  });

  it('returns an empty list for a leaf', async () => {
    expect(await listDescendants(300, { snapshot, platform: 'darwin' })).toEqual([]);
  });

  it('terminates on a cycle rather than looping forever', async () => {
    // A `ps` snapshot is taken while the tree mutates, so a pid appearing as
    // its own ancestor is representable even though the kernel forbids it.
    const cyclic: Array<[number, number]> = [
      [10, 20],
      [20, 10],
    ];
    expect(await listDescendants(10, { snapshot: cyclic, platform: 'darwin' })).toEqual([20]);
  });

  it('refuses unsafe pids instead of walking from init', async () => {
    expect(await listDescendants(1, { snapshot, platform: 'darwin' })).toEqual([]);
    expect(await listDescendants(0, { snapshot, platform: 'darwin' })).toEqual([]);
    expect(await listDescendants(-5, { snapshot, platform: 'darwin' })).toEqual([]);
  });

  it('walks the tree on Windows too, where a stranded grandchild is equally real', async () => {
    expect(await listDescendants(100, { snapshot, platform: 'win32' })).toEqual([200, 400, 300]);
  });

  it('queries the Windows process table when no snapshot is supplied', async () => {
    const calls: Array<[string, string[]]> = [];
    const exec = (file: string, args: string[]): Promise<string> => {
      calls.push([file, args]);
      return Promise.resolve('200 100\r\n300 200\r\n');
    };
    expect(await listDescendants(100, { platform: 'win32', exec })).toEqual([200, 300]);
    expect(calls[0]?.[0]).toBe('powershell');
  });

  it('degrades to an empty list when ps cannot be run', async () => {
    const failing = (): Promise<string> => Promise.reject(new Error('ps: command not found'));
    expect(await listDescendants(100, { platform: 'darwin', exec: failing })).toEqual([]);
  });

  it('shells out to ps when no snapshot is supplied', async () => {
    const calls: Array<[string, string[]]> = [];
    const exec = (file: string, args: string[]): Promise<string> => {
      calls.push([file, args]);
      return Promise.resolve('200 100\n300 200\n');
    };
    expect(await listDescendants(100, { platform: 'darwin', exec })).toEqual([200, 300]);
    expect(calls).toEqual([['ps', ['-eo', 'pid=,ppid=']]]);
  });
});

describe('reapPids', () => {
  it('refuses to signal our own process', async () => {
    // A stale or reused pid resolving to us would turn a cleanup into an
    // outage; this guard is the last line of defence.
    expect(await reapPids([process.pid])).toBe(0);
    expect(isAlive(process.pid)).toBe(true);
  });

  it('refuses to signal the process that launched us', async () => {
    // Under a test runner that parent supervises the workers — an earlier
    // revision of this code killed exactly those on CI.
    expect(await reapPids([4242], { self: 1000, parent: 4242 })).toBe(0);
  });

  it('reports nothing reaped for pids that are already dead', async () => {
    // 2^22 is above the default pid_max on macOS and Linux alike, so it can
    // never name a live process.
    expect(await reapPids([4194304])).toBe(0);
  });

  it('ignores pids that are never safe to signal', async () => {
    expect(await reapPids([0, 1, -1])).toBe(0);
  });
});

describe('isAlive', () => {
  it('is true for this very process and false for an impossible pid', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(4194304)).toBe(false);
  });

  it('rejects pids that are never safe to signal', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(1)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(1.5)).toBe(false);
  });
});
