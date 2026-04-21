/**
 * Bi-directional sync between Sentinel's `permission_rules` table
 * and Claude Code's `~/.claude/settings.json#/permissions` object.
 *
 * Design notes:
 *   - Claude Code uses `{ permissions: { allow: [], deny: [], ask: [] } }`
 *     with each entry being a rule-string (e.g. `"Bash(rm -rf *)"`).
 *     Sentinel's `PermissionRule.raw` already matches that format, so
 *     translation is a one-liner in each direction.
 *   - Watcher is `fs.watch` on the PARENT directory filtered to the
 *     settings.json filename. Watching the file directly loses events
 *     on atomic writes (temp + rename), which Claude Code uses.
 *   - Loop prevention: both directions hash the canonical permissions
 *     block after a successful write; when the watcher sees a file
 *     whose current hash matches `lastSeenHash`, it's our own echo and
 *     we skip the pull.
 *   - Ownership: the `source` column on `permission_rules` tracks
 *     whether a row came from Claude Code's file or was authored
 *     locally. A pull deletes orphan `source='claude-code'` rows (the
 *     file dropped them) but leaves `source='local'` untouched.
 */

import { promises as fs, type FSWatcher, watch } from 'fs';
import { homedir } from 'os';
import { join, dirname, basename } from 'path';
import { createHash, randomBytes } from 'crypto';
import type { ClaudeSyncStatus, PermissionDecision, PermissionRule } from '@claude-sentinel/shared';
import type Database from 'better-sqlite3';
import type { IpcServer } from '../../ipc.js';
import { listPermissionRules, upsertPermissionRule, deletePermissionRule } from '../../db.js';
import { parseRule } from './parser.js';

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
/** 500 ms after the last watcher event we treat the file as settled
 *  and actually pull. Coalesces bursts — editors emit multiple events
 *  per save (write, attribute-change, sometimes rename-in-place). */
const DEBOUNCE_MS = 500;

/** Shape of the permissions block we read/write. Each array holds
 *  raw rule strings compatible with Sentinel's parser. */
interface PermissionsBlock {
  allow: string[];
  deny: string[];
  ask: string[];
}

const EMPTY_PERMISSIONS: PermissionsBlock = { allow: [], deny: [], ask: [] };

export interface ClaudeSyncEngine {
  /** Attach the watcher and run an initial pull (as a merge). Emits
   *  a `claude_sync_status` broadcast on every state change. */
  start(opts?: { initialMode?: 'merge' | 'import' | 'export' }): Promise<void>;
  /** Detach the watcher. Safe to call when not started. */
  stop(): void;
  /** Force a one-shot pull. `mode` defaults to 'merge'. */
  pullNow(mode?: 'merge' | 'import' | 'export'): Promise<void>;
  /** Force a one-shot push. Called automatically after every local
   *  mutation when the engine is active. */
  pushNow(): Promise<void>;
  /** Current status snapshot. Safe to call at any time. */
  getStatus(): ClaudeSyncStatus;
}

export interface CreateClaudeSyncDeps {
  db: Database.Database;
  ipcServer: IpcServer;
  /** Call after any pull that mutates the DB so the enforcer's
   *  compiled-rules cache drops its stale view. */
  invalidateRuleCache: () => void;
}

export function createClaudeSyncEngine(deps: CreateClaudeSyncDeps): ClaudeSyncEngine {
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let lastPulledAt: number | null = null;
  let lastPushedAt: number | null = null;
  let lastError: string | null = null;
  /** SHA-256 of the canonical permissions block after the most recent
   *  successful read or write. Drives loop detection. */
  let lastSeenHash: string | null = null;

  const getStatus = (): ClaudeSyncStatus => ({
    active,
    lastPulledAt,
    lastPushedAt,
    lastError,
  });

  const broadcastStatus = (): void => {
    try {
      deps.ipcServer.broadcast({ type: 'claude_sync_status', status: getStatus() });
    } catch (err) {
      console.error('[ClaudeSync] broadcast failed:', err);
    }
  };

  const canonHash = (perms: PermissionsBlock): string => {
    // Sort each array so permutation doesn't produce a hash diff.
    // Serialize in a stable shape so adding/removing unrelated
    // properties at write-time can't cause false positives.
    const canon = {
      allow: [...perms.allow].sort(),
      deny: [...perms.deny].sort(),
      ask: [...perms.ask].sort(),
    };
    return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
  };

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

  const extractPermissions = (obj: Record<string, unknown>): PermissionsBlock => {
    const p = obj['permissions'] as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return { ...EMPTY_PERMISSIONS };
    const coerce = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return {
      allow: coerce(p['allow']),
      deny: coerce(p['deny']),
      ask: coerce(p['ask']),
    };
  };

  /** Atomic write via temp file + rename. Mirrors the pattern used by
   *  `settings_patch.rs` on the Rust side so we don't race with a
   *  concurrent Claude Code write. Preserves every top-level key
   *  other than `permissions`. */
  const writePermissionsToFile = async (perms: PermissionsBlock): Promise<void> => {
    const current = await readFileAsJson();
    current['permissions'] = {
      // Sort for stable diffs in git and to keep the lastSeenHash
      // stable across rebuilds from the same rule set.
      allow: [...perms.allow].sort(),
      deny: [...perms.deny].sort(),
      ask: [...perms.ask].sort(),
    };
    const json = `${JSON.stringify(current, null, 2)}\n`;
    const dir = dirname(SETTINGS_PATH);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${SETTINGS_PATH}.tmp-${randomBytes(6).toString('hex')}`;
    await fs.writeFile(tmp, json, 'utf8');
    await fs.rename(tmp, SETTINGS_PATH);
    lastSeenHash = canonHash(perms);
  };

  /** Parse one `permissions.allow/deny/ask` entry into a PermissionRule
   *  input. Returns null for malformed strings — logged but silent to
   *  avoid spamming on every watcher tick if the user has a typo. */
  const ruleFromEntry = (
    rawEntry: string,
    decision: PermissionDecision,
  ): { raw: string; decision: PermissionDecision; tool: string; pattern: string | null } | null => {
    const trimmed = rawEntry.trim();
    if (!trimmed) return null;
    const res = parseRule(trimmed);
    if (!res.ok) {
      console.warn(`[ClaudeSync] skipping malformed rule "${trimmed}": ${res.error}`);
      return null;
    }
    return { decision, ...res.parsed };
  };

  const pullNow = async (mode: 'merge' | 'import' | 'export' = 'merge'): Promise<void> => {
    try {
      // EXPORT-first: user chose their rules as the source of truth at
      // enable-time; don't read the file on this pass.
      if (mode === 'export') {
        await pushNow();
        return;
      }

      const raw = await readFileAsJson();
      const perms = extractPermissions(raw);
      lastSeenHash = canonHash(perms);

      const incoming: Array<{
        raw: string;
        decision: PermissionDecision;
        tool: string;
        pattern: string | null;
      }> = [];
      for (const e of perms.allow) {
        const r = ruleFromEntry(e, 'allow');
        if (r) incoming.push(r);
      }
      for (const e of perms.deny) {
        const r = ruleFromEntry(e, 'deny');
        if (r) incoming.push(r);
      }
      for (const e of perms.ask) {
        const r = ruleFromEntry(e, 'ask');
        if (r) incoming.push(r);
      }

      // Build a set of incoming canonical keys so we can spot orphans.
      const incomingKeys = new Set(incoming.map((r) => `${r.decision}|${r.raw}`));

      const existing = listPermissionRules(deps.db);
      const existingByKey = new Map<string, PermissionRule>();
      for (const r of existing) existingByKey.set(`${r.decision}|${r.raw}`, r);

      // Upsert each incoming rule. MERGE and IMPORT differ only in what
      // happens to rules that exist with `source='local'`: in IMPORT we
      // overwrite them to `source='claude-code'` (treating the file as
      // truth); in MERGE we leave them alone (keep them as user-owned).
      for (const inc of incoming) {
        const key = `${inc.decision}|${inc.raw}`;
        const current = existingByKey.get(key);
        if (current && current.source === 'local' && mode === 'merge') {
          continue; // user-authored identical rule — leave ownership alone
        }
        const input: Parameters<typeof upsertPermissionRule>[1] = {
          decision: inc.decision,
          tool: inc.tool,
          pattern: inc.pattern,
          raw: inc.raw,
          source: 'claude-code',
        };
        if (current) input.id = current.id;
        upsertPermissionRule(deps.db, input);
      }

      // Delete orphans: rules marked claude-code that vanished from
      // the file. Local rules are untouched regardless of file state.
      for (const r of existing) {
        if (r.source !== 'claude-code') continue;
        const key = `${r.decision}|${r.raw}`;
        if (!incomingKeys.has(key)) {
          deletePermissionRule(deps.db, r.id);
        }
      }

      deps.invalidateRuleCache();
      try {
        deps.ipcServer.broadcast({
          type: 'permission_rules_changed',
          rules: listPermissionRules(deps.db),
        });
      } catch {
        /* non-fatal */
      }
      lastPulledAt = Date.now();
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error('[ClaudeSync] pull failed:', err);
    } finally {
      broadcastStatus();
    }
  };

  const pushNow = async (): Promise<void> => {
    try {
      const rules = listPermissionRules(deps.db).filter((r) => r.enabled);
      const perms: PermissionsBlock = {
        allow: rules.filter((r) => r.decision === 'allow').map((r) => r.raw),
        deny: rules.filter((r) => r.decision === 'deny').map((r) => r.raw),
        ask: rules.filter((r) => r.decision === 'ask').map((r) => r.raw),
      };
      const nextHash = canonHash(perms);
      if (nextHash === lastSeenHash) {
        // No net change vs. what's on disk. Skip the write to avoid
        // triggering a watcher echo.
        return;
      }
      await writePermissionsToFile(perms);
      lastPushedAt = Date.now();
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error('[ClaudeSync] push failed:', err);
    } finally {
      broadcastStatus();
    }
  };

  const onWatcherEvent = (): void => {
    // Debounce: editors emit multiple events per save; we only want to
    // pull once after the dust settles.
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void (async () => {
        try {
          const raw = await readFileAsJson();
          const perms = extractPermissions(raw);
          const h = canonHash(perms);
          if (h === lastSeenHash) return; // our own echo
          await pullNow('merge');
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          broadcastStatus();
        }
      })();
    }, DEBOUNCE_MS);
  };

  const start = async (opts?: { initialMode?: 'merge' | 'import' | 'export' }): Promise<void> => {
    if (active) return;
    try {
      const dir = dirname(SETTINGS_PATH);
      const name = basename(SETTINGS_PATH);
      // Ensure the directory exists so watch() doesn't ENOENT on
      // first-run installs that haven't started Claude Code yet.
      await fs.mkdir(dir, { recursive: true });
      watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        if (filename.toString() !== name) return;
        onWatcherEvent();
      });
      watcher.on('error', (err) => {
        lastError = err.message;
        broadcastStatus();
      });
      active = true;
      broadcastStatus();
      // Initial reconciliation — honours the user's first-enable
      // choice (merge / import / export).
      await pullNow(opts?.initialMode ?? 'merge');
      // If that pass didn't already write out (export mode triggers a
      // push internally), make sure the file reflects our state so
      // subsequent local edits have a stable baseline to diff from.
      if ((opts?.initialMode ?? 'merge') !== 'export') {
        await pushNow();
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      broadcastStatus();
    }
  };

  const stop = (): void => {
    if (!active) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
    watcher = null;
    active = false;
    broadcastStatus();
  };

  return { start, stop, pullNow, pushNow, getStatus };
}
