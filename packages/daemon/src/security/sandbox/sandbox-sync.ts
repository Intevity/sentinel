/**
 * Leg A of the sandbox feature: keeps Sentinel's canonical {@link IsolationPolicy}
 * in sync with Claude Code's own native sandbox via `~/.claude/settings.json#/sandbox`.
 * Modeled directly on `permissions/claude-sync.ts`:
 *
 *   - **Push** (Sentinel → file) writes the *complete* `sandbox` block via
 *     {@link toClaudeCodeSandboxBlock}, preserving every other top-level key in
 *     the file. Fired after any local policy mutation while the engine is active.
 *   - **Pull** (file → Sentinel) reconciles a hand-edited `sandbox` block back
 *     into the policy via {@link applyPulledSandboxContent}. All automatic pulls
 *     use **merge** (union) semantics so no policy content is ever wiped; the
 *     three control flags (`enabled`/`syncToClaudeCode`/`enforceCodeMode`) are
 *     Sentinel-owned and never driven by the file. Removing an entry is done in
 *     the Sentinel UI — a file-side removal is re-asserted on the next push.
 *   - **First enable** honors a one-time merge/import/export choice (modal),
 *     gated by a `_migrations` marker so it can't clobber a hand-configured
 *     `sandbox` block on every start.
 *   - **Loop prevention**: after each push we record the SHA-256 of the canonical
 *     content; a watcher event whose file hash matches it is our own echo.
 *   - **Watcher**: `fs.watch` on the PARENT dir filtered to the filename, so
 *     atomic temp+rename writes (which Claude Code uses) aren't missed.
 */

import { promises as fs, type FSWatcher, watch } from 'fs';
import { homedir } from 'os';
import { join, dirname, basename } from 'path';
import { createHash, randomBytes } from 'crypto';
import type { ClaudeSyncStatus, IsolationPolicy } from '@sentinel/shared';
import type Database from 'better-sqlite3';
import type { IpcServer } from '../../ipc.js';
import {
  toClaudeCodeSandboxBlock,
  fromClaudeCodeSandboxBlock,
  applyPulledSandboxContent,
  type ParsedSandboxContent,
} from './policy-map.js';

const DEFAULT_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
/** 500 ms after the last watcher event we treat the file as settled and pull.
 *  Coalesces the multi-event bursts editors emit per save. */
const DEBOUNCE_MS = 500;
/** One-time first-enable reconciliation marker (per security DB). */
const INITIAL_IMPORT_MARKER = 'sandbox_initial_import_v1';

export type SandboxSyncMode = 'merge' | 'import' | 'export';

/** Normalize a thrown value to a message string for status reporting. */
export function formatSyncError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SandboxSyncEngine {
  /** Attach the watcher and run the first-enable reconciliation (or a steady-state
   *  merge pull on later starts). Emits `sandbox_sync_status` on every change. */
  start(opts?: { initialMode?: SandboxSyncMode }): Promise<void>;
  /** Detach the watcher. Safe to call when not started. */
  stop(): void;
  /** Force a one-shot pull. `mode` defaults to 'merge'. */
  pullNow(mode?: SandboxSyncMode): Promise<void>;
  /** Force a one-shot push. Called after every local policy mutation when active. */
  pushNow(): Promise<void>;
  /** Current status snapshot. Safe at any time. */
  getStatus(): ClaudeSyncStatus;
}

export interface CreateSandboxSyncDeps {
  /** Security DB — used only for the one-time first-enable `_migrations` marker. */
  db: Database.Database;
  ipcServer: IpcServer;
  /** Read the current canonical policy (Sentinel settings). */
  getPolicy: () => IsolationPolicy;
  /** Persist a policy updated by a pull. The daemon wires this to
   *  `updateSettings` + Leg B re-init + a `settings_changed` broadcast. */
  setPolicy: (policy: IsolationPolicy) => void;
  /** Override the Claude Code settings.json path (tests). */
  settingsPath?: string;
}

export function createSandboxSyncEngine(deps: CreateSandboxSyncDeps): SandboxSyncEngine {
  const SETTINGS_PATH = deps.settingsPath ?? DEFAULT_SETTINGS_PATH;
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let lastPulledAt: number | null = null;
  let lastPushedAt: number | null = null;
  let lastError: string | null = null;
  /** SHA-256 of the canonical content after the most recent push. Drives echo
   *  detection so our own writes don't trigger a pull. */
  let lastSeenHash: string | null = null;
  /** Set by stop(); checked by an in-flight start() after each await so a
   *  stop() that races start()'s `await fs.mkdir` can't leak a watcher. */
  let disposed = false;
  /** Bumped by stop(). Async pull/push paths capture the generation at entry
   *  and bail after each await when it moved — in-flight work belonging to a
   *  stopped engine must never write. (A late write resolves the settings
   *  path from the env seams at call time, so in tests it lands on the NEXT
   *  daemon's freshly-seeded file — the order-dependent sandbox-sync flake;
   *  in production it races shutdown.) A FRESH pullNow after stop() still
   *  works: it captures the post-stop generation. */
  let generation = 0;

  const getStatus = (): ClaudeSyncStatus => ({ active, lastPulledAt, lastPushedAt, lastError });

  const broadcastStatus = (): void => {
    try {
      deps.ipcServer.broadcast({ type: 'sandbox_sync_status', status: getStatus() });
    } catch (err) {
      console.error('[SandboxSync] broadcast failed:', err);
    }
  };

  /** Stable hash over the canonical content snapshot. Sorts arrays and
   *  normalizes absent passthrough keys to null so push and pull agree. */
  const canonHash = (s: ParsedSandboxContent): string => {
    const canon = {
      enabled: s.claudeCodeEnabled,
      network: {
        allowedDomains: [...s.network.allowedDomains].sort(),
        deniedDomains: [...s.network.deniedDomains].sort(),
      },
      filesystem: {
        allowWrite: [...s.filesystem.allowWrite].sort(),
        denyWrite: [...s.filesystem.denyWrite].sort(),
        denyRead: [...s.filesystem.denyRead].sort(),
        allowRead: [...s.filesystem.allowRead].sort(),
      },
      credentials: {
        files: [...s.credentials.files].sort(),
        envVars: [...s.credentials.envVars].sort(),
      },
      claudeCode: s.claudeCode
        ? {
            failIfUnavailable: s.claudeCode.failIfUnavailable ?? null,
            allowUnsandboxedCommands: s.claudeCode.allowUnsandboxedCommands ?? null,
            excludedCommands: s.claudeCode.excludedCommands
              ? [...s.claudeCode.excludedCommands].sort()
              : null,
            allowAppleEvents: s.claudeCode.allowAppleEvents ?? null,
          }
        : null,
    };
    return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
  };

  /** A canonical snapshot of the live policy, for hashing / echo detection. */
  const policyToSnapshot = (p: IsolationPolicy): ParsedSandboxContent => ({
    claudeCodeEnabled: p.enabled,
    network: p.network,
    filesystem: p.filesystem,
    credentials: p.credentials,
    ...(p.claudeCode ? { claudeCode: p.claudeCode } : {}),
  });

  const readFileAsJson = async (): Promise<Record<string, unknown>> => {
    try {
      const text = await fs.readFile(SETTINGS_PATH, 'utf8');
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  };

  /** Atomic write via temp file + rename. Preserves every top-level key other
   *  than `sandbox`. Sorts arrays for stable diffs. */
  const writeSandboxToFile = async (policy: IsolationPolicy, gen: number): Promise<void> => {
    const block = toClaudeCodeSandboxBlock(policy);
    const current = await readFileAsJson();
    if (generation !== gen) return; // stop() ran while reading — never write
    current['sandbox'] = {
      enabled: block.enabled,
      network: {
        allowedDomains: [...block.network.allowedDomains].sort(),
        deniedDomains: [...block.network.deniedDomains].sort(),
      },
      filesystem: {
        allowWrite: [...block.filesystem.allowWrite].sort(),
        denyWrite: [...block.filesystem.denyWrite].sort(),
        denyRead: [...block.filesystem.denyRead].sort(),
        allowRead: [...block.filesystem.allowRead].sort(),
      },
      credentials: {
        files: [...block.credentials.files].sort((a, b) => a.path.localeCompare(b.path)),
        envVars: [...block.credentials.envVars].sort((a, b) => a.name.localeCompare(b.name)),
      },
      ...(block.failIfUnavailable !== undefined
        ? { failIfUnavailable: block.failIfUnavailable }
        : {}),
      ...(block.allowUnsandboxedCommands !== undefined
        ? { allowUnsandboxedCommands: block.allowUnsandboxedCommands }
        : {}),
      ...(block.excludedCommands !== undefined
        ? { excludedCommands: [...block.excludedCommands].sort() }
        : {}),
      ...(block.allowAppleEvents !== undefined ? { allowAppleEvents: block.allowAppleEvents } : {}),
    };
    const json = `${JSON.stringify(current, null, 2)}\n`;
    const dir = dirname(SETTINGS_PATH);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${SETTINGS_PATH}.tmp-${randomBytes(6).toString('hex')}`;
    await fs.writeFile(tmp, json, 'utf8');
    await fs.rename(tmp, SETTINGS_PATH);
    lastSeenHash = canonHash(policyToSnapshot(policy));
  };

  const pushNow = async (): Promise<void> => {
    const gen = generation;
    try {
      await writeSandboxToFile(deps.getPolicy(), gen);
      if (generation !== gen) return; // write suppressed: stop() ran mid-flight
      lastPushedAt = Date.now();
      lastError = null;
      broadcastStatus();
    } catch (err) {
      lastError = formatSyncError(err);
      broadcastStatus();
      throw err;
    }
  };

  const pullNow = async (mode: SandboxSyncMode = 'merge'): Promise<void> => {
    const gen = generation;
    if (mode === 'export') {
      // Sentinel wins: don't read the file, just assert our policy onto it.
      await pushNow();
      return;
    }
    try {
      const obj = await readFileAsJson();
      // Same straddle guard as writeSandboxToFile: never setPolicy (which
      // persists via writeSettings, resolving its path at call time) after
      // stop() — an in-flight debounced pull outliving shutdown otherwise
      // leaks this engine's policy into unrelated state.
      if (generation !== gen) return;
      const parsed = fromClaudeCodeSandboxBlock(obj['sandbox']);
      const merged = applyPulledSandboxContent(deps.getPolicy(), parsed, mode);
      deps.setPolicy(merged);
      lastPulledAt = Date.now();
      lastError = null;
      broadcastStatus();
    } catch (err) {
      lastError = formatSyncError(err);
      broadcastStatus();
      throw err;
    }
  };

  const onWatcherEvent = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void (async () => {
        const gen = generation;
        try {
          const obj = await readFileAsJson();
          const h = canonHash(fromClaudeCodeSandboxBlock(obj['sandbox']));
          if (h === lastSeenHash) return; // our own echo
          if (generation !== gen) return; // stopped while reading — don't pull
          await pullNow('merge');
        } catch (err) {
          lastError = formatSyncError(err);
          broadcastStatus();
        }
      })();
    }, DEBOUNCE_MS);
  };

  const hasInitialImportRun = (): boolean => {
    const row = deps.db
      .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
      .get(INITIAL_IMPORT_MARKER) as { ok: number } | undefined;
    return !!row;
  };

  const markInitialImportRun = (): void => {
    deps.db
      .prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
      .run(INITIAL_IMPORT_MARKER, Date.now());
  };

  const start = async (opts?: { initialMode?: SandboxSyncMode }): Promise<void> => {
    if (active) return;
    disposed = false;
    try {
      const dir = dirname(SETTINGS_PATH);
      const name = basename(SETTINGS_PATH);
      await fs.mkdir(dir, { recursive: true });
      // stop() may have run while we awaited mkdir — bail before attaching a
      // watcher that nothing would ever close.
      if (disposed) return;
      watcher = watch(dir, { persistent: false }, (_event, filename) => {
        /* v8 ignore next -- fs.watch can emit a null filename on some platforms; not reproducible in CI */
        if (!filename) return;
        if (filename.toString() !== name) return;
        onWatcherEvent();
      });
      /* v8 ignore start -- FSWatcher 'error' events are platform/FS-dependent and not deterministically reproducible */
      watcher.on('error', (err) => {
        lastError = err.message;
        broadcastStatus();
      });
      /* v8 ignore stop */
      active = true;
      broadcastStatus();

      if (!hasInitialImportRun()) {
        // First enable: honor the user's merge/import/export choice once.
        const mode = opts?.initialMode ?? 'merge';
        await pullNow(mode);
        if (mode !== 'export') await pushNow();
        markInitialImportRun();
      } else {
        // Steady state (restart): absorb any offline additions, then push a
        // complete, normalized block so later edits diff against a stable base.
        await pullNow('merge');
        await pushNow();
      }
    } catch (err) {
      lastError = formatSyncError(err);
      broadcastStatus();
    }
  };

  const stop = (): void => {
    disposed = true;
    generation++;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    /* v8 ignore start -- defensive: watcher.close() throwing on an already-closed handle isn't reproducible in CI */
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
    /* v8 ignore stop */
    watcher = null;
    if (!active) return;
    active = false;
    broadcastStatus();
  };

  return { start, stop, pullNow, pushNow, getStatus };
}
