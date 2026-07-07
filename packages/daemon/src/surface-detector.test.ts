import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DaemonToAppMessage, SurfaceState } from '@sentinel/shared';
import {
  createSurfaceDetector,
  resolveDesktopInstallMarkers,
  anyExists,
  isCliInstalled,
  isDesktopInstalled,
  type SurfaceDetectorDeps,
} from './surface-detector.js';

function makeStubServer(): {
  ipcServer: SurfaceDetectorDeps['ipcServer'];
  broadcasts: DaemonToAppMessage[];
} {
  const broadcasts: DaemonToAppMessage[] = [];
  const ipcServer = {
    broadcast: (msg: DaemonToAppMessage) => void broadcasts.push(msg),
  } as unknown as SurfaceDetectorDeps['ipcServer'];
  return { ipcServer, broadcasts };
}

const surfaceMsgs = (b: DaemonToAppMessage[]): SurfaceState[] =>
  b.filter((m) => m.type === 'surface_state_changed').map((m) => (m as { state: SurfaceState }).state);

describe('resolveDesktopInstallMarkers (pure, cross-platform)', () => {
  const home = '/home/u';
  it('macOS includes the app bundle and userData dir', () => {
    const m = resolveDesktopInstallMarkers('darwin', {}, home);
    expect(m).toContain('/Applications/Claude.app');
    expect(m).toContain('/home/u/Library/Application Support/Claude');
  });
  it('Windows uses APPDATA + LOCALAPPDATA Programs', () => {
    const m = resolveDesktopInstallMarkers('win32', { APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L' }, home);
    expect(m).toHaveLength(2);
    expect(m[0]).toContain('Claude');
    expect(m.some((p) => p.includes('Programs'))).toBe(true);
  });
  it('Windows with no env yields no markers', () => {
    expect(resolveDesktopInstallMarkers('win32', {}, home)).toEqual([]);
  });
  it('Linux uses XDG or ~/.config', () => {
    expect(resolveDesktopInstallMarkers('linux', { XDG_CONFIG_HOME: '/cfg' }, home)).toContain('/cfg/Claude');
    expect(resolveDesktopInstallMarkers('linux', {}, home)).toContain('/home/u/.config/Claude');
  });
});

describe('anyExists / install probes', () => {
  it('anyExists returns true iff a marker exists', () => {
    const exists = (p: string) => p === '/yes';
    expect(anyExists(['/no', '/yes'], exists)).toBe(true);
    expect(anyExists(['/no', '/nope'], exists)).toBe(false);
  });
  it('isCliInstalled / isDesktopInstalled honor injected markers + existsFn', () => {
    expect(isCliInstalled(['/a'], (p) => p === '/a')).toBe(true);
    expect(isCliInstalled(['/a'], () => false)).toBe(false);
    expect(isDesktopInstalled(['/b'], (p) => p === '/b')).toBe(true);
    expect(isDesktopInstalled(['/b'], () => false)).toBe(false);
  });

  it('isDesktopInstalled default markers honor the SENTINEL_TEST_CLAUDE_DESKTOP_DIR seam', () => {
    const prev = process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR;
    const work = mkdtempSync(join(tmpdir(), 'desktop-seam-'));
    try {
      const lib = join(work, 'configLibrary');
      process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR = lib;
      expect(isDesktopInstalled()).toBe(false); // dir not created yet
      mkdirSync(lib, { recursive: true });
      expect(isDesktopInstalled()).toBe(true); // now present
    } finally {
      if (prev === undefined) delete process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR;
      else process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR = prev;
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('isCliInstalled default markers reflect ~/.claude.json presence via the test seam', () => {
    const prev = process.env.SENTINEL_TEST_CLAUDE_JSON;
    const work = mkdtempSync(join(tmpdir(), 'cli-seam-'));
    try {
      const jsonPath = join(work, 'claude.json');
      process.env.SENTINEL_TEST_CLAUDE_JSON = jsonPath;
      writeFileSync(jsonPath, '{}'); // getClaudeJsonPath() now points at an existing file
      expect(isCliInstalled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SENTINEL_TEST_CLAUDE_JSON;
      else process.env.SENTINEL_TEST_CLAUDE_JSON = prev;
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('createSurfaceDetector', () => {
  const baseProbes = (over: Partial<SurfaceDetectorDeps> = {}): SurfaceDetectorDeps => {
    const { ipcServer } = makeStubServer();
    return {
      ipcServer,
      probeCliInstalled: () => true,
      probeCliActivated: () => true,
      probeDesktopInstalled: () => false,
      probeDesktopActivated: () => false,
      probeDesktopHealthy: () => false,
      ...over,
    };
  };

  it('broadcasts the initial state on start', async () => {
    const { ipcServer, broadcasts } = makeStubServer();
    const det = createSurfaceDetector(baseProbes({ ipcServer }));
    await det.start();
    det.stop();
    const states = surfaceMsgs(broadcasts);
    expect(states).toHaveLength(1);
    expect(states[0]).toEqual({
      cli: { installed: true, activated: true },
      desktop: { installed: false, activated: false, healthy: false },
    });
    expect(det.getCurrent()).toEqual(states[0]);
  });

  it('does not re-broadcast when nothing changed', async () => {
    const { ipcServer, broadcasts } = makeStubServer();
    const det = createSurfaceDetector(baseProbes({ ipcServer }));
    await det.start();
    await det.refresh();
    await det.refresh();
    det.stop();
    expect(surfaceMsgs(broadcasts)).toHaveLength(1);
  });

  it('catches the user installing the desktop app later (flip → broadcast)', async () => {
    const { ipcServer, broadcasts } = makeStubServer();
    let desktopThere = false;
    const det = createSurfaceDetector(
      baseProbes({ ipcServer, probeDesktopInstalled: () => desktopThere }),
    );
    await det.start();
    expect(surfaceMsgs(broadcasts)).toHaveLength(1);
    desktopThere = true; // user installs Claude Desktop
    const state = await det.refresh();
    det.stop();
    expect(state.desktop.installed).toBe(true);
    const states = surfaceMsgs(broadcasts);
    expect(states).toHaveLength(2);
    expect(states[1]?.desktop.installed).toBe(true);
  });

  it('reflects desktop health and activation transitions', async () => {
    const { ipcServer, broadcasts } = makeStubServer();
    let activated = false;
    let healthy = false;
    const det = createSurfaceDetector(
      baseProbes({
        ipcServer,
        probeDesktopInstalled: () => true,
        probeDesktopActivated: () => activated,
        probeDesktopHealthy: () => healthy,
      }),
    );
    await det.start();
    activated = true;
    healthy = true;
    const state = await det.refresh();
    det.stop();
    expect(state.desktop).toEqual({ installed: true, activated: true, healthy: true });
    expect(surfaceMsgs(broadcasts)).toHaveLength(2);
  });

  it('supports async probes', async () => {
    const { ipcServer, broadcasts } = makeStubServer();
    const det = createSurfaceDetector(
      baseProbes({ ipcServer, probeCliInstalled: async () => Promise.resolve(false) }),
    );
    await det.start();
    det.stop();
    expect(surfaceMsgs(broadcasts)[0]?.cli.installed).toBe(false);
  });

  it('start is idempotent (second start does not double-broadcast)', async () => {
    const { ipcServer, broadcasts } = makeStubServer();
    const det = createSurfaceDetector(baseProbes({ ipcServer }));
    await det.start();
    await det.start();
    det.stop();
    expect(surfaceMsgs(broadcasts)).toHaveLength(1);
  });
});
