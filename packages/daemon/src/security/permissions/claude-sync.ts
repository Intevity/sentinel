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

import {
  promises as fs,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  type FSWatcher,
  watch,
} from 'fs';
import { homedir } from 'os';
import { join, dirname, basename } from 'path';
import { createHash, randomBytes } from 'crypto';
import type { ClaudeSyncStatus, PermissionDecision, PermissionRule } from '@sentinel/shared';
import type Database from 'better-sqlite3';
import type { IpcServer } from '../../ipc.js';
import { listPermissionRules, upsertPermissionRule, deletePermissionRule } from '../../db.js';
import { parseRule } from './parser.js';

const DEFAULT_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
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

/**
 * Idempotently add or remove specific entries in a Claude Code settings file's
 * `permissions.allow` array, WITHOUT disturbing any other key — every other
 * top-level key, and every other `permissions` sub-key (`deny`, `ask`,
 * `defaultMode`, `additionalDirectories`, …), is preserved verbatim.
 *
 * This is for Sentinel's OWN read-only / loopback-gated infrastructure tools
 * (the `mcp__sentinel__retrieve` tool and the code-mode curl endpoint), which
 * must be allow-listed so Claude Code — including subagents, which don't
 * inherit a project-local grant — never prompts for them. It runs even when
 * bi-directional settings-sync is disabled, because auto-allowing Sentinel's
 * own plumbing is not the same as mirroring the user's broader permission
 * ruleset: we only ever touch these specific entries, never the rest.
 *
 * Synchronous + atomic (temp file + rename) so callers stay simple and tests
 * observe the write immediately. Returns true iff the file changed.
 */
function mutateClaudeSettingsAllow(
  entries: readonly string[],
  op: 'add' | 'remove',
  settingsPath: string,
): boolean {
  if (entries.length === 0) return false;

  let root: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') root = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Missing file: nothing to remove; an add starts from an empty object.
    if (op === 'remove') return false;
  }

  const permsRaw = root['permissions'];
  const perms: Record<string, unknown> =
    permsRaw && typeof permsRaw === 'object' ? { ...(permsRaw as Record<string, unknown>) } : {};
  const allow = Array.isArray(perms['allow'])
    ? (perms['allow'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  let next: string[];
  if (op === 'add') {
    const missing = entries.filter((e) => !allow.includes(e));
    if (missing.length === 0) return false; // already present — no-op
    next = [...allow, ...missing];
  } else {
    const drop = new Set(entries);
    if (!allow.some((e) => drop.has(e))) return false; // nothing to remove — no-op
    next = allow.filter((e) => !drop.has(e));
  }

  perms['allow'] = next;
  root['permissions'] = perms;
  const json = `${JSON.stringify(root, null, 2)}\n`;
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, json, 'utf8');
  renameSync(tmp, settingsPath);
  return true;
}

/** Ensure every entry in `entries` is present in the file's
 *  `permissions.allow`. Idempotent; preserves all other keys. Returns true iff
 *  the file changed. See {@link mutateClaudeSettingsAllow}. */
export function ensureClaudeSettingsAllow(
  entries: readonly string[],
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): boolean {
  return mutateClaudeSettingsAllow(entries, 'add', settingsPath);
}

/** Remove every entry in `entries` from the file's `permissions.allow`, if
 *  present. Idempotent; preserves all other keys. Returns true iff the file
 *  changed. See {@link mutateClaudeSettingsAllow}. */
export function removeClaudeSettingsAllow(
  entries: readonly string[],
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): boolean {
  return mutateClaudeSettingsAllow(entries, 'remove', settingsPath);
}

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
  /** Override the settings.json path. Defaults to
   *  `~/.claude/settings.json`. Used by tests to point the engine
   *  at a temporary file. */
  settingsPath?: string;
}

export function createClaudeSyncEngine(deps: CreateClaudeSyncDeps): ClaudeSyncEngine {
  const SETTINGS_PATH = deps.settingsPath ?? DEFAULT_SETTINGS_PATH;
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

      // Build an incoming map keyed on `raw` (the canonical rule
      // identity — a rule's raw text uniquely identifies it). File
      // duplicates (historical triplication bug) collapse to one entry.
      // If the same raw appears across decision buckets (shouldn't
      // normally happen but defensive), deny wins over ask wins over
      // allow — the most restrictive intent is preserved.
      const incomingByRaw = new Map<
        string,
        { raw: string; decision: PermissionDecision; tool: string; pattern: string | null }
      >();
      const ingest = (entries: string[], decision: PermissionDecision): void => {
        for (const e of entries) {
          const r = ruleFromEntry(e, decision);
          if (r && !incomingByRaw.has(r.raw)) incomingByRaw.set(r.raw, r);
        }
      };
      ingest(perms.deny, 'deny');
      ingest(perms.ask, 'ask');
      ingest(perms.allow, 'allow');

      const existing = listPermissionRules(deps.db);
      const existingByRaw = new Map<string, PermissionRule>();
      for (const r of existing) existingByRaw.set(r.raw, r);

      // Upsert each incoming rule keyed on raw. MERGE and IMPORT differ
      // only in source: IMPORT flips local rules to claude-code (file
      // becomes authoritative for future orphan cleanup); MERGE keeps
      // local rules owned by the UI so a subsequent file deletion
      // doesn't silently remove them. In both modes the file's
      // decision wins — that's the whole point of pulling from the
      // file, and the fix for the historical bug where re-classifying
      // a rule across buckets produced a duplicate row.
      //
      // ask rules are always Sentinel-managed — we never push them to
      // the file, so the file can't own them. Force source='local' on
      // ask regardless of pull mode to keep ownership consistent with
      // where they live.
      for (const inc of incomingByRaw.values()) {
        const current = existingByRaw.get(inc.raw);
        const source =
          inc.decision === 'ask'
            ? 'local'
            : mode === 'import'
              ? 'claude-code'
              : (current?.source ?? 'claude-code');
        const input: Parameters<typeof upsertPermissionRule>[1] = {
          decision: inc.decision,
          tool: inc.tool,
          pattern: inc.pattern,
          raw: inc.raw,
          source,
        };
        if (current) input.id = current.id;
        upsertPermissionRule(deps.db, input);
      }

      // Delete orphans: rules marked claude-code that vanished from
      // the file. Local rules are untouched regardless of file state
      // — the UI is their source of truth and only the UI can remove
      // them. ask rules are likewise immune: they're never in the
      // file, so file-absence isn't a signal that they were deleted.
      for (const r of existing) {
        if (r.source !== 'claude-code') continue;
        if (r.decision === 'ask') continue;
        if (!incomingByRaw.has(r.raw)) {
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
      // ask rules are Sentinel-only and never sync to the file. The
      // Sentinel UI is the single surface for approval prompts so
      // that remote-approval integrations (Slack, etc.) have one
      // place to plug into. Claude Code still handles allow/deny
      // since those need no user interaction.
      const perms: PermissionsBlock = {
        allow: rules.filter((r) => r.decision === 'allow').map((r) => r.raw),
        deny: rules.filter((r) => r.decision === 'deny').map((r) => r.raw),
        ask: [],
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

  /** One-time upgrade migration for beta users whose settings.json was
   *  left in an inconsistent state by the legacy sync (duplicated
   *  entries, same-raw-different-decision bugs). Treats the file as
   *  the source of truth for this one pull — rules imported flip to
   *  `source='claude-code'`, so future orphan cleanup is driven by the
   *  file. Idempotent: the marker in `_migrations` keeps it from
   *  running twice against the same DB. Returns true when it actually
   *  ran (for logging / status). */
  const runUpgradeMigrationIfNeeded = async (): Promise<boolean> => {
    const MARKER = 'claude_sync_file_wins_v1';
    const applied = deps.db
      .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
      .get(MARKER) as { ok: number } | undefined;
    if (applied) return false;
    try {
      await pullNow('import');
      await pushNow();
      deps.db
        .prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(MARKER, Date.now());
      console.log('[ClaudeSync] upgrade migration applied: file-wins-once reconciliation');
      return true;
    } catch (err) {
      // Don't mark the migration applied if it failed — we'll retry
      // next startup. Surface the error via the normal status channel.
      lastError = err instanceof Error ? err.message : String(err);
      console.error('[ClaudeSync] upgrade migration failed:', err);
      broadcastStatus();
      return false;
    }
  };

  /** One-time migration that promotes the broad Bash wildcard denies
   *  shipped by the Medium/High presets into Sentinel-managed `ask`
   *  rules. A flat deny prevents legitimate one-offs (e.g. a user who
   *  genuinely wants `rm -rf /tmp/build-output`); ask surfaces the
   *  prompt through Sentinel's approval UI instead. Ask rules are
   *  Sentinel-only by contract, so the follow-up push strips the
   *  flipped raws out of `settings.json` and Claude Code stops
   *  enforcing them directly.
   *
   *  Targets an exact raw list so we don't sweep up user-authored
   *  wildcard denies. Idempotent via `_migrations`; marker is inserted
   *  even when no rows matched so a later-added deny row isn't
   *  retroactively flipped. */
  const runWildcardToAskMigrationIfNeeded = async (): Promise<boolean> => {
    const MARKER = 'wildcard_denies_to_ask_v1';
    const WILDCARD_ASK_RAWS = [
      'Bash(rm -rf *)',
      'Bash(sudo *)',
      'Bash(chmod 777 *)',
      'Bash(curl * | bash)',
      'Bash(curl * | sh)',
      'Bash(wget * | bash)',
      'Bash(wget * | sh)',
    ];
    const applied = deps.db
      .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
      .get(MARKER) as { ok: number } | undefined;
    if (applied) return false;
    try {
      const placeholders = WILDCARD_ASK_RAWS.map(() => '?').join(',');
      const res = deps.db
        .prepare(
          `UPDATE permission_rules
           SET decision = 'ask', source = 'local'
           WHERE decision = 'deny' AND raw IN (${placeholders})`,
        )
        .run(...WILDCARD_ASK_RAWS);
      deps.db
        .prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(MARKER, Date.now());
      if (res.changes > 0) {
        deps.invalidateRuleCache();
        await pushNow();
        console.log(`[ClaudeSync] wildcard-to-ask migration flipped ${res.changes} rule(s) to ask`);
      }
      return res.changes > 0;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error('[ClaudeSync] wildcard-to-ask migration failed:', err);
      broadcastStatus();
      return false;
    }
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
      // Run the one-time upgrade migration before the normal initial
      // pull. It's a no-op after the first run. Only runs when sync
      // is enabled because the start() caller gates on that — if the
      // user has sync off, Sentinel shouldn't touch their file.
      const migrated = await runUpgradeMigrationIfNeeded();
      // Wildcard-to-ask runs after the upgrade migration so the DB
      // already reflects file state; otherwise we might flip a row
      // that the very next pull re-imports as deny.
      await runWildcardToAskMigrationIfNeeded();
      if (!migrated) {
        // Initial reconciliation — honours the user's first-enable
        // choice (merge / import / export).
        await pullNow(opts?.initialMode ?? 'merge');
        // If that pass didn't already write out (export mode triggers a
        // push internally), make sure the file reflects our state so
        // subsequent local edits have a stable baseline to diff from.
        if ((opts?.initialMode ?? 'merge') !== 'export') {
          await pushNow();
        }
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
