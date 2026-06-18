/**
 * File watcher for Sentinel's OTEL env block inside `~/.claude/settings.json`.
 *
 * Surfaces "metrics aren't flowing into Sentinel" to the Metrics-tab
 * banner. Detection model:
 *
 *   1. On start, run `inspectClaudeOtelConfig()` once and broadcast the
 *      current drift state. Seeds `lastEnvHash` so steady-state already-
 *      activated users don't see a startup-spam broadcast cascade.
 *   2. Watch the PARENT directory (filtered to `settings.json`). Watching
 *      the file directly loses events through atomic temp-rename writes,
 *      which both Sentinel and Claude Code use.
 *   3. Debounce 500 ms (editors emit multiple events per save).
 *   4. On debounced tick, re-hash the env block. If it matches
 *      `lastEnvHash`, treat as our own echo and skip. Otherwise inspect,
 *      update the hash, and broadcast.
 *
 * The watcher also exposes `markWritten()` so the IPC handlers that own
 * re-patch / promote can set `lastEnvHash` to the post-write hash BEFORE
 * the watcher tick lands. That makes the round-trip silent in the UI:
 * the action explicitly broadcasts the new state, and the watcher's
 * confirming read is suppressed.
 */
import { promises as fs, type FSWatcher, watch } from 'fs';
import { basename, dirname } from 'path';
import type { OtelDriftDetails } from '@sentinel/shared';
import type { IpcServer } from './ipc.js';
import { inspectClaudeOtelConfig, canonHashManagedEnv } from './otel-settings-drift.js';

const DEBOUNCE_MS = 500;

export interface OtelSettingsWatcherDeps {
  /** Path to `~/.claude/settings.json`. Tests pass a temp path; production
   *  passes the real homedir-relative path. */
  settingsPath: string;
  ipcServer: IpcServer;
  /** Live accessor for Sentinel's own `otelExporterEndpoint`. Used to
   *  populate the promote-preview's "replaces existing forwarding"
   *  warning. */
  getSentinelExporterEndpoint: () => string | null;
}

export interface OtelSettingsWatcher {
  start(): Promise<void>;
  stop(): void;
  /** Record the hash of an env block we just wrote, so the next watcher
   *  tick on the resulting file event is suppressed as our own echo.
   *  Pass the env block (the object under `env`), not the full settings
   *  object. */
  markWritten(envBlock: Record<string, unknown>): void;
  /** One-shot inspect + broadcast. Useful from IPC handlers that mutate
   *  the file directly so they can publish the new state without
   *  waiting for the watcher's debounce window. */
  inspectAndBroadcast(): Promise<OtelDriftDetails>;
  /** Current cached state. Returns null before the first inspect. */
  getCurrent(): OtelDriftDetails | null;
}

export function createOtelSettingsWatcher(deps: OtelSettingsWatcherDeps): OtelSettingsWatcher {
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let lastEnvHash: string | null = null;
  let lastDetails: OtelDriftDetails | null = null;

  const inspect = async (): Promise<OtelDriftDetails> => {
    return await inspectClaudeOtelConfig(deps.settingsPath, deps.getSentinelExporterEndpoint());
  };

  const broadcast = (details: OtelDriftDetails): void => {
    lastDetails = details;
    deps.ipcServer.broadcast({ type: 'otel_drift_state', details });
  };

  const readEnvHash = async (): Promise<string | null> => {
    try {
      const text = await fs.readFile(deps.settingsPath, 'utf8');
      const parsed = JSON.parse(text) as unknown;
      const env =
        parsed && typeof parsed === 'object'
          ? ((parsed as Record<string, unknown>)['env'] as Record<string, unknown> | undefined)
          : undefined;
      return canonHashManagedEnv(env && typeof env === 'object' ? env : {});
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return canonHashManagedEnv({});
      }
      return null;
    }
  };

  const onWatcherEvent = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void (async () => {
        const h = await readEnvHash();
        if (h === null) return;
        if (h === lastEnvHash) return;
        lastEnvHash = h;
        const details = await inspect();
        broadcast(details);
      })();
    }, DEBOUNCE_MS);
  };

  const start = async (): Promise<void> => {
    if (active) return;
    const dir = dirname(deps.settingsPath);
    const name = basename(deps.settingsPath);
    await fs.mkdir(dir, { recursive: true });
    // fs.watch can throw on platforms that deny inotify (e.g. some
    // sandboxed runtimes). Letting it bubble up to the caller — index.ts
    // wraps the start() call in its own try/catch and logs — keeps the
    // daemon alive but with the watcher disabled.
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      if (filename.toString() !== name) return;
      onWatcherEvent();
    });
    active = true;

    // Seed + initial broadcast. Compute the hash first so a follow-up
    // watcher event for the file we just opened won't fire a redundant
    // broadcast. If inspect() throws here (TOCTOU between the two
    // reads), it propagates and start() rejects — same fate as the
    // mkdir throw above.
    lastEnvHash = await readEnvHash();
    const details = await inspect();
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

  const markWritten = (envBlock: Record<string, unknown>): void => {
    lastEnvHash = canonHashManagedEnv(envBlock);
  };

  const inspectAndBroadcast = async (): Promise<OtelDriftDetails> => {
    const details = await inspect();
    broadcast(details);
    return details;
  };

  const getCurrent = (): OtelDriftDetails | null => lastDetails;

  return { start, stop, markWritten, inspectAndBroadcast, getCurrent };
}
