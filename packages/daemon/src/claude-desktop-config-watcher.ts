/**
 * File watcher for the Claude **Desktop** app's gateway config
 * (`Claude-3p/configLibrary`). Desktop analog of `otel-settings-watcher.ts`.
 *
 * Surfaces "desktop is no longer routed through Sentinel" to the desktop
 * drift banner. Detection model (mirrors the OTEL watcher):
 *
 *   1. On start, inspect once and broadcast the current drift state; seed
 *      `lastHash` so an already-active user doesn't get a startup broadcast
 *      cascade.
 *   2. Watch the configLibrary directory (the container of `_meta.json` +
 *      `<uuid>.json`). Directory mode catches the atomic temp+rename writes
 *      both Sentinel and the desktop app use.
 *   3. Debounce 500 ms.
 *   4. On the debounced tick, re-inspect + hash. If the hash matches the last
 *      recorded one, treat as our own echo and skip; otherwise broadcast.
 *
 * `markWritten()` lets the IPC handlers that own activate / re-apply set the
 * post-write hash BEFORE the watcher tick lands, so the round-trip is silent
 * in the UI (the action broadcasts the new state; the watcher's confirming
 * read is suppressed).
 *
 * Gated by index.ts: started only once the desktop surface is detected and
 * activated, so it never creates a configLibrary the app doesn't already own.
 */
import { promises as fs, type FSWatcher, watch } from 'fs';
import type { ClaudeDesktopDriftDetails } from '@sentinel/shared';
import type { IpcServer } from './ipc.js';
import {
  inspectDesktopConfig,
  canonHashDesktopDrift,
  desktopConfigLibraryDir,
} from './claude-desktop-config.js';

const DEBOUNCE_MS = 500;

export interface ClaudeDesktopConfigWatcherDeps {
  ipcServer: IpcServer;
}

export interface ClaudeDesktopConfigWatcher {
  start(): Promise<void>;
  stop(): void;
  /** Record the drift state we just wrote so the next watcher tick on the
   *  resulting file event is suppressed as our own echo. */
  markWritten(details: ClaudeDesktopDriftDetails): void;
  /** One-shot inspect + broadcast — used by IPC handlers that mutate the
   *  configLibrary directly so they can publish immediately. */
  inspectAndBroadcast(): Promise<ClaudeDesktopDriftDetails>;
  /** Current cached state. Null before the first inspect. */
  getCurrent(): ClaudeDesktopDriftDetails | null;
}

export function createClaudeDesktopConfigWatcher(
  deps: ClaudeDesktopConfigWatcherDeps,
): ClaudeDesktopConfigWatcher {
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let lastHash: string | null = null;
  let lastDetails: ClaudeDesktopDriftDetails | null = null;

  const broadcast = (details: ClaudeDesktopDriftDetails): void => {
    lastDetails = details;
    deps.ipcServer.broadcast({ type: 'claude_desktop_drift_state', details });
  };

  const readHash = async (): Promise<string | null> => {
    try {
      return canonHashDesktopDrift(await inspectDesktopConfig());
    } catch {
      return null;
    }
  };

  const onWatcherEvent = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void (async () => {
        const details = await inspectDesktopConfig().catch(() => null);
        if (!details) return;
        const h = canonHashDesktopDrift(details);
        if (h === lastHash) return;
        lastHash = h;
        broadcast(details);
      })();
    }, DEBOUNCE_MS);
  };

  const start = async (): Promise<void> => {
    if (active) return;
    const libDir = desktopConfigLibraryDir();
    await fs.mkdir(libDir, { recursive: true });
    // fs.watch can throw on sandboxed runtimes; index.ts wraps start() in a
    // try/catch so a failure just disables the watcher, daemon stays up.
    watcher = watch(libDir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      if (!filename.toString().endsWith('.json')) return;
      onWatcherEvent();
    });
    active = true;

    lastHash = await readHash();
    const details = await inspectDesktopConfig();
    broadcast(details);
  };

  const stop = (): void => {
    if (!active) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    watcher?.close();
    watcher = null;
    active = false;
  };

  const markWritten = (details: ClaudeDesktopDriftDetails): void => {
    lastHash = canonHashDesktopDrift(details);
  };

  const inspectAndBroadcast = async (): Promise<ClaudeDesktopDriftDetails> => {
    const details = await inspectDesktopConfig();
    broadcast(details);
    return details;
  };

  const getCurrent = (): ClaudeDesktopDriftDetails | null => lastDetails;

  return { start, stop, markWritten, inspectAndBroadcast, getCurrent };
}
