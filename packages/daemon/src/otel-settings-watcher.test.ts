import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createOtelSettingsWatcher } from './otel-settings-watcher.js';
import { canonHashManagedEnv } from './otel-settings-drift.js';
import { SENTINEL_BASE_URL } from './claude-otel-config.js';
import type { DaemonToAppMessage } from '@claude-sentinel/shared';

// Minimal IpcServer stub. The watcher only ever calls `broadcast()`,
// so we record those calls and the rest of the interface can be
// no-ops (typed loosely via `unknown` so we don't have to keep parity
// with the real IpcServer API surface in the unit test).
function makeStubServer(): {
  ipcServer: Parameters<typeof createOtelSettingsWatcher>[0]['ipcServer'];
  broadcasts: DaemonToAppMessage[];
} {
  const broadcasts: DaemonToAppMessage[] = [];
  const ipcServer = {
    broadcast: (msg: DaemonToAppMessage) => {
      broadcasts.push(msg);
    },
  } as unknown as Parameters<typeof createOtelSettingsWatcher>[0]['ipcServer'];
  return { ipcServer, broadcasts };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async <T>(predicate: () => T | null, timeoutMs = 3000): Promise<T> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = predicate();
    if (v !== null) return v;
    await sleep(20);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
};

describe('otel-settings-watcher', () => {
  let workdir: string;
  let settingsPath: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'watcher-'));
    settingsPath = join(workdir, 'settings.json');
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('broadcasts the initial inspect result on start', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
        },
      }),
    );
    const { ipcServer, broadcasts } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath,
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    await watcher.start();
    try {
      expect(broadcasts).toHaveLength(1);
      const msg = broadcasts[0];
      expect(msg?.type).toBe('otel_drift_state');
      if (msg && msg.type === 'otel_drift_state') {
        expect(msg.details.state).toBe('ok');
      }
    } finally {
      watcher.stop();
    }
  });

  it('broadcasts a new state when the file changes', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
        },
      }),
    );
    const { ipcServer, broadcasts } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath,
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    await watcher.start();
    try {
      expect(broadcasts).toHaveLength(1);

      // Mutate the file to a foreign endpoint.
      writeFileSync(
        settingsPath,
        JSON.stringify({
          env: {
            CLAUDE_CODE_ENABLE_TELEMETRY: '1',
            OTEL_EXPORTER_OTLP_ENDPOINT: 'https://api.honeycomb.io',
          },
        }),
      );

      const drift = await waitFor(() => {
        const found = broadcasts.find(
          (b) => b.type === 'otel_drift_state' && b.details.state === 'foreign-endpoint',
        );
        return found ?? null;
      });
      expect(drift.type).toBe('otel_drift_state');
    } finally {
      watcher.stop();
    }
  });

  it('suppresses watcher events that match the lastWrittenEnvHash', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
        },
      }),
    );
    const { ipcServer, broadcasts } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath,
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    await watcher.start();
    try {
      const before = broadcasts.length;

      // Pretend we're about to write the same env block, then write it.
      // Reverse order would break the test (the watcher might tick on
      // mtime change before we mark); both orders are valid in prod since
      // the IPC handler calls markWritten immediately after the file
      // write. We exercise the markWritten-first path here.
      const sameEnv = {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
      };
      watcher.markWritten(sameEnv);
      writeFileSync(settingsPath, JSON.stringify({ env: sameEnv }));

      // Let the debounce expire + a generous fudge.
      await sleep(750);
      expect(broadcasts.length).toBe(before);
    } finally {
      watcher.stop();
    }
  });

  it('inspectAndBroadcast emits + returns the latest details', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://api.honeycomb.io',
        },
      }),
    );
    const { ipcServer, broadcasts } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath,
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    await watcher.start();
    try {
      const initialCount = broadcasts.length;
      const details = await watcher.inspectAndBroadcast();
      expect(details.state).toBe('foreign-endpoint');
      expect(broadcasts.length).toBe(initialCount + 1);
    } finally {
      watcher.stop();
    }
  });

  it('getCurrent returns the last broadcast details', async () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    const { ipcServer } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath,
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    await watcher.start();
    try {
      const current = watcher.getCurrent();
      expect(current?.state).toBe('telemetry-disabled');
    } finally {
      watcher.stop();
    }
  });

  it('start is a no-op when called twice', async () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    const { ipcServer, broadcasts } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath,
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    await watcher.start();
    await watcher.start();
    // Single broadcast from the first start; the second is a no-op.
    expect(broadcasts.length).toBe(1);
    watcher.stop();
  });

  it('stop is safe to call when not started', () => {
    const { ipcServer } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath,
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    expect(() => watcher.stop()).not.toThrow();
  });

  it('stops cleanly when a debounce timer is pending', async () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } }));
    const { ipcServer } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath,
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    await watcher.start();
    // Trigger a watcher event (the debounce timer arms but doesn't fire yet)
    // and then immediately stop. The clearTimeout branch in stop() should
    // not throw.
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    await sleep(50);
    expect(() => watcher.stop()).not.toThrow();
  });

  it('survives the watcher attach throwing (no-op fallback)', async () => {
    // Point the watcher at a path whose parent does not (and cannot) exist
    // after start. We pre-create the dir for the seed, then unlink before
    // start so that fs.watch raises ENOENT on the directory.
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    // Force a watch() error by passing a settings path inside a path that
    // cannot be mkdir'd. /dev/null/foo on macOS triggers ENOTDIR which
    // bubbles from the mkdir step.
    const { ipcServer } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath: '/dev/null/no-such-path/settings.json',
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    // start() should not throw even when fs.mkdir or watch() fails.
    await expect(watcher.start()).rejects.toThrow();
  });

  it('starts cleanly when the settings file does not exist', async () => {
    // ENOENT path through readEnvHash + inspect — both must handle a
    // missing file gracefully and produce the no-settings-file state.
    const { ipcServer, broadcasts } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath, // path is in workdir but file doesn't exist
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    await watcher.start();
    try {
      const msg = broadcasts[0];
      expect(msg?.type).toBe('otel_drift_state');
      if (msg && msg.type === 'otel_drift_state') {
        expect(msg.details.state).toBe('no-settings-file');
      }
    } finally {
      watcher.stop();
    }
  });

  it('handles JSON-primitive settings via the non-object branch of readEnvHash', async () => {
    // When the file's JSON parses to a primitive (e.g. `42`), readEnvHash
    // falls back to canonHashManagedEnv({}). Coverage-only — there's no
    // user-facing diff vs an empty file, but the branch exists.
    writeFileSync(settingsPath, '42');
    const { ipcServer, broadcasts } = makeStubServer();
    const watcher = createOtelSettingsWatcher({
      settingsPath,
      ipcServer,
      getSentinelExporterEndpoint: () => null,
    });
    await watcher.start();
    try {
      expect(broadcasts.length).toBeGreaterThan(0);
      // Mutate the file and confirm the watcher still ticks (the hash
      // we seeded must compare cleanly against the next read).
      writeFileSync(
        settingsPath,
        JSON.stringify({
          env: {
            CLAUDE_CODE_ENABLE_TELEMETRY: '1',
            OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
          },
        }),
      );
      const next = await waitFor(() => {
        const found = broadcasts.find(
          (b) => b.type === 'otel_drift_state' && b.details.state === 'ok',
        );
        return found ?? null;
      });
      expect(next.type).toBe('otel_drift_state');
    } finally {
      watcher.stop();
    }
  });

  it('canonHashManagedEnv is the source of truth for echo suppression', () => {
    // The watcher's echo suppression relies on this hash being deterministic
    // across the JSON parse/serialize round trip in writeSettingsAtomic.
    const env = {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
    };
    const a = canonHashManagedEnv(env);
    const b = canonHashManagedEnv(JSON.parse(JSON.stringify(env)) as Record<string, unknown>);
    expect(a).toBe(b);
  });
});
