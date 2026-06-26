import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import type { Database } from 'better-sqlite3';
import type { IsolationPolicy } from '@sentinel/shared';
import { getDb, closeDb } from '../../db.js';
import {
  createSandboxSyncEngine,
  formatSyncError,
  type SandboxSyncEngine,
} from './sandbox-sync.js';
import type { IpcServer } from '../../ipc.js';

/** Minimal IpcServer stub — the engine only calls `broadcast`. */
function makeIpcStub(): IpcServer {
  return {
    start: () => {},
    stop: () => {},
    broadcast: () => {},
  } as unknown as IpcServer;
}

function tmpRoot(): string {
  return join(
    tmpdir(),
    `sentinel-sandbox-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function basePolicy(overrides: Partial<IsolationPolicy> = {}): IsolationPolicy {
  return {
    enabled: true,
    syncToClaudeCode: true,
    enforceCodeMode: false,
    network: { allowedDomains: ['example.com'], deniedDomains: [] },
    filesystem: { allowWrite: ['~/.kube'], denyWrite: [], denyRead: [], allowRead: [] },
    credentials: { files: [], envVars: [] },
    ...overrides,
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function readSandbox(path: string): Record<string, unknown> {
  return readJson(path)['sandbox'] as Record<string, unknown>;
}

async function waitFor(pred: () => boolean, timeoutMs = 2500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe('sandbox-sync', () => {
  let root: string;
  let settingsPath: string;
  let db: Database;
  let engine: SandboxSyncEngine;
  let policy: IsolationPolicy;

  beforeEach(() => {
    root = tmpRoot();
    mkdirSync(root, { recursive: true });
    settingsPath = join(root, 'settings.json');
    db = getDb(join(root, 'sentinel.db'));
    policy = basePolicy();
    engine = createSandboxSyncEngine({
      db,
      ipcServer: makeIpcStub(),
      getPolicy: () => policy,
      setPolicy: (p) => {
        policy = p;
      },
      settingsPath,
    });
  });

  afterEach(() => {
    engine.stop();
    closeDb();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  describe('pushNow', () => {
    it('writes a complete sandbox block and preserves other top-level keys', async () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] } }, null, 2),
      );
      policy = basePolicy({
        network: { allowedDomains: ['b.com', 'a.com'], deniedDomains: ['evil.test'] },
        filesystem: {
          allowWrite: ['/srv', '/opt'],
          denyWrite: [],
          denyRead: ['~/'],
          allowRead: ['.'],
        },
        credentials: { files: ['~/.ssh'], envVars: ['TOKEN'] },
      });
      await engine.pushNow();

      const file = readJson(settingsPath);
      expect(file['model']).toBe('opus');
      expect(file['permissions']).toEqual({ allow: ['Bash'] });
      expect(file['sandbox']).toEqual({
        enabled: true,
        network: { allowedDomains: ['a.com', 'b.com'], deniedDomains: ['evil.test'] },
        filesystem: {
          allowWrite: ['/opt', '/srv'],
          denyWrite: [],
          denyRead: ['~/'],
          allowRead: ['.'],
        },
        credentials: {
          files: [{ path: '~/.ssh', mode: 'deny' }],
          envVars: [{ name: 'TOKEN', mode: 'deny' }],
        },
      });
    });

    it('writes the claudeCode passthrough keys when set', async () => {
      policy = basePolicy({
        claudeCode: {
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          excludedCommands: ['docker *'],
          allowAppleEvents: true,
        },
      });
      await engine.pushNow();
      const sb = readSandbox(settingsPath);
      expect(sb['failIfUnavailable']).toBe(true);
      expect(sb['allowUnsandboxedCommands']).toBe(false);
      expect(sb['excludedCommands']).toEqual(['docker *']);
      expect(sb['allowAppleEvents']).toBe(true);
    });

    it('reflects a disabled master switch in the written block', async () => {
      policy = basePolicy({ enabled: false });
      await engine.pushNow();
      expect(readSandbox(settingsPath)['enabled']).toBe(false);
      expect(engine.getStatus().lastPushedAt).not.toBeNull();
    });
  });

  describe('pullNow', () => {
    it('merge unions file content into the policy and preserves control flags', async () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          sandbox: {
            enabled: false,
            network: { allowedDomains: ['new.com', 'example.com'] },
            filesystem: { allowWrite: ['/srv'] },
          },
        }),
      );
      policy = basePolicy({ enforceCodeMode: true });
      await engine.pullNow('merge');

      expect(policy.enabled).toBe(true); // master switch untouched by the file
      expect(policy.syncToClaudeCode).toBe(true);
      expect(policy.enforceCodeMode).toBe(true);
      expect(policy.network.allowedDomains).toEqual(['example.com', 'new.com']);
      expect(policy.filesystem.allowWrite).toEqual(['~/.kube', '/srv']);
      expect(engine.getStatus().lastPulledAt).not.toBeNull();
    });

    it('import replaces content with the file and filters invalid domains', async () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          sandbox: { network: { allowedDomains: ['only.com', '*.com', 'https://bad'] } },
        }),
      );
      await engine.pullNow('import');
      expect(policy.network.allowedDomains).toEqual(['only.com']);
      expect(policy.filesystem.allowWrite).toEqual([]); // file had none → replaced
    });

    it('export ignores file content and asserts the policy onto the file', async () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({ sandbox: { network: { allowedDomains: ['fromfile.com'] } } }),
      );
      policy = basePolicy({ network: { allowedDomains: ['frompolicy.com'], deniedDomains: [] } });
      await engine.pullNow('export');
      // Policy unchanged; file overwritten with the policy.
      expect(policy.network.allowedDomains).toEqual(['frompolicy.com']);
      expect(
        (readSandbox(settingsPath)['network'] as Record<string, unknown>)['allowedDomains'],
      ).toEqual(['frompolicy.com']);
    });

    it('treats a missing file as empty content (merge keeps policy intact)', async () => {
      await engine.pullNow('merge'); // no settings.json on disk
      expect(policy.network.allowedDomains).toEqual(['example.com']);
      expect(engine.getStatus().lastError).toBeNull();
    });
  });

  describe('start / first-enable reconciliation', () => {
    it('first-enable merge unions, pushes a complete block, and sets the marker', async () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({ keep: 1, sandbox: { network: { allowedDomains: ['file.com'] } } }),
      );
      await engine.start({ initialMode: 'merge' });

      expect(policy.network.allowedDomains).toEqual(['example.com', 'file.com']);
      const file = readJson(settingsPath);
      expect(file['keep']).toBe(1); // unrelated key preserved
      expect((file['sandbox'] as Record<string, unknown>)['network']).toEqual({
        allowedDomains: ['example.com', 'file.com'],
        deniedDomains: [],
      });
      expect(engine.getStatus().active).toBe(true);
      // Marker persisted so the next start takes the steady-state path.
      const row = db
        .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
        .get('sandbox_initial_import_v1');
      expect(row).toBeTruthy();
    });

    it('first-enable export overwrites the file with the policy (no import)', async () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({ sandbox: { network: { allowedDomains: ['file.com'] } } }),
      );
      policy = basePolicy({ network: { allowedDomains: ['policy.com'], deniedDomains: [] } });
      await engine.start({ initialMode: 'export' });
      expect(policy.network.allowedDomains).toEqual(['policy.com']); // not unioned with file.com
      expect(
        (readSandbox(settingsPath)['network'] as Record<string, unknown>)['allowedDomains'],
      ).toEqual(['policy.com']);
    });

    it('is idempotent — a second start while active is a no-op', async () => {
      await engine.start({ initialMode: 'merge' });
      const pushedAt = engine.getStatus().lastPushedAt;
      await engine.start({ initialMode: 'merge' });
      expect(engine.getStatus().lastPushedAt).toBe(pushedAt);
    });

    it('steady-state start (marker already set) merges and pushes', async () => {
      // Pre-set the marker so start takes the steady-state branch.
      db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        'sandbox_initial_import_v1',
        1,
      );
      writeFileSync(
        settingsPath,
        JSON.stringify({ sandbox: { network: { allowedDomains: ['offline.com'] } } }),
      );
      await engine.start();
      expect(policy.network.allowedDomains).toEqual(['example.com', 'offline.com']); // merged
      expect(engine.getStatus().lastPushedAt).not.toBeNull();
    });
  });

  describe('status lifecycle', () => {
    it('reports inactive before start and after stop', async () => {
      expect(engine.getStatus().active).toBe(false);
      await engine.start({ initialMode: 'merge' });
      expect(engine.getStatus().active).toBe(true);
      engine.stop();
      expect(engine.getStatus().active).toBe(false);
    });

    it('stop is safe to call when never started', () => {
      expect(() => engine.stop()).not.toThrow();
    });

    it('start() bails without attaching a watcher if stopped before mkdir resolves', async () => {
      // start() suspends at `await fs.mkdir`; calling stop() synchronously here
      // sets `disposed` while it's suspended, so start() must bail on resume.
      const p = engine.start({ initialMode: 'merge' });
      engine.stop();
      await p;
      expect(engine.getStatus().active).toBe(false);
      // A subsequent external edit must NOT be picked up — proving no watcher
      // leaked from the aborted start().
      writeFileSync(
        settingsPath,
        JSON.stringify({ sandbox: { network: { allowedDomains: ['leak.com'] } } }),
      );
      await new Promise((r) => setTimeout(r, 700));
      expect(policy.network.allowedDomains).not.toContain('leak.com');
    });
  });

  describe('error paths and defaults', () => {
    it('constructs with the default settings path when none is provided', () => {
      const e = createSandboxSyncEngine({
        db,
        ipcServer: makeIpcStub(),
        getPolicy: () => policy,
        setPolicy: (p) => {
          policy = p;
        },
      });
      // No start()/push()/pull() → no I/O against the real ~/.claude file.
      expect(e.getStatus().active).toBe(false);
    });

    it('swallows a throwing broadcast without failing the operation', async () => {
      const throwingEngine = createSandboxSyncEngine({
        db,
        ipcServer: {
          start() {},
          stop() {},
          broadcast: () => {
            throw new Error('boom');
          },
        } as unknown as IpcServer,
        getPolicy: () => policy,
        setPolicy: (p) => {
          policy = p;
        },
        settingsPath,
      });
      await expect(throwingEngine.pushNow()).resolves.toBeUndefined();
      expect(readSandbox(settingsPath)['enabled']).toBe(true); // the write still happened
    });

    it('hashes a partial claudeCode passthrough without error', async () => {
      // Only allowAppleEvents set → exercises the `?? null` fallbacks for the
      // other passthrough keys in the canonical hash.
      policy = basePolicy({ claudeCode: { allowAppleEvents: true } });
      await engine.pushNow();
      const sb = readSandbox(settingsPath);
      expect(sb['allowAppleEvents']).toBe(true);
      expect('failIfUnavailable' in sb).toBe(false);
      expect('allowUnsandboxedCommands' in sb).toBe(false);
      expect('excludedCommands' in sb).toBe(false);
    });

    it('hashes a passthrough that omits allowAppleEvents', async () => {
      policy = basePolicy({ claudeCode: { failIfUnavailable: true } });
      await engine.pushNow();
      const sb = readSandbox(settingsPath);
      expect(sb['failIfUnavailable']).toBe(true);
      expect('allowAppleEvents' in sb).toBe(false);
    });

    it('formatSyncError stringifies Error and non-Error values', () => {
      expect(formatSyncError(new Error('boom'))).toBe('boom');
      expect(formatSyncError('plain')).toBe('plain');
      expect(formatSyncError(42)).toBe('42');
    });

    it('treats a non-object JSON file as empty content', async () => {
      writeFileSync(settingsPath, '42');
      await engine.pullNow('merge');
      expect(policy.network.allowedDomains).toEqual(['example.com']); // unchanged
    });

    it('pullNow rejects and records the error on unreadable JSON', async () => {
      writeFileSync(settingsPath, 'not json {');
      await expect(engine.pullNow('merge')).rejects.toThrow();
      expect(engine.getStatus().lastError).not.toBeNull();
    });

    it('pushNow rejects and records the error when the existing file is corrupt', async () => {
      writeFileSync(settingsPath, 'not json {');
      await expect(engine.pushNow()).rejects.toThrow();
      expect(engine.getStatus().lastError).not.toBeNull();
    });

    it('start records an error (and stays inactive) when the directory cannot be created', async () => {
      const blocker = join(root, 'blocker');
      writeFileSync(blocker, 'i am a file'); // a file where a dir is needed
      const bad = createSandboxSyncEngine({
        db,
        ipcServer: makeIpcStub(),
        getPolicy: () => policy,
        setPolicy: (p) => {
          policy = p;
        },
        settingsPath: join(blocker, 'sub', 'settings.json'),
      });
      await bad.start({ initialMode: 'merge' });
      expect(bad.getStatus().active).toBe(false);
      expect(bad.getStatus().lastError).not.toBeNull();
    });

    it('first-enable with no options defaults to merge', async () => {
      writeFileSync(
        settingsPath,
        JSON.stringify({ sandbox: { network: { allowedDomains: ['file.com'] } } }),
      );
      await engine.start(); // no opts → mode defaults to 'merge'
      expect(policy.network.allowedDomains).toEqual(['example.com', 'file.com']);
    });
  });

  describe('watcher', () => {
    it('pulls when the file is edited externally, and ignores unrelated files', async () => {
      await engine.start({ initialMode: 'merge' });
      // Unrelated file in the same dir must not change the policy.
      writeFileSync(join(root, 'unrelated.txt'), 'hi');
      // External edit to settings.json adds a domain.
      writeFileSync(
        settingsPath,
        JSON.stringify({ sandbox: { network: { allowedDomains: ['watched.com'] } } }),
      );
      const sawIt = await waitFor(() => policy.network.allowedDomains.includes('watched.com'));
      expect(sawIt).toBe(true);
      // Control flags still preserved through the watcher-driven pull.
      expect(policy.enabled).toBe(true);
    });

    it('records an error when a watcher-triggered read hits corrupt JSON', async () => {
      await engine.start({ initialMode: 'merge' }); // writes a valid file
      writeFileSync(settingsPath, 'not json {'); // external corruption
      const sawErr = await waitFor(() => engine.getStatus().lastError !== null);
      expect(sawErr).toBe(true);
    });

    it('ignores our own push (echo) without a spurious state change', async () => {
      await engine.start({ initialMode: 'merge' });
      const pulledAfterStart = engine.getStatus().lastPulledAt;
      // A push writes the file; the resulting watcher event must be detected as
      // an echo and skipped (no new pull).
      await engine.pushNow();
      await new Promise((r) => setTimeout(r, 700));
      expect(engine.getStatus().lastPulledAt).toBe(pulledAfterStart);
    });
  });
});
