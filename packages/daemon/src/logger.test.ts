import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger, type Logger } from './logger.js';

describe('logger', () => {
  let dir: string;
  let logger: Logger | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-logger-'));
  });
  afterEach(async () => {
    if (logger) {
      await logger.shutdown();
      logger = null;
    }
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function make(
    opts: Partial<Parameters<typeof createLogger>[0]> = {},
  ): Logger {
    logger = createLogger({
      dir,
      // Tests use tiny sizes and faster flushes to exercise the codepaths
      // without slow timers or huge file writes.
      maxBytes: 1024,
      maxRotations: 3,
      ringBufferSize: 10,
      batchFlushMs: 5,
      maxBatchSize: 3,
      initialLevel: 'debug',
      now: () => 1700000000000,
      ...opts,
    });
    return logger;
  }

  describe('level filtering', () => {
    it('suppresses DEBUG when level is info', () => {
      const log = make({ initialLevel: 'info' });
      log.debug('hidden');
      log.info('visible');
      const history = log.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.level).toBe('info');
    });

    it('setLevel re-opens DEBUG emission live', () => {
      const log = make({ initialLevel: 'warn' });
      log.info('muffled');
      expect(log.getHistory()).toHaveLength(0);
      log.setLevel('debug');
      log.debug('now heard');
      expect(log.getHistory()).toHaveLength(1);
      expect(log.getLevel()).toBe('debug');
    });

    it('reports current level via getLevel', () => {
      const log = make({ initialLevel: 'error' });
      expect(log.getLevel()).toBe('error');
      log.setLevel('warn');
      expect(log.getLevel()).toBe('warn');
    });
  });

  describe('ring buffer', () => {
    it('keeps most-recent entries when capacity is exceeded', () => {
      const log = make({ ringBufferSize: 3 });
      log.info('a');
      log.info('b');
      log.info('c');
      log.info('d');
      log.info('e');
      const hist = log.getHistory();
      expect(hist.map((e) => e.message)).toEqual(['c', 'd', 'e']);
    });

    it('getHistory respects the limit argument', () => {
      const log = make();
      for (let i = 0; i < 5; i++) log.info(`n${i}`);
      expect(log.getHistory(2).map((e) => e.message)).toEqual(['n3', 'n4']);
    });

    it('entries carry monotonic seq', () => {
      const log = make();
      log.info('a');
      log.info('b');
      const [a, b] = log.getHistory();
      expect(b!.seq).toBe(a!.seq + 1);
    });
  });

  describe('tag extraction', () => {
    it('extracts a leading [Tag]', () => {
      const log = make();
      log.info('[OAuth] hello');
      expect(log.getHistory()[0]!.tag).toBe('OAuth');
    });

    it('returns null for messages without a bracket prefix', () => {
      const log = make();
      log.info('no tag here');
      expect(log.getHistory()[0]!.tag).toBeNull();
    });

    it('allows dot underscore dash digits in tags', () => {
      const log = make();
      log.info('[abc.def_1-2] x');
      expect(log.getHistory()[0]!.tag).toBe('abc.def_1-2');
    });

    it('rejects tags longer than 32 chars', () => {
      const log = make();
      log.info(`[${'x'.repeat(33)}] y`);
      expect(log.getHistory()[0]!.tag).toBeNull();
    });
  });

  describe('formatting', () => {
    it('joins multiple args with a space', () => {
      const log = make();
      log.info('user', 'id', 42);
      expect(log.getHistory()[0]!.message).toBe('user id 42');
    });

    it('appends Error.stack when an Error is passed', () => {
      const log = make();
      const err = new Error('boom');
      log.error('failed:', err);
      const msg = log.getHistory()[0]!.message;
      expect(msg).toContain('failed:');
      expect(msg).toContain('boom');
    });

    it('serializes plain objects via JSON', () => {
      const log = make();
      log.info({ a: 1 });
      expect(log.getHistory()[0]!.message).toBe('{"a":1}');
    });

    it('falls back to String() for unserializable values', () => {
      const log = make();
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      log.info(cyclic);
      // Either '[object Object]' or some String() fallback — just confirm it doesn't throw
      expect(log.getHistory()).toHaveLength(1);
    });
  });

  describe('file writing & rotation', () => {
    it('writes each entry to the log file', () => {
      const log = make();
      log.info('[T] hi');
      const body = readFileSync(join(dir, 'daemon.log'), 'utf-8');
      expect(body).toContain('INFO ');
      expect(body).toContain('[T] hi');
    });

    it('rotates when bytesWritten exceeds maxBytes', () => {
      const log = make({ maxBytes: 200 });
      for (let i = 0; i < 10; i++) log.info('x'.repeat(50));
      expect(existsSync(join(dir, 'daemon.log.1'))).toBe(true);
    });

    it('drops oldest rotation past maxRotations', () => {
      const log = make({ maxBytes: 100, maxRotations: 3 });
      for (let i = 0; i < 40; i++) log.info('x'.repeat(40));
      expect(existsSync(join(dir, 'daemon.log.3'))).toBe(true);
      expect(existsSync(join(dir, 'daemon.log.4'))).toBe(false);
    });

    it('reopens the base file after rotation', () => {
      const log = make({ maxBytes: 150 });
      for (let i = 0; i < 6; i++) log.info('y'.repeat(40));
      log.info('post-rotate');
      const body = readFileSync(join(dir, 'daemon.log'), 'utf-8');
      expect(body).toContain('post-rotate');
    });
  });

  describe('broadcast', () => {
    it('fires registered handlers with batched entries', async () => {
      const log = make({ maxBatchSize: 2, batchFlushMs: 50 });
      const batches: number[] = [];
      log.onBroadcast((entries) => batches.push(entries.length));
      log.info('a');
      log.info('b');
      // Size limit reached → flushes synchronously.
      expect(batches).toEqual([2]);
      log.info('c');
      await new Promise((r) => setTimeout(r, 70));
      expect(batches).toEqual([2, 1]);
    });

    it('swallows handler exceptions without breaking logging', () => {
      const log = make({ maxBatchSize: 1 });
      log.onBroadcast(() => {
        throw new Error('listener blew up');
      });
      expect(() => log.info('ok')).not.toThrow();
      expect(log.getHistory()).toHaveLength(1);
    });

    it('supports multiple registered handlers', () => {
      const log = make({ maxBatchSize: 1 });
      const a = vi.fn();
      const b = vi.fn();
      log.onBroadcast(a);
      log.onBroadcast(b);
      log.info('one');
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });
  });

  describe('clear', () => {
    it('returns the count of cleared entries and empties the buffer', () => {
      const log = make();
      log.info('a');
      log.info('b');
      log.info('c');
      const res = log.clear();
      expect(res.count).toBe(3);
      expect(log.getHistory()).toEqual([]);
    });

    it('flushes any pending broadcast batch so cleared entries are not broadcast after the fact', async () => {
      const log = make({ maxBatchSize: 10, batchFlushMs: 500 });
      const got: number[] = [];
      log.onBroadcast((e) => got.push(e.length));
      log.info('queued');
      // Pending batch of 1; not yet flushed.
      log.clear();
      await new Promise((r) => setTimeout(r, 50));
      // After clear, nothing further should be broadcast for the cleared entry.
      expect(got).toEqual([]);
    });

    it('truncates the file', () => {
      const log = make();
      log.info('before-clear');
      log.clear();
      const size = statSync(join(dir, 'daemon.log')).size;
      expect(size).toBe(0);
    });
  });

  describe('installConsolePatch', () => {
    it('routes console.log/warn/error through the logger', () => {
      const log = make({ initialLevel: 'debug' });
      const origLog = console.log;
      const origWarn = console.warn;
      const origError = console.error;
      log.installConsolePatch();
      try {
        console.log('via-log');
        console.warn('via-warn');
        console.error('via-error');
        const history = log.getHistory();
        const levels = history.map((e) => e.level);
        expect(levels).toEqual(expect.arrayContaining(['info', 'warn', 'error']));
      } finally {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
      }
    });

    it('is idempotent — second call is a no-op', () => {
      const log = make();
      const origLog = console.log;
      log.installConsolePatch();
      const patchedOnce = console.log;
      log.installConsolePatch();
      expect(console.log).toBe(patchedOnce);
      console.log = origLog;
    });
  });

  describe('shutdown', () => {
    it('flushes pending broadcast and closes the stream', async () => {
      const log = make({ maxBatchSize: 10, batchFlushMs: 1000 });
      const got: number[] = [];
      log.onBroadcast((e) => got.push(e.length));
      log.info('pending');
      await log.shutdown();
      expect(got).toEqual([1]);
      logger = null; // shutdown already closed it
    });
  });
});
