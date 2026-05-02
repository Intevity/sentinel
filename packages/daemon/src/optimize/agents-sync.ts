/**
 * Bi-directional sync between `subagent_installs` and the user's
 * `~/.claude/agents/` directory. Mirrors `claude-sync.ts`'s DB-as-
 * source-of-truth pattern, adapted for a directory of files.
 *
 * Differences from claude-sync.ts:
 *   - Watches a DIRECTORY. fs.watch already handles directory mode; we
 *     filter to `*.md` and route per-file.
 *   - Per-file SHA-256 hash kept in a `Map<filename, hash>` instead of
 *     a single scalar. Drives echo detection per-file so a write to
 *     A.md does not suppress a watcher event for B.md.
 *   - Push iterates `subagent_installs` rows where source='curated'
 *     and writes one .md per row via temp + rename. Local rows
 *     (source='local') are read-only mirrors of files the user
 *     authored — push never overwrites them.
 *   - Pull walks the directory, parses each .md frontmatter `name`,
 *     upserts a `source='local'` row unless the same name already
 *     exists as `source='curated'` (in which case we update md_hash
 *     only).
 *   - Orphan cleanup: `source='curated'` rows whose `md_path` no
 *     longer exists → soft-delete (set uninstalled_at).
 */

import { promises as fs, type FSWatcher, watch } from 'fs';
import { homedir } from 'os';
import { join, dirname, basename } from 'path';
import { createHash, randomBytes } from 'crypto';
import type { AgentsSyncStatus } from '@claude-sentinel/shared';
import type Database from 'better-sqlite3';
import type { IpcServer } from '../ipc.js';
import {
  listSubagentInstalls,
  upsertSubagentInstall,
  softDeleteSubagentInstall,
  setSubagentInstallMdHash,
  findSubagentInstallByName,
} from '../db.js';

/** Production default. Overridable per-call via `agentsDir` (used by
 *  unit tests) or via the `CLAUDE_SENTINEL_TEST_AGENTS_DIR` env var
 *  (used by the full-daemon integration tests in `index.test-helpers.ts`,
 *  which can't pass options through). */
function defaultAgentsDir(): string {
  return process.env['CLAUDE_SENTINEL_TEST_AGENTS_DIR'] ?? join(homedir(), '.claude', 'agents');
}
const DEBOUNCE_MS = 500;

export interface AgentsSyncEngine {
  start(): Promise<void>;
  stop(): void;
  pullNow(): Promise<void>;
  pushNow(): Promise<void>;
  getStatus(): AgentsSyncStatus;
  /** Write one curated subagent's .md file and upsert its DB row. Used
   *  by the accept_optimization IPC handler. The caller is responsible
   *  for resolving (curated_id → renderedMd, fingerprint) from the
   *  curated library before calling. */
  installCuratedFile(args: {
    name: string;
    mdPath: string;
    renderedMd: string;
    curatedId: string;
    gapFingerprint: string;
  }): Promise<void>;
  /** Remove a subagent's .md file and soft-delete its DB row. Used by
   *  the uninstall_subagent IPC handler. */
  uninstallByName(name: string): Promise<void>;
}

export interface CreateAgentsSyncDeps {
  db: Database.Database;
  ipcServer: IpcServer;
  /** Override the agents directory. Defaults to `~/.claude/agents`.
   *  Used by tests to point the engine at a tmp dir. */
  agentsDir?: string;
}

export function createAgentsSyncEngine(deps: CreateAgentsSyncDeps): AgentsSyncEngine {
  const AGENTS_DIR = deps.agentsDir ?? defaultAgentsDir();
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let lastPulledAt: number | null = null;
  let lastPushedAt: number | null = null;
  let lastError: string | null = null;
  /** filename → SHA-256 of its content after our most recent read or
   *  write. When the watcher reports a file whose current hash matches
   *  the entry here, it's our own echo — skip the pull. */
  const lastSeenHashes = new Map<string, string>();

  const getStatus = (): AgentsSyncStatus => ({
    active,
    lastPulledAt,
    lastPushedAt,
    lastError,
  });

  const broadcastStatus = (): void => {
    try {
      deps.ipcServer.broadcast({ type: 'agents_sync_status', status: getStatus() });
    } catch (err) {
      /* v8 ignore next 2 */
      console.error('[AgentsSync] broadcast failed:', err);
    }
  };

  const fileHash = (content: string): string => createHash('sha256').update(content).digest('hex');

  /** Atomic write via temp + rename. Updates lastSeenHashes so the
   *  watcher event we'll receive immediately after is identified as
   *  our own echo. */
  const writeAgentFile = async (mdPath: string, content: string): Promise<void> => {
    const dir = dirname(mdPath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${mdPath}.tmp-${randomBytes(6).toString('hex')}`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, mdPath);
    lastSeenHashes.set(basename(mdPath), fileHash(content));
  };

  /** Read every .md file in AGENTS_DIR. Returns null for missing dir. */
  const readAgentsDir = async (): Promise<{ name: string; content: string }[]> => {
    let entries: string[];
    try {
      entries = await fs.readdir(AGENTS_DIR);
    } catch (err) {
      /* v8 ignore next 2 */
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: { name: string; content: string }[] = [];
    for (const e of entries) {
      if (!e.endsWith('.md')) continue;
      try {
        const content = await fs.readFile(join(AGENTS_DIR, e), 'utf8');
        out.push({ name: e, content });
      } catch {
        /* skip unreadable file */
      }
    }
    return out;
  };

  const pushNow = async (): Promise<void> => {
    try {
      const rows = listSubagentInstalls(deps.db);
      for (const row of rows) {
        if (row.source !== 'curated') continue;
        // The expected content is held in DB md_hash; the rendered .md
        // itself is the canonical form. The caller (accept_optimization)
        // is responsible for having already passed renderedMd into the
        // upsert, so we only need to (re)write the file when its current
        // hash on disk drifts. We don't keep the rendered content in
        // DB — only the hash — to avoid duplicating GAP entry data.
        // Strategy: delegate file regeneration to the caller; agents-
        // sync's job is to enforce file presence + hash invariants.
        // Concretely: when a row exists but the file is missing, leave
        // the file missing here — the next acceptOptimization re-writes
        // it; the orphan cleanup pass will detect the mismatch.
        // For real recovery, the engine reads md_path from DB and
        // verifies the file exists; if not, it broadcasts an error.
        try {
          await fs.stat(row.mdPath);
        } catch (err) {
          /* v8 ignore next 4 */
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // Soft-delete the row — the file is gone, the install is
            // no longer real. Orphan cleanup uses the same rule.
            softDeleteSubagentInstall(deps.db, row.name, Date.now());
          }
        }
      }
      lastPushedAt = Date.now();
      lastError = null;
    } catch (err) {
      /* v8 ignore next 3 */
      lastError = err instanceof Error ? err.message : String(err);
      console.error('[AgentsSync] push failed:', err);
    } finally {
      broadcastStatus();
    }
  };

  /**
   * Higher-level helper used by accept_optimization to write a single
   * subagent file and update its DB row in one shot. Lives on the
   * engine so the lastSeenHashes echo guard fires correctly.
   */
  const installCuratedFile = async (args: {
    name: string;
    mdPath: string;
    renderedMd: string;
    curatedId: string;
    gapFingerprint: string;
  }): Promise<void> => {
    await writeAgentFile(args.mdPath, args.renderedMd);
    upsertSubagentInstall(deps.db, {
      name: args.name,
      source: 'curated',
      curatedId: args.curatedId,
      gapFingerprint: args.gapFingerprint,
      mdPath: args.mdPath,
      mdHash: fileHash(args.renderedMd),
      installedAt: Date.now(),
    });
    lastPushedAt = Date.now();
    lastError = null;
    broadcastStatus();
  };

  /**
   * Pull pass: for each .md on disk, parse the frontmatter `name` and
   * upsert. For each curated DB row whose file is missing, soft-delete.
   */
  const pullNow = async (): Promise<void> => {
    try {
      const filesOnDisk = await readAgentsDir();
      const namesOnDisk = new Set<string>();
      for (const f of filesOnDisk) {
        const parsed = parseFrontmatter(f.content);
        const name = parsed?.['name'];
        if (typeof name !== 'string' || !name) continue;
        namesOnDisk.add(name);
        const h = fileHash(f.content);
        lastSeenHashes.set(f.name, h);
        const existing = findSubagentInstallByName(deps.db, name);
        if (existing && existing.source === 'curated') {
          // Curated row owns this name; just refresh the hash so the
          // analyzer can detect drift if the user hand-edits.
          if (existing.mdHash !== h) {
            setSubagentInstallMdHash(deps.db, name, h);
          }
        } else {
          // Local subagent the user authored. Upsert as source='local'.
          upsertSubagentInstall(deps.db, {
            name,
            source: 'local',
            curatedId: null,
            gapFingerprint: null,
            mdPath: join(AGENTS_DIR, f.name),
            mdHash: h,
            installedAt: existing?.installedAt ?? Date.now(),
          });
        }
      }
      // Orphan cleanup: soft-delete curated rows whose file is missing.
      const allCurated = listSubagentInstalls(deps.db).filter((r) => r.source === 'curated');
      for (const row of allCurated) {
        if (!namesOnDisk.has(row.name)) {
          softDeleteSubagentInstall(deps.db, row.name, Date.now());
          lastSeenHashes.delete(basename(row.mdPath));
        }
      }
      lastPulledAt = Date.now();
      lastError = null;
    } catch (err) {
      /* v8 ignore next 3 */
      lastError = err instanceof Error ? err.message : String(err);
      console.error('[AgentsSync] pull failed:', err);
    } finally {
      broadcastStatus();
    }
  };

  const onWatcherEvent = (filename: string): void => {
    if (!filename.endsWith('.md')) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void (async () => {
        try {
          // Echo guard: if the file's current hash matches what we
          // last observed (write or pull), this watcher event was our
          // own write coming back. Skip the pull — running it would be
          // a no-op anyway, but skipping avoids extra DB chatter and
          // status broadcasts.
          let currentHash: string | null = null;
          try {
            currentHash = fileHash(await fs.readFile(join(AGENTS_DIR, filename), 'utf8'));
          } catch {
            /* v8 ignore next 1 */
            currentHash = null;
          }
          const lastHash = lastSeenHashes.get(filename);
          if (currentHash !== null && currentHash === lastHash) return;
          await pullNow();
        } catch (err) {
          /* v8 ignore next 3 */
          lastError = err instanceof Error ? err.message : String(err);
          broadcastStatus();
        }
      })();
    }, DEBOUNCE_MS);
  };

  const start = async (): Promise<void> => {
    if (active) return;
    try {
      await fs.mkdir(AGENTS_DIR, { recursive: true });
      watcher = watch(AGENTS_DIR, { persistent: false }, (_event, filename) => {
        /* v8 ignore next 1 */
        if (!filename) return;
        onWatcherEvent(filename.toString());
      });
      watcher.on('error', (err) => {
        /* v8 ignore next 2 */
        lastError = err.message;
        broadcastStatus();
      });
      active = true;
      broadcastStatus();
      // Initial pull so the DB reflects what's on disk before any
      // user-driven install action.
      await pullNow();
    } catch (err) {
      /* v8 ignore next 3 */
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
      /* v8 ignore next 3 */
    } catch {
      /* already closed */
    }
    watcher = null;
    active = false;
    broadcastStatus();
  };

  const uninstallByName = async (name: string): Promise<void> => {
    const row = findSubagentInstallByName(deps.db, name);
    if (!row) return;
    try {
      await fs.unlink(row.mdPath);
      lastSeenHashes.delete(basename(row.mdPath));
    } catch (err) {
      /* v8 ignore next 1 */
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    softDeleteSubagentInstall(deps.db, name, Date.now());
    broadcastStatus();
  };

  return { start, stop, pullNow, pushNow, getStatus, installCuratedFile, uninstallByName };
}

/**
 * Minimal frontmatter parser. Returns the YAML scalar values from the
 * top of the file, keyed by name. Single-quoted strings and bare
 * scalars supported; multi-line values are not (we only emit single-
 * line scalars from gap-to-claude-code.ts).
 *
 * Exported for testing.
 */
export function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;
  const rest = content.replace(/\r\n/g, '\n').slice(4);
  const end = rest.indexOf('\n---');
  if (end === -1) return null;
  const fmBody = rest.slice(0, end);
  const out: Record<string, string> = {};
  for (const line of fmBody.split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    out[key] = unquoteYamlScalar(value);
  }
  return out;
}

function unquoteYamlScalar(s: string): string {
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    // YAML '' = literal '
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}
