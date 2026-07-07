/**
 * Detects which Claude surfaces (terminal CLI + Desktop app) are present on
 * this machine and whether each currently routes through Sentinel, and
 * broadcasts `surface_state_changed` on every transition.
 *
 * Sentinel has no explicit "is Claude installed" signal today — it infers CLI
 * presence from `~/.claude.json`. This adds a small periodic poller (the
 * `claude-ai-usage.ts` shape: `setInterval(...).unref()`, fire-once-then-
 * interval, stopped in shutdown) because `.app` bundles aren't config-shaped
 * and there's no existing `~/Library/Application Support` watcher to hook.
 * Polling is what catches "the user installed the *other* surface later": each
 * tick re-checks presence and the broadcast fires when a surface flips to
 * installed.
 *
 * The change-detection + broadcast logic takes injectable probes so it is
 * fully unit-testable without touching real home dirs; index.ts wires the real
 * probes (claude-state, OTEL inspect, desktop-config inspect, install-path
 * checks, and the proxy desktop-health tracker).
 */
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SurfaceState } from '@sentinel/shared';
import type { IpcServer } from './ipc.js';
import { getClaudeJsonPath } from './claude-state.js';

const DEFAULT_INTERVAL_MS = 20_000;

export interface SurfaceDetectorDeps {
  ipcServer: IpcServer;
  probeCliInstalled: () => boolean | Promise<boolean>;
  probeCliActivated: () => boolean | Promise<boolean>;
  probeDesktopInstalled: () => boolean | Promise<boolean>;
  probeDesktopActivated: () => boolean | Promise<boolean>;
  probeDesktopHealthy: () => boolean;
  /** Poll interval; defaults to 20s. */
  intervalMs?: number;
}

export interface SurfaceDetector {
  start(): Promise<void>;
  stop(): void;
  /** Force an immediate re-evaluation + broadcast-on-change. Call after an
   *  activate/deactivate so the cards update without waiting for the tick. */
  refresh(): Promise<SurfaceState>;
  getCurrent(): SurfaceState | null;
}

export function createSurfaceDetector(deps: SurfaceDetectorDeps): SurfaceDetector {
  let timer: ReturnType<typeof setInterval> | null = null;
  let last: SurfaceState | null = null;

  const compute = async (): Promise<SurfaceState> => {
    const [cliInstalled, cliActivated, desktopInstalled, desktopActivated] = await Promise.all([
      deps.probeCliInstalled(),
      deps.probeCliActivated(),
      deps.probeDesktopInstalled(),
      deps.probeDesktopActivated(),
    ]);
    return {
      cli: { installed: cliInstalled, activated: cliActivated },
      desktop: {
        installed: desktopInstalled,
        activated: desktopActivated,
        healthy: deps.probeDesktopHealthy(),
      },
    };
  };

  const tick = async (): Promise<SurfaceState> => {
    const state = await compute();
    if (!last || JSON.stringify(state) !== JSON.stringify(last)) {
      last = state;
      deps.ipcServer.broadcast({ type: 'surface_state_changed', state });
    }
    return state;
  };

  const start = async (): Promise<void> => {
    if (timer) return;
    await tick();
    timer = setInterval(() => void tick().catch(() => {}), deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    timer.unref();
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const refresh = (): Promise<SurfaceState> => tick();
  const getCurrent = (): SurfaceState | null => last;

  return { start, stop, refresh, getCurrent };
}

// ─── Desktop live-traffic health ──────────────────────────────────────────────

export interface DesktopHealthTracker {
  /** Called by the proxy for each live desktop `/v1/messages` request. */
  record(): void;
  /** True when a desktop request was seen within the health window. */
  isHealthy(): boolean;
}

/** Tracks whether the Claude Desktop app has recently routed live traffic
 *  through the proxy. `windowMs` is how long a sighting counts as "healthy"
 *  (default 10 min); `now` is injectable for testing. Positive-only: desktop
 *  emits no OTEL, so absence of traffic is not treated as a bypass (unlike the
 *  CLI's capture-health), it just means "no recent desktop traffic". */
export function createDesktopHealthTracker(
  windowMs = 10 * 60_000,
  now: () => number = Date.now,
): DesktopHealthTracker {
  let lastAt = 0;
  return {
    record: () => {
      lastAt = now();
    },
    isHealthy: () => lastAt > 0 && now() - lastAt < windowMs,
  };
}

// ─── Presence probes (pure resolvers + thin existsSync wrappers) ──────────────

/** Candidate filesystem markers that indicate the Claude **Desktop** app is
 *  installed, per-OS. Pure + parameterized so the Windows/Linux branches —
 *  unreachable on the macOS CI runner — are covered by table tests. Includes
 *  both the app's userData dir (present once it has run) and the app bundle /
 *  install location (present even before first run). */
export function resolveDesktopInstallMarkers(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    const localAppData = env.LOCALAPPDATA;
    const markers: string[] = [];
    if (appData) markers.push(join(appData, 'Claude'));
    if (localAppData) markers.push(join(localAppData, 'Programs', 'claude'));
    return markers;
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Claude.app',
      join(home, 'Applications', 'Claude.app'),
      join(home, 'Library', 'Application Support', 'Claude'),
    ];
  }
  // linux + other
  const xdg = env.XDG_CONFIG_HOME;
  return [
    join(xdg && xdg.length > 0 ? xdg : join(home, '.config'), 'Claude'),
    '/opt/Claude',
    '/usr/bin/claude-desktop',
  ];
}

/** True if any of `markers` exists on disk. */
export function anyExists(markers: string[], existsFn: (p: string) => boolean = existsSync): boolean {
  return markers.some((m) => existsFn(m));
}

/** Terminal Claude Code CLI presence: `~/.claude.json` or the `~/.claude` dir.
 *  `markers` is injectable for testing. */
export function isCliInstalled(
  markers: string[] = [getClaudeJsonPath(), join(homedir(), '.claude')],
  existsFn: (p: string) => boolean = existsSync,
): boolean {
  return anyExists(markers, existsFn);
}

/** Default desktop install markers. Honors `SENTINEL_TEST_CLAUDE_DESKTOP_DIR`
 *  (integration tests control installed-state by creating that dir) and
 *  otherwise resolves the real per-OS markers. */
function defaultDesktopMarkers(): string[] {
  const seam = process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR;
  if (seam) return [seam];
  return resolveDesktopInstallMarkers(process.platform, process.env, homedir());
}

/** Claude Desktop app presence. `markers` is injectable for testing. */
export function isDesktopInstalled(
  markers: string[] = defaultDesktopMarkers(),
  existsFn: (p: string) => boolean = existsSync,
): boolean {
  return anyExists(markers, existsFn);
}
