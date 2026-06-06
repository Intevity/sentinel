/**
 * Join the three MCP signals into one per-server insight for the Optimize
 * page's Context tab:
 *
 *   1. Config presence — `detectMcpServers` (per-project) plus the top-level
 *      `mcpServers` (user scope) that the detector deliberately skips.
 *   2. Measured static definition cost — `ContextCostStore`, parsed from live
 *      request tools[] arrays by the proxy observer.
 *   3. Observed usage — `estimateMcpCosts` over `tool_calls` (7d).
 *
 * The join key is Claude Code's sanitized server name: tool names are
 * `mcp__<server>__<tool>` where `<server>` has every character outside
 * [A-Za-z0-9_-] replaced with `_` (e.g. `plugin:mongodb:mongodb` →
 * `plugin_mongodb_mongodb`). Config names are sanitized before matching;
 * the display name stays the config spelling when known.
 *
 * Cost framing is deliberately honest about prompt caching: definitions are
 * cache READS on most requests (cheap), so the headline is the context-window
 * tax in tokens. The only recurring dollar cost is cache-WRITE amplification
 * when the prefix re-writes (≈ once per session), estimated conservatively
 * and rendered with a `~` prefix by the UI.
 */

import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type {
  CodeModeMigration,
  McpContextCosts,
  McpContextInsight,
  McpContextSavings,
  McpRecommendationBadge,
  MetricsWindow,
} from '@claude-sentinel/shared';
import { estimateTokensFromBytes } from '@claude-sentinel/shared';
import { getClaudeJsonPath } from '../claude-state.js';
import {
  getBaseInputPricePerMillion,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
} from '../cache-ttl/pricing.js';
import { detectMcpServers } from './mcp-detector.js';
import { estimateMcpCosts } from './mcp-cost-estimator.js';
import {
  NATIVE_SERVER_KEY,
  type ContextCostStore,
  type ServerDefinitionCostAggregate,
} from './context-cost-db.js';

/** "Switch to code execution" thresholds. A server qualifies when its
 *  measured definitions occupy at least this many tokens per request while
 *  seeing at most this many calls over the 7d usage lookback. Tuned against
 *  observed data (github: ~10.5k tokens / ~14 calls per week qualifies; the
 *  sentinel retrieval server: ~134 tokens never does). Daemon-side so they
 *  can be adjusted without a UI redeploy. */
export const CODE_MODE_MIN_DEF_TOKENS = 1500;
export const CODE_MODE_MAX_CALLS_7D = 25;

/** Duplicate detection: flag when at least this share of the smaller
 *  server's tool suffixes also exist on another server. */
const DUPLICATE_OVERLAP_RATIO = 0.5;

/** Mirror of Claude Code's MCP server-name sanitization for tool names. */
export function sanitizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

function safeReadJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    /* v8 ignore next 3 — defensive against corrupted user state */
  } catch {
    return null;
  }
}

/** Top-level (user-scope) mcpServers keys — the detector only walks
 *  `projects`, so global servers are collected here. */
function detectGlobalServers(claudeJson: unknown): string[] {
  if (!claudeJson || typeof claudeJson !== 'object') return [];
  const servers = (claudeJson as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.keys(servers);
}

/** Project-scope servers from each known project's `.mcp.json` (Claude
 *  Code's `project` scope). The project list comes from `~/.claude.json:
 *  projects` — the same set of directories Claude Code has been run in —
 *  so this never walks the filesystem blindly. */
function detectMcpJsonServers(claudeJson: unknown): Array<{ project: string; name: string }> {
  if (!claudeJson || typeof claudeJson !== 'object') return [];
  const projects = (claudeJson as { projects?: unknown }).projects;
  if (!projects || typeof projects !== 'object') return [];
  const out: Array<{ project: string; name: string }> = [];
  for (const dir of Object.keys(projects)) {
    const mcpJson = safeReadJson(join(dir, '.mcp.json'));
    if (!mcpJson || typeof mcpJson !== 'object') continue;
    const servers = (mcpJson as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    for (const name of Object.keys(servers)) out.push({ project: dir, name });
  }
  return out;
}

/** Tool suffix (the part after `mcp__<server>__`), for duplicate
 *  comparison across server-name variants. */
function toolSuffixes(toolNames: string[], sanitizedServer: string): Set<string> {
  const prefix = `mcp__${sanitizedServer}__`;
  const out = new Set<string>();
  for (const n of toolNames) {
    if (n.startsWith(prefix)) out.add(n.slice(prefix.length));
  }
  return out;
}

interface ConfigPresence {
  /** Display name (config spelling). */
  name: string;
  projects: string[];
  /** Projects whose `.mcp.json` carries the entry (scope `project`). */
  mcpJsonProjects: string[];
  enabledAnywhere: boolean;
  global: boolean;
}

export interface BuildInsightsDeps {
  db: Database.Database;
  contextStore: ContextCostStore;
  /** Recorded code-mode migrations; doubles as the bridged-server set. */
  migrations: CodeModeMigration[];
  /** Sentinel's plain-disable stashes. A user- or project-scope disable
   *  removes the config entry outright (no `disabledMcpServers` marker
   *  exists at those scopes), so without these the row would look
   *  measured-only and lose its Enable action. */
  disabledStashes?: CodeModeMigration[];
  /** Servers the bridge failed to verify/connect to since startup. */
  unavailableServers?: ReadonlySet<string>;
  window?: MetricsWindow;
}

export function buildMcpContextInsights(deps: BuildInsightsDeps): McpContextCosts {
  const { db, contextStore, migrations } = deps;
  const win = deps.window ?? {};
  const unavailable = deps.unavailableServers ?? new Set<string>();

  const claudeJson = safeReadJson(getClaudeJsonPath());
  const configRows = detectMcpServers(claudeJson);
  const globalServers = detectGlobalServers(claudeJson);
  const mcpJsonRows = detectMcpJsonServers(claudeJson);
  const usage = estimateMcpCosts(db);
  const measured = contextStore
    .getServerDefinitionCosts(win)
    .filter((m) => m.server !== NATIVE_SERVER_KEY);
  const nativeAgg = contextStore
    .getServerDefinitionCosts(win)
    .find((m) => m.server === NATIVE_SERVER_KEY);

  // Collapse config rows by sanitized name: one insight per server identity,
  // with every project it appears under.
  const configByKey = new Map<string, ConfigPresence>();
  const upsertConfig = (
    name: string,
    project: string | null,
    enabled: boolean,
    bucket: 'local' | 'mcpjson' = 'local',
  ): void => {
    const key = sanitizeServerName(name);
    const cur = configByKey.get(key) ?? {
      name,
      projects: [],
      mcpJsonProjects: [],
      enabledAnywhere: false,
      global: false,
    };
    const list = bucket === 'mcpjson' ? cur.mcpJsonProjects : cur.projects;
    if (project !== null && !list.includes(project)) list.push(project);
    if (project === null) cur.global = true;
    if (enabled) cur.enabledAnywhere = true;
    configByKey.set(key, cur);
  };
  for (const row of configRows) upsertConfig(row.name, row.project, row.enabled);
  for (const name of globalServers) upsertConfig(name, null, true);
  for (const row of mcpJsonRows) upsertConfig(row.name, row.project, true, 'mcpjson');
  // Stash-disabled servers: the entry left the config file, but Sentinel
  // holds the restore payload, so the row must stay visible (and actionable)
  // as "disabled" at the stash's scope.
  for (const stash of deps.disabledStashes ?? []) {
    upsertConfig(
      stash.server,
      stash.directory,
      false,
      stash.scope === 'project' ? 'mcpjson' : 'local',
    );
  }

  const measuredByKey = new Map(measured.map((m) => [m.server, m]));
  const usageByKey = new Map(usage.map((u) => [u.server, u]));

  // Bridged servers must always appear, even though migration removed their
  // config entry (that's the whole point) and fresh bridges have no measured
  // traffic yet. Keep the migration's spelling as the display name.
  const migrationNameByKey = new Map(
    migrations.map((m) => [sanitizeServerName(m.server), m.server]),
  );

  // Sessions over the window approximate how often definitions re-write to
  // cache (the prefix re-writes at least once per session).
  const sessions = countSessions(db, win);
  const priceModel = dominantModel(db, win);

  const keys = new Set<string>([
    ...configByKey.keys(),
    ...measuredByKey.keys(),
    ...migrationNameByKey.keys(),
  ]);
  const insights: McpContextInsight[] = [];
  for (const key of keys) {
    const config = configByKey.get(key);
    const m = measuredByKey.get(key);
    const u = usageByKey.get(key);

    const defBytes = m?.defBytesMax ?? 0;
    const defTokens = estimateTokensFromBytes(defBytes);
    const calls7d = u?.callCount ?? 0;
    const enabled = config ? config.enabledAnywhere : true; // measured-only ⇒ it loads
    const bridged = migrations.some((mig) => sanitizeServerName(mig.server) === key);

    // Bridged servers carry no badges at all: the bridge pill already
    // communicates state, and after a full migration the surviving config
    // rows are the disabledMcpServers markers, which would otherwise earn a
    // misleading 'disabled' badge next to 'bridged'.
    const recommendations: McpRecommendationBadge[] = [];
    if (!bridged) {
      if (config && !config.enabledAnywhere) {
        recommendations.push({ kind: 'disabled' });
      } else {
        if (m && calls7d === 0) recommendations.push({ kind: 'unused' });
        // The code-mode badge is a call to action, so it requires a config
        // entry Sentinel can actually disable. Measured-only servers
        // (plugins, remote connectors) would double-load if bridged.
        if (
          config &&
          m &&
          defTokens >= CODE_MODE_MIN_DEF_TOKENS &&
          calls7d <= CODE_MODE_MAX_CALLS_7D
        ) {
          recommendations.push({ kind: 'code-mode' });
        }
      }
    }

    insights.push({
      server: config?.name ?? migrationNameByKey.get(key) ?? key,
      projects: config?.projects ?? [],
      mcpJsonProjects: config?.mcpJsonProjects ?? [],
      enabled,
      global: config?.global ?? false,
      managed: config !== undefined || bridged,
      definition: {
        bytes: defBytes,
        estTokens: defTokens,
        toolCount: m?.toolCountMax ?? 0,
        requestCount: m?.requestCount ?? 0,
        measured: m !== undefined,
      },
      usage7d: {
        calls: calls7d,
        bytesIn: u?.bytesIn ?? 0,
        bytesOut: u?.bytesOut ?? 0,
        estTokens: u?.estimatedTokens ?? 0,
      },
      cacheWriteEstUsd:
        (defTokens / 1_000_000) *
        getBaseInputPricePerMillion(priceModel) *
        CACHE_WRITE_5M_MULTIPLIER *
        sessions,
      recommendations,
      bridgeStatus: bridged ? (unavailable.has(key) ? 'unavailable' : 'bridged') : 'native',
    });
  }

  // Duplicate detection across measured servers: compare tool suffixes so
  // `mongodb-mcp-server` and `plugin_mongodb_mongodb` recognize each other
  // despite the name variants. O(n²) over a handful of servers.
  annotateDuplicates(insights, measuredByKey);

  insights.sort((a, b) => b.definition.estTokens - a.definition.estTokens);

  const savings = computeContextSavings({
    db,
    contextStore,
    migrations,
    win,
    insights,
    measuredByKey,
    migrationNameByKey,
    priceModel,
  });

  return {
    insights,
    nativeDefBytes: nativeAgg?.defBytesMax ?? 0,
    measuredRequests: nativeAgg?.requestCount ?? maxRequestCount(measured),
    savings,
  };
}

/**
 * Realized + potential savings for the Context feature.
 *
 * REALIZED (per bridged server): definition tokens kept out of requests
 * since the migration, computed as the counterfactual
 * `defTokens × (requests observed since migration that did NOT carry them)`.
 * `defTokens` is the server's all-time max definition size (the window may
 * exclude every pre-migration measurement); the request count is the
 * `__native__` row's tally minus any requests that still carried the
 * server's definitions — which self-corrects the migration day and any
 * hand-restored (drifted) period. Dollar figures use cached rates on
 * purpose: reads at 0.1x per request plus one 1.25x write per session.
 * Day-bucketed storage makes all of this an estimate, like every other
 * Optimize figure.
 *
 * POTENTIAL: the definition bytes the currently-recommended servers
 * (code-mode badge) actually carried over the window — exactly what
 * bridging them would have saved on observed traffic, mirroring
 * compression's dry-run potential.
 */
function computeContextSavings(args: {
  db: Database.Database;
  contextStore: ContextCostStore;
  migrations: CodeModeMigration[];
  win: MetricsWindow;
  insights: McpContextInsight[];
  measuredByKey: Map<string, { defBytesSum: number }>;
  migrationNameByKey: Map<string, string>;
  priceModel: string;
}): McpContextSavings {
  const { db, contextStore, migrations, win, insights } = args;
  const basePrice = getBaseInputPricePerMillion(args.priceModel);

  // Potential: sum what code-mode-recommended servers carried in the window.
  let potentialTokens = 0;
  let potentialUsd = 0;
  for (const ins of insights) {
    if (!ins.recommendations.some((r) => r.kind === 'code-mode')) continue;
    const carried = args.measuredByKey.get(sanitizeServerName(ins.server))?.defBytesSum ?? 0;
    const tokens = estimateTokensFromBytes(carried);
    potentialTokens += tokens;
    potentialUsd += (tokens / 1_000_000) * basePrice * CACHE_READ_MULTIPLIER + ins.cacheWriteEstUsd;
  }

  // Realized: per bridged server, from the earliest migration timestamp. The
  // request count is anchored to a baseline captured at migration time so a
  // mid-day bridge doesn't credit that day's pre-migration traffic (see
  // realizedRequests).
  const migratedAtByKey = new Map<
    string,
    { migratedAt: number; baselineNative: number | undefined; baselineServer: number | undefined }
  >();
  for (const mig of migrations) {
    const key = sanitizeServerName(mig.server);
    const prev = migratedAtByKey.get(key);
    if (prev === undefined || mig.migratedAt < prev.migratedAt) {
      migratedAtByKey.set(key, {
        migratedAt: mig.migratedAt,
        baselineNative: mig.baselineNativeRequests,
        baselineServer: mig.baselineServerRequests,
      });
    }
  }
  const allTime = new Map(contextStore.getServerDefinitionCosts({}).map((a) => [a.server, a]));
  const byServer: McpContextSavings['byServer'] = [];
  let realizedTokens = 0;
  let realizedUsd = 0;
  for (const [key, m] of migratedAtByKey) {
    const server = args.migrationNameByKey.get(key) ?? key;
    const defTokens = estimateTokensFromBytes(allTime.get(key)?.defBytesMax ?? 0);
    const sinceMs = Math.max(win.sinceMs ?? 0, m.migratedAt);
    if (defTokens === 0 || (win.untilMs !== undefined && win.untilMs <= sinceMs)) {
      byServer.push({ server, estTokens: 0, estUsd: 0, requests: 0 });
      continue;
    }
    const sinceWin: MetricsWindow = {
      sinceMs,
      ...(win.untilMs !== undefined ? { untilMs: win.untilMs } : {}),
    };
    const requests = realizedRequests({ contextStore, key, win, migration: m, allTime });
    const sessions = countSessions(db, sinceWin);
    const tokens = defTokens * requests;
    const usd =
      (tokens / 1_000_000) * basePrice * CACHE_READ_MULTIPLIER +
      (defTokens / 1_000_000) * basePrice * CACHE_WRITE_5M_MULTIPLIER * sessions;
    byServer.push({ server, estTokens: tokens, estUsd: usd, requests });
    realizedTokens += tokens;
    realizedUsd += usd;
  }
  byServer.sort((a, b) => b.estTokens - a.estTokens);

  return {
    realized: { estTokens: realizedTokens, estUsd: realizedUsd },
    potential: { estTokens: potentialTokens, estUsd: potentialUsd },
    byServer,
  };
}

/**
 * Requests that benefited from a bridge: native requests minus those that still
 * carried the server's definitions (e.g. unmigrated per-project entries).
 *
 * When the window's lower bound is the migration itself (the common case,
 * including all-time), the count is anchored to the baseline request counts
 * captured at migration time. Definition costs are stored bucketed by local
 * day, so without the baseline a mid-day bridge would count that whole day's
 * pre-migration native traffic as "saved since bridging" - the bogus ~1200 a
 * user sees the instant they enable code mode. A missing baseline (migrations
 * recorded before the field existed, before the startup backfill runs) defaults
 * to the current count, i.e. zero saved so far: never an inflated figure.
 *
 * When the window starts strictly after the migration (the user zoomed into a
 * recent sub-window of an older bridge), the day-bucketed window count is used;
 * its coarseness is the window's own, not a migration-boundary artifact.
 */
function realizedRequests(args: {
  contextStore: ContextCostStore;
  key: string;
  win: MetricsWindow;
  migration: {
    migratedAt: number;
    baselineNative: number | undefined;
    baselineServer: number | undefined;
  };
  allTime: Map<string, ServerDefinitionCostAggregate>;
}): number {
  const { contextStore, key, win, migration, allTime } = args;
  if (migration.migratedAt >= (win.sinceMs ?? 0)) {
    const upTo =
      win.untilMs !== undefined
        ? new Map(
            contextStore
              .getServerDefinitionCosts({ untilMs: win.untilMs })
              .map((a) => [a.server, a]),
          )
        : allTime;
    const nativeUpTo = upTo.get(NATIVE_SERVER_KEY)?.requestCount ?? 0;
    const serverUpTo = upTo.get(key)?.requestCount ?? 0;
    const baseNative = migration.baselineNative ?? nativeUpTo;
    const baseServer = migration.baselineServer ?? serverUpTo;
    return Math.max(0, Math.max(0, nativeUpTo - baseNative) - Math.max(0, serverUpTo - baseServer));
  }
  const aggs = contextStore.getServerDefinitionCosts({
    ...(win.sinceMs !== undefined ? { sinceMs: win.sinceMs } : {}),
    ...(win.untilMs !== undefined ? { untilMs: win.untilMs } : {}),
  });
  const nativeSince = aggs.find((a) => a.server === NATIVE_SERVER_KEY)?.requestCount ?? 0;
  const stillCarried = aggs.find((a) => a.server === key)?.requestCount ?? 0;
  return Math.max(0, nativeSince - stillCarried);
}

/**
 * Fill in `baselineNativeRequests` / `baselineServerRequests` for any migration
 * recorded before those fields existed, using the current all-time request
 * counts as the baseline. Run once at daemon start. The effect for a legacy
 * migration is that its realized-savings counter restarts from upgrade time
 * (honest "since upgrade") instead of reporting the day-bucket inflated figure.
 * Idempotent: migrations that already carry a baseline are returned untouched,
 * and `changed` is false when nothing needed filling so the caller can skip the
 * settings write.
 */
export function backfillMigrationBaselines(
  migrations: CodeModeMigration[],
  contextStore: Pick<ContextCostStore, 'getServerDefinitionCosts'>,
): { changed: boolean; migrations: CodeModeMigration[] } {
  if (!migrations.some((m) => m.baselineNativeRequests === undefined)) {
    return { changed: false, migrations };
  }
  const allTime = new Map(contextStore.getServerDefinitionCosts({}).map((a) => [a.server, a]));
  const nativeNow = allTime.get(NATIVE_SERVER_KEY)?.requestCount ?? 0;
  const next = migrations.map((m) =>
    m.baselineNativeRequests === undefined
      ? {
          ...m,
          baselineNativeRequests: nativeNow,
          baselineServerRequests: allTime.get(sanitizeServerName(m.server))?.requestCount ?? 0,
        }
      : m,
  );
  return { changed: true, migrations: next };
}

function annotateDuplicates(
  insights: McpContextInsight[],
  measuredByKey: Map<string, { toolNames: string[] }>,
): void {
  const suffixesByKey = new Map<string, Set<string>>();
  for (const ins of insights) {
    const key = sanitizeServerName(ins.server);
    const m = measuredByKey.get(key);
    if (m) suffixesByKey.set(key, toolSuffixes(m.toolNames, key));
  }
  const entries = [...suffixesByKey.entries()].filter(([, s]) => s.size > 0);
  for (const ins of insights) {
    // Bridged rows carry no badges (see buildMcpContextInsights).
    if (ins.bridgeStatus !== 'native') continue;
    const key = sanitizeServerName(ins.server);
    const mine = suffixesByKey.get(key);
    if (!mine || mine.size === 0) continue;
    for (const [otherKey, theirs] of entries) {
      if (otherKey === key) continue;
      let overlap = 0;
      for (const s of mine) if (theirs.has(s)) overlap += 1;
      const ratio = overlap / Math.min(mine.size, theirs.size);
      if (ratio >= DUPLICATE_OVERLAP_RATIO) {
        const other = insights.find((i) => sanitizeServerName(i.server) === otherKey);
        ins.recommendations.push({ kind: 'duplicate', detail: other?.server ?? otherKey });
        break; // one duplicate badge is enough
      }
    }
  }
}

function countSessions(db: Database.Database, win: MetricsWindow): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT session_id) AS n FROM tool_calls
       WHERE session_id IS NOT NULL
         AND (@sinceMs IS NULL OR ts >= @sinceMs)
         AND (@untilMs IS NULL OR ts <  @untilMs)`,
    )
    .get({ sinceMs: win.sinceMs ?? null, untilMs: win.untilMs ?? null }) as { n: number };
  return row.n;
}

/** Most-frequent model over the window, for the cache-write price. Falls
 *  back to sonnet-tier pricing when no tool_calls exist yet. */
function dominantModel(db: Database.Database, win: MetricsWindow): string {
  const row = db
    .prepare(
      `SELECT model FROM tool_calls
       WHERE model IS NOT NULL
         AND (@sinceMs IS NULL OR ts >= @sinceMs)
         AND (@untilMs IS NULL OR ts <  @untilMs)
       GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    .get({ sinceMs: win.sinceMs ?? null, untilMs: win.untilMs ?? null }) as
    | { model: string }
    | undefined;
  return row?.model ?? 'claude-sonnet-4-6';
}

function maxRequestCount(measured: Array<{ requestCount: number }>): number {
  let max = 0;
  for (const m of measured) if (m.requestCount > max) max = m.requestCount;
  return max;
}
