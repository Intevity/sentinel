import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createClaudeDesktopConfigWatcher } from './claude-desktop-config-watcher.js';
import { activateDesktop, inspectDesktopConfig } from './claude-desktop-config.js';
import type { ClaudeDesktopDriftDetails, DaemonToAppMessage } from '@sentinel/shared';

function makeStubServer(): {
  ipcServer: Parameters<typeof createClaudeDesktopConfigWatcher>[0]['ipcServer'];
  broadcasts: DaemonToAppMessage[];
} {
  const broadcasts: DaemonToAppMessage[] = [];
  const ipcServer = {
    broadcast: (msg: DaemonToAppMessage) => void broadcasts.push(msg),
  } as unknown as Parameters<typeof createClaudeDesktopConfigWatcher>[0]['ipcServer'];
  return { ipcServer, broadcasts };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const driftMsgs = (b: DaemonToAppMessage[]): ClaudeDesktopDriftDetails[] =>
  b
    .filter((m) => m.type === 'claude_desktop_drift_state')
    .map((m) => (m as { details: ClaudeDesktopDriftDetails }).details);

describe('claude-desktop-config-watcher', () => {
  let workdir: string;
  let libDir: string;
  const prev = process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'desktop-watch-'));
    libDir = join(workdir, 'configLibrary');
    mkdirSync(libDir, { recursive: true });
    process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR = libDir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR;
    else process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR = prev;
    rmSync(workdir, { recursive: true, force: true });
  });

  it('broadcasts the initial inspect result on start', async () => {
    await activateDesktop(null);
    const { ipcServer, broadcasts } = makeStubServer();
    const w = createClaudeDesktopConfigWatcher({ ipcServer });
    await w.start();
    try {
      const states = driftMsgs(broadcasts);
      expect(states).toHaveLength(1);
      expect(states[0]?.state).toBe('active');
      expect(w.getCurrent()?.state).toBe('active');
    } finally {
      w.stop();
    }
  });

  it('broadcasts drift when a foreign edit repoints the applied config', async () => {
    await activateDesktop(null);
    const { ipcServer, broadcasts } = makeStubServer();
    const w = createClaudeDesktopConfigWatcher({ ipcServer });
    await w.start();
    try {
      // Simulate the user pointing the applied config at another gateway.
      const foreignId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      writeFileSync(
        join(libDir, `${foreignId}.json`),
        JSON.stringify({ inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'https://corp.example' }),
      );
      // Re-touch _meta.json until the drift lands, spacing writes beyond the
      // 500ms debounce so each re-touch actually fires a tick. fs.watch can
      // miss the very first event on a cold fsevents warm-up (macOS).
      let drift: ClaudeDesktopDriftDetails | null = null;
      for (let i = 0; i < 8 && !drift; i++) {
        writeFileSync(
          join(libDir, '_meta.json'),
          JSON.stringify({ appliedId: foreignId, entries: [{ id: foreignId, name: 'Corp' }] }),
        );
        await sleep(700);
        drift = driftMsgs(broadcasts).find((d) => d.state === 'foreign-gateway') ?? null;
      }
      expect(drift?.appliedBaseUrl).toBe('https://corp.example');
    } finally {
      w.stop();
    }
  });

  it('markWritten suppresses our own echo', async () => {
    await activateDesktop(null);
    const { ipcServer, broadcasts } = makeStubServer();
    const w = createClaudeDesktopConfigWatcher({ ipcServer });
    await w.start();
    try {
      const initial = driftMsgs(broadcasts).length;
      // Pretend we just re-wrote the same (active) state and marked it.
      const details = await inspectDesktopConfig();
      w.markWritten(details);
      // Re-activate (writes the identical config → file events, same hash).
      await activateDesktop(null);
      await sleep(800); // let the debounce window pass
      expect(driftMsgs(broadcasts).length).toBe(initial); // no new broadcast
    } finally {
      w.stop();
    }
  });

  it('inspectAndBroadcast publishes immediately and returns details', async () => {
    await activateDesktop(null);
    const { ipcServer, broadcasts } = makeStubServer();
    const w = createClaudeDesktopConfigWatcher({ ipcServer });
    await w.start();
    try {
      const before = driftMsgs(broadcasts).length;
      const details = await w.inspectAndBroadcast();
      expect(details.state).toBe('active');
      expect(driftMsgs(broadcasts).length).toBe(before + 1);
    } finally {
      w.stop();
    }
  });

  it('stop() halts watching (no further broadcasts)', async () => {
    await activateDesktop(null);
    const { ipcServer, broadcasts } = makeStubServer();
    const w = createClaudeDesktopConfigWatcher({ ipcServer });
    await w.start();
    w.stop();
    const count = driftMsgs(broadcasts).length;
    writeFileSync(join(libDir, '_meta.json'), JSON.stringify({ appliedId: '', entries: [] }));
    await sleep(800);
    expect(driftMsgs(broadcasts).length).toBe(count);
  });
});
