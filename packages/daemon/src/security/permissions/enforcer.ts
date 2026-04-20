/**
 * Facade the proxy uses to apply tool-permission enforcement. Wraps the
 * pure evaluator + SSE interceptor with the glue needed to:
 *   - maintain a compiled rule-set cache (invalidated on IPC mutation or DB write)
 *   - read live settings on every call (so toggles take effect immediately)
 *   - persist `tool_permission_blocked` security events and mirror them
 *     into the notifications table for the UI
 *
 * Built once at daemon startup; the proxy holds a reference and consults it
 * on every /v1/messages request.
 */

import type { Database } from 'better-sqlite3';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { IncomingHttpHeaders } from 'http';
import type {
  ActiveClaudeSession,
  AutoModeStatus,
  PermissionRule,
  Settings,
  SecurityKind,
  SecuritySeverity,
  NotificationType,
} from '@claude-sentinel/shared';
import type { IpcServer } from '../../ipc.js';
import { listPermissionRules } from '../../db.js';
import { insertSecurityEvent, insertNotification } from '../../db.js';
import { hashText } from '../redact.js';
import {
  compileRules,
  findWholeToolDeny,
  type CompiledRuleSet,
  type EvaluatorSettingsView,
} from './evaluator.js';
import {
  createPermissionsSseInterceptor,
  sinkFromResponse,
  type PermissionsSseInterceptor,
} from './sse-interceptor.js';
import type { ServerResponse } from 'http';

export interface PermissionsEnforcerDeps {
  db: Database;
  ipcServer: IpcServer;
  /** Pulled on every call so toggles take effect immediately without
   *  restarting the proxy. */
  getSettings: () => Settings;
}

/** How long a header-based auto-mode detection keeps the legacy freshness
 *  indicator active after the last qualifying request. This is now a
 *  fallback for requests where we couldn't extract a session_id — the
 *  primary path uses per-session tracking which persists across the gap
 *  between requests. */
export const AUTO_MODE_FRESHNESS_MS = 60_000;

/** A session is considered dead after this long without any request, even
 *  if the process-scan somehow keeps reporting it alive. Sanity belt
 *  against a broken `pgrep` / PowerShell-CIM call leaking sessions across
 *  daemon restarts are handled separately (in-memory state). */
export const SESSION_HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Cadence of the process-count scan that prunes dead sessions. Only runs
 *  when at least one session is tracked — avoids spawning subprocesses on
 *  an idle host. */
export const PROCESS_POLL_INTERVAL_MS = 30_000;

export interface PermissionsEnforcer {
  /** True when the feature is enabled in settings. The proxy uses this to
   *  short-circuit before spending cycles on tool-strip or interceptor setup. */
  isEnabled(): boolean;
  /** True when auto-mode skip is active for a request.
   *
   *  Auto mode is triggered by either:
   *   1. Manual toggle (`toolPermissionAutoModeActive` setting), OR
   *   2. Automatic header-based detection: Claude Code launched with
   *      `--dangerously-skip-permissions` / auto mode sends
   *      `anthropic-beta: ...afk-mode-<date>...` and/or
   *      `anthropic-beta: ...advisor-tool-<date>...` on every /v1/messages
   *      request. Both headers are only present when auto-mode is active.
   *
   *  Either signal bypasses all rule evaluation so the user isn't
   *  double-gated by Sentinel on top of Claude Code's own classifier. */
  isSkippedForAutoMode(headers?: IncomingHttpHeaders): boolean;
  /** Rewrite an outbound /v1/messages body so any whole-tool deny rules
   *  strip the matching entries from its `tools` array. Returns the new
   *  Buffer (or the original when no stripping occurred). Emits
   *  `tool_permission_blocked` events as a side effect when tools are
   *  stripped. */
  stripDeniedTools(body: Buffer, accountId: string, headers?: IncomingHttpHeaders): Buffer;
  /** Install an interceptor on the response stream. Returns null when the
   *  feature is disabled or auto-mode-skipped — caller should pipe raw. */
  createInterceptor(
    res: ServerResponse,
    accountId: string,
    headers?: IncomingHttpHeaders,
  ): PermissionsSseInterceptor | null;
  /** Force a cache rebuild after a rule mutation (create / update / delete).
   *  IPC handlers call this after upserting a rule. */
  invalidate(): void;
  /** Expose the compiled rule set to the IPC layer so list_permission_rules
   *  can return it without a second DB hit on the hot path. */
  listRules(): PermissionRule[];
  /** Inspect a request purely for status-tracking. Unlike
   *  `isSkippedForAutoMode`, this runs unconditionally (even when the
   *  feature is disabled) so the UI can still surface "Claude Code is in
   *  auto mode" even if Sentinel's rules aren't installed.
   *
   *  `sessionInfo` should be the `{ sessionId, accountUuid }` pair
   *  extracted from the request body via {@link extractSessionInfo}; pass
   *  `null` when the request has no parseable session metadata (classifier
   *  sub-calls, count_tokens, etc.) — the legacy timestamp path still
   *  fires for header-detected auto-mode in that case. */
  observeRequest(
    headers: IncomingHttpHeaders,
    sessionInfo?: { sessionId: string; accountUuid: string | null } | null,
  ): void;
  /** Live auto-mode status used by the UI to show a "Sentinel standing down"
   *  banner. Combines the manual settings toggle with header-based detection
   *  (the latter with a 60 s freshness window so a bursty conversation
   *  doesn't flicker the indicator between requests). */
  getAutoModeStatus(): AutoModeStatus;
  /** Clear any pending deactivation timer. Called at daemon shutdown so
   *  lingering timers don't keep the event loop alive. */
  shutdown(): void;
  /** Invoked when the settings hook fires — lets the enforcer re-emit a
   *  `permissions_status` broadcast if the manual override flipped (so the
   *  UI doesn't have to compute union state from two broadcasts). */
  onSettingsChanged(): void;
}

/**
 * Detect whether an outbound /v1/messages request was made while Claude Code
 * was in auto mode. Claude Code signals this via the `anthropic-beta` header
 * — specifically the `afk-mode-<date>` and/or `advisor-tool-<date>` feature
 * flags are only enabled when the auto-mode classifier pathway is live.
 *
 * Empirically verified: in normal mode neither header is present; in
 * `--dangerously-skip-permissions` / auto mode at least one is always
 * present. See the v1 investigation logs for the comparison dump.
 */
export function detectAutoModeFromHeaders(headers: IncomingHttpHeaders): boolean {
  const beta = headers['anthropic-beta'];
  if (typeof beta !== 'string' || !beta) return false;
  // Match both the `afk-mode-<date>` and `advisor-tool-<date>` feature flags.
  // Checking both keeps detection robust if Anthropic renames or deprecates
  // one of them.
  return /\b(afk-mode|advisor-tool)-\d{4}-\d{2}-\d{2}\b/.test(beta);
}

/**
 * Extract `{ sessionId, accountUuid }` from a /v1/messages request body.
 * Claude Code JSON-encodes an object inside `metadata.user_id`:
 *   `{ device_id, account_uuid, session_id }`.
 * Returns `null` when parsing fails or no session_id is present — the
 * caller treats that as "no per-session tracking possible for this
 * request" and falls back to the legacy timestamp path.
 */
export function extractSessionInfo(
  body: Buffer,
): { sessionId: string; accountUuid: string | null } | null {
  try {
    const obj = JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
    const metadata = obj['metadata'] as Record<string, unknown> | undefined;
    const userId = metadata?.['user_id'];
    if (typeof userId !== 'string' || !userId) return null;
    const parsed = JSON.parse(userId) as Record<string, unknown>;
    const sessionId = parsed['session_id'];
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const accountUuid =
      typeof parsed['account_uuid'] === 'string' ? (parsed['account_uuid'] as string) : null;
    return { sessionId, accountUuid };
  } catch {
    return null;
  }
}

const execAsync = promisify(exec);

/**
 * Count currently-running Claude Code processes across platforms. Matches
 * on the `@anthropic-ai/claude-code` npm package path which appears in every
 * supported install form (global npm, npx, homebrew). Returns `null` if the
 * scan itself failed — the caller should treat that as "don't prune by
 * process count this round" rather than "zero processes running".
 */
export async function countClaudeCodeProcesses(): Promise<number | null> {
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin
      // PowerShell CIM doesn't require admin and works on every supported
      // Windows build. The parenthesized `.Count` short-circuits the zero
      // case to `0` without requiring us to post-process the output.
      ? `powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*@anthropic-ai/claude-code*' }).Count"`
      // `pgrep -cf` = count of matches against the full command line.
      // Works identically on macOS and Linux.
      : `pgrep -cf "@anthropic-ai/claude-code"`;
    const { stdout } = await execAsync(cmd, { timeout: 5_000 });
    const n = parseInt(stdout.trim(), 10);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  } catch {
    return null;
  }
}

const TOOL_BLOCKED_DETECTOR = 'tool_permission_blocked';

function settingsView(s: Settings): EvaluatorSettingsView {
  return {
    toolPermissionsEnabled: s.toolPermissionsEnabled,
    toolPermissionDefaultAction: s.toolPermissionDefaultAction,
    toolPermissionSkipInAutoMode: s.toolPermissionSkipInAutoMode,
    toolPermissionAutoModeActive: s.toolPermissionAutoModeActive,
  };
}

function toNotificationType(severity: SecuritySeverity): NotificationType {
  if (severity === 'high') return 'security_high';
  if (severity === 'medium') return 'security_medium';
  return 'security_low';
}

export function createPermissionsEnforcer(
  deps: PermissionsEnforcerDeps,
): PermissionsEnforcer {
  let cached: { rules: PermissionRule[]; compiled: CompiledRuleSet } | null = null;

  // ── Auto-mode state ────────────────────────────────────────────────
  //
  // Three complementary trackers power the UI's banner:
  //
  //  1. `sessions` — per-session map keyed by `session_id` (extracted from
  //     metadata.user_id on /v1/messages requests). The primary truth
  //     source. Each session remembers its most recent mode so the banner
  //     can count "1 of 3 sessions in auto mode".
  //
  //  2. `lastHeaderDetectedAt` + `deactivateTimer` — legacy fallback for
  //     requests that can't be attributed to a session (no parseable
  //     metadata). Pure 60 s freshness window.
  //
  //  3. `lastProcessCount` — last observed count of claude-code OS
  //     processes, refreshed every 30 s while at least one session is
  //     tracked. Drives session pruning: when tracked > running, we drop
  //     the oldest sessions (FIFO heuristic: least-recently-seen dies
  //     first) until the counts match.
  //
  // `lastBroadcast*` holds the last snapshot we pushed to the UI so we
  // only emit `permissions_status` on edges (activate/deactivate/count-
  // change) rather than per request.
  const sessions = new Map<string, ActiveClaudeSession>();
  let lastHeaderDetectedAt: number | null = null;
  let deactivateTimer: ReturnType<typeof setTimeout> | null = null;
  let processPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastProcessCount: number | null = null;
  let lastBroadcastActive = false;
  let lastBroadcastSource: 'manual' | 'headers' | null = null;
  let lastBroadcastActiveSessions = 0;
  let lastBroadcastAutoModeSessions = 0;

  const getCompiled = (): { rules: PermissionRule[]; compiled: CompiledRuleSet } => {
    if (cached) return cached;
    const rules = listPermissionRules(deps.db);
    cached = { rules, compiled: compileRules(rules) };
    return cached;
  };

  const invalidate = (): void => {
    cached = null;
  };

  const isEnabled = (): boolean => deps.getSettings().toolPermissionsEnabled;

  const snapshotSessions = (): ActiveClaudeSession[] => {
    // Most-recent first so the UI's expandable list is naturally ordered.
    return [...sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  };

  const computeStatus = (now = Date.now()): AutoModeStatus => {
    const s = deps.getSettings();
    const sessionList = snapshotSessions();
    const activeSessions = sessionList.length;
    const autoModeSessions = sessionList.filter((x) => x.autoMode).length;

    // Manual override trumps everything.
    if (s.toolPermissionAutoModeActive) {
      return {
        active: true,
        source: 'manual',
        lastDetectedAt: lastHeaderDetectedAt,
        activeSessions,
        autoModeSessions,
        processCount: lastProcessCount,
        sessions: sessionList,
      };
    }
    // Per-session is the primary signal once any session is known.
    if (autoModeSessions > 0) {
      return {
        active: true,
        source: 'headers',
        lastDetectedAt: lastHeaderDetectedAt,
        activeSessions,
        autoModeSessions,
        processCount: lastProcessCount,
        sessions: sessionList,
      };
    }
    // Legacy fallback: header-detected request whose session_id we
    // couldn't parse. Pure timestamp freshness.
    if (
      lastHeaderDetectedAt !== null &&
      now - lastHeaderDetectedAt < AUTO_MODE_FRESHNESS_MS
    ) {
      return {
        active: true,
        source: 'headers',
        lastDetectedAt: lastHeaderDetectedAt,
        activeSessions,
        autoModeSessions,
        processCount: lastProcessCount,
        sessions: sessionList,
      };
    }
    return {
      active: false,
      source: null,
      lastDetectedAt: lastHeaderDetectedAt,
      activeSessions,
      autoModeSessions,
      processCount: lastProcessCount,
      sessions: sessionList,
    };
  };

  const broadcastStatusIfChanged = (): void => {
    const status = computeStatus();
    // Edge detection: broadcast only when one of the aggregate fields the
    // UI renders from has actually changed.
    if (
      status.active === lastBroadcastActive &&
      status.source === lastBroadcastSource &&
      status.activeSessions === lastBroadcastActiveSessions &&
      status.autoModeSessions === lastBroadcastAutoModeSessions
    ) {
      return;
    }
    lastBroadcastActive = status.active;
    lastBroadcastSource = status.source;
    lastBroadcastActiveSessions = status.activeSessions;
    lastBroadcastAutoModeSessions = status.autoModeSessions;
    try {
      deps.ipcServer.broadcast({ type: 'permissions_status', status });
    } catch (err) {
      console.error('[Permissions] status broadcast failed:', err);
    }
  };

  /** Remove sessions we haven't seen a request from in hours — sanity belt
   *  against a broken process scan leaking tracked sessions forever. */
  const pruneByHardTimeout = (now = Date.now()): void => {
    for (const [id, s] of sessions) {
      if (now - s.lastSeenAt > SESSION_HARD_TIMEOUT_MS) sessions.delete(id);
    }
  };

  /** When the OS reports fewer Claude Code processes than we have tracked
   *  sessions, the delta is sessions whose host exited. We can't map PID →
   *  session_id, so use FIFO on `lastSeenAt` (oldest = most likely dead). */
  const pruneToProcessCount = (count: number): void => {
    if (sessions.size <= count) return;
    const toRemove = sessions.size - count;
    const sorted = [...sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (let i = 0; i < toRemove && i < sorted.length; i++) {
      const session = sorted[i];
      if (session) sessions.delete(session.sessionId);
    }
  };

  const stopProcessPoll = (): void => {
    if (processPollTimer) {
      clearInterval(processPollTimer);
      processPollTimer = null;
    }
  };

  const runProcessPoll = async (): Promise<void> => {
    const count = await countClaudeCodeProcesses();
    if (count !== null) {
      lastProcessCount = count;
      pruneToProcessCount(count);
    }
    pruneByHardTimeout();
    broadcastStatusIfChanged();
    if (sessions.size === 0) stopProcessPoll();
  };

  const ensureProcessPoll = (): void => {
    if (processPollTimer) return;
    if (sessions.size === 0) return;
    processPollTimer = setInterval(() => { void runProcessPoll(); }, PROCESS_POLL_INTERVAL_MS);
    if (typeof processPollTimer.unref === 'function') processPollTimer.unref();
    // Kick off the first scan immediately so we don't wait 30 s for the
    // first prune / processCount update after a new session appears.
    void runProcessPoll();
  };

  const scheduleDeactivation = (): void => {
    if (deactivateTimer) clearTimeout(deactivateTimer);
    deactivateTimer = setTimeout(() => {
      deactivateTimer = null;
      // Only broadcasts when the derived status actually changes — so if the
      // user flipped the manual toggle in the meantime, the timer is a no-op.
      broadcastStatusIfChanged();
    }, AUTO_MODE_FRESHNESS_MS);
    // Don't hold the event loop open just for this timer at daemon shutdown.
    if (typeof deactivateTimer.unref === 'function') deactivateTimer.unref();
  };

  const markHeaderDetection = (): void => {
    lastHeaderDetectedAt = Date.now();
    scheduleDeactivation();
    broadcastStatusIfChanged();
  };

  const observeRequest = (
    headers: IncomingHttpHeaders,
    sessionInfo?: { sessionId: string; accountUuid: string | null } | null,
  ): void => {
    const autoMode = detectAutoModeFromHeaders(headers);
    const now = Date.now();

    if (sessionInfo) {
      const existing = sessions.get(sessionInfo.sessionId);
      sessions.set(sessionInfo.sessionId, {
        sessionId: sessionInfo.sessionId,
        accountUuid: sessionInfo.accountUuid ?? existing?.accountUuid ?? null,
        autoMode,
        lastSeenAt: now,
      });
      ensureProcessPoll();
    }

    if (autoMode) {
      // Legacy freshness window doubles as a backstop when session info
      // was missing — the status still flips "active" within the next
      // 60 s.
      markHeaderDetection();
    } else {
      // Non-auto request may have downgraded a previously-auto session:
      // `sessions.set` above already flipped its flag to false. Broadcast
      // the new aggregate if it dropped.
      broadcastStatusIfChanged();
    }
  };

  const isSkippedForAutoMode = (headers?: IncomingHttpHeaders): boolean => {
    const s = deps.getSettings();
    if (!s.toolPermissionSkipInAutoMode) return false;
    if (s.toolPermissionAutoModeActive) return true;
    if (headers && detectAutoModeFromHeaders(headers)) return true;
    return false;
  };

  const getAutoModeStatus = (): AutoModeStatus => computeStatus();

  const shutdown = (): void => {
    if (deactivateTimer) {
      clearTimeout(deactivateTimer);
      deactivateTimer = null;
    }
    stopProcessPoll();
  };

  const onSettingsChanged = (): void => {
    broadcastStatusIfChanged();
  };

  /** Emit a `tool_permission_blocked` security event + notification. */
  const recordBlock = (args: {
    accountId: string;
    toolName: string;
    matchedRule: PermissionRule;
    toolInput: unknown;
    direction: 'outbound' | 'tool_use';
  }): void => {
    const { accountId, toolName, matchedRule, toolInput, direction } = args;
    const now = Date.now();
    const kind: SecurityKind = 'tool_permission_blocked';
    const severity: SecuritySeverity = 'medium';
    const title = `Tool blocked: ${matchedRule.raw}`;
    const reasonDetail = matchedRule.note ? ` — ${matchedRule.note}` : '';
    const reason = `Sentinel permission rule ${matchedRule.raw} blocked ${toolName}${reasonDetail}`;
    const hashSource = `${toolName}:${matchedRule.id}:${direction}`;
    try {
      insertSecurityEvent(deps.db, {
        ts: now,
        accountId,
        sessionId: null,
        direction,
        severity,
        kind,
        detectorId: TOOL_BLOCKED_DETECTOR,
        confidence: 1,
        title,
        reason,
        matchMask: matchedRule.raw,
        matchHash: hashText(hashSource),
        contextHash: hashText(hashSource),
        snippet: deps.getSettings().securityPersistSnippet
          ? truncate(JSON.stringify(toolInput ?? {}), 200)
          : null,
        sourceHint: toolName,
        details: { matchedRuleId: matchedRule.id, matchedRuleRaw: matchedRule.raw },
        blocked: true,
        approved: false,
        provenance: direction === 'outbound' ? 'tool-use' : 'tool-use',
      });
    } catch (err) {
      console.error('[Permissions] insertSecurityEvent failed:', err);
    }
    try {
      insertNotification(deps.db, {
        ts: now,
        accountId,
        type: toNotificationType(severity),
        title: `Blocked: ${title}`,
        body: reason,
      });
    } catch (err) {
      console.error('[Permissions] insertNotification failed:', err);
    }
    try {
      deps.ipcServer.broadcast({
        type: 'security_event_detected',
        accountId,
        severity,
        kind,
        title,
        blocked: true,
      });
    } catch (err) {
      console.error('[Permissions] broadcast failed:', err);
    }
  };

  const stripDeniedTools = (
    body: Buffer,
    accountId: string,
    headers?: IncomingHttpHeaders,
  ): Buffer => {
    if (!isEnabled() || isSkippedForAutoMode(headers) || body.length === 0) return body;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf-8'));
    } catch {
      return body;
    }
    if (!parsed || typeof parsed !== 'object') return body;
    const obj = parsed as Record<string, unknown>;
    const tools = obj['tools'];
    if (!Array.isArray(tools) || tools.length === 0) return body;
    const { compiled } = getCompiled();
    const kept: unknown[] = [];
    const stripped: Array<{ toolName: string; rule: PermissionRule }> = [];
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') {
        kept.push(tool);
        continue;
      }
      const name = (tool as Record<string, unknown>)['name'];
      if (typeof name !== 'string') {
        kept.push(tool);
        continue;
      }
      const rule = findWholeToolDeny(name, compiled, settingsView(deps.getSettings()));
      if (rule) {
        stripped.push({ toolName: name, rule });
      } else {
        kept.push(tool);
      }
    }
    if (stripped.length === 0) return body;
    obj['tools'] = kept;
    for (const { toolName, rule } of stripped) {
      recordBlock({ accountId, toolName, matchedRule: rule, toolInput: null, direction: 'outbound' });
      console.log(
        `[Permissions] stripped tool ${toolName} from outbound (rule: ${rule.raw})`,
      );
    }
    return Buffer.from(JSON.stringify(obj), 'utf-8');
  };

  const createInterceptor = (
    res: ServerResponse,
    accountId: string,
    headers?: IncomingHttpHeaders,
  ): PermissionsSseInterceptor | null => {
    if (!isEnabled() || isSkippedForAutoMode(headers)) return null;
    const { rules } = getCompiled();
    return createPermissionsSseInterceptor({
      sink: sinkFromResponse(res),
      rules,
      settings: settingsView(deps.getSettings()),
      accountId,
      onBlocked: ({ toolName, toolInput, matchedRule, accountId: acc }) => {
        recordBlock({
          accountId: acc,
          toolName,
          matchedRule,
          toolInput,
          direction: 'tool_use',
        });
        console.log(
          `[Permissions] blocked tool_use ${toolName} (rule: ${matchedRule.raw})`,
        );
      },
    });
  };

  const listRules = (): PermissionRule[] => getCompiled().rules;

  return {
    isEnabled,
    isSkippedForAutoMode,
    observeRequest,
    stripDeniedTools,
    createInterceptor,
    invalidate,
    listRules,
    getAutoModeStatus,
    shutdown,
    onSettingsChanged,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
