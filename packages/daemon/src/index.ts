import {
  getDb,
  closeDb,
  listAccounts,
  listRemovedAccounts,
  upsertAccount,
  deleteAccount,
  deleteStaleAccountRows,
  markAccountRemoved,
  purgeAccount,
  reactivateAccount,
  hasActiveAccount,
  getAccount,
  setAccountColor,
  getUsageByDayModel,
  acknowledgeNotification,
  acknowledgeAllNotifications,
  upsertRateLimit,
  loadRateLimits,
  getOverageEvents,
  getLastOverageEventPerAccount,
  listNotifications,
  listAlerts,
  upsertAlert,
  deleteAlert,
  deleteRateLimitsForAccount,
  getTokensByDayModel,
  getCacheHitRate,
  getApiErrorsByDay,
  getToolStats,
  getActivityCounters,
  getEditAcceptRate,
  getToolDecisionBreakdown,
  getUserPromptStats,
  getTopSkills,
  getRecentPlugins,
  listSecurityEvents,
  acknowledgeSecurityEvent,
  acknowledgeAllSecurityEvents,
  clearSecurityEvents,
  purgeSecurityEventsOlderThan,
  purgeTelemetryOlderThan,
  purgeOptimizationOlderThan,
  walkChain,
  listIncidentReplay,
  listAuditExport,
  addSecurityAllowlist,
  removeSecurityAllowlist,
  listSecurityAllowlist,
  listPermissionBypasses,
  removePermissionBypass,
  upsertPermissionRule,
  deletePermissionRule,
  insertNotification,
  runDetectorTuningMigration,
  migrateLegacyDataDir,
  listDetectorStats,
  getCacheTtlByDayModel,
  getCacheTtlBySession,
  listSubagentInstalls,
  insertOptimizationEvent,
  getOptimizationMetrics,
  getCacheHealthWindowRange,
  getProcessedTokenTotals,
  listOptimizationEventsWithSources,
} from './db.js';
import { buildContextInventory } from './context-bloat/inventory.js';
import {
  loadSettings,
  loadSettingsWithTamper,
  updateSettings as writeSettings,
} from './settings.js';
import { IpcServer, IPC_PATH } from './ipc.js';
import { OtelReceiver } from './otel-receiver.js';
import { OtelForwarder } from './otel-forwarder.js';
import { OtelEmitter } from './otel-emitter.js';
import { deleteOtelExporterSecret, writeOtelExporterSecret } from './otel-forwarder-secret.js';
import { RequestAccountMap } from './request-account-map.js';
import { OverageStateMachine } from './overage.js';
import { SonnetSaturationMachine, buildSonnetSaturationBody } from './sonnet-saturation.js';
import { createProxyServer, getDaemonPort, getProxyActivity } from './proxy.js';
import type { ActiveToken, ActiveAccountId } from './proxy.js';
import type { AddressInfo } from 'node:net';
import { RateLimitStore } from './rate-limit-store.js';
import { TokenRotator } from './token-rotator.js';
import { OverageGrantStore } from './overage-grant-store.js';
import { SpendTracker } from './spend-tracker.js';
import { ClaudeAiUsageStore } from './claude-ai-usage.js';
import {
  startAlertEvaluator,
  startSonnetAlertEvaluator,
  startWeeklyAlertEvaluator,
  startPoolAlertEvaluator,
  startWeeklyPoolAlertEvaluator,
  evaluatePoolOnce,
  evaluateWeeklyPoolOnce,
  primeNewAlertAgainstCurrentWindow,
} from './alerts.js';
import { createSecurityScanner } from './security/scanner.js';
import { createPermissionsEnforcer } from './security/permissions/enforcer.js';
import { attachWebhookToIpc } from './alerting/webhook.js';
import { createIncidentReplayRecorder } from './security/incident-replay.js';
import { redactSecretsInString } from './security/detectors.js';
import { createClaudeSyncEngine } from './security/permissions/claude-sync.js';
import { createOtelSettingsWatcher } from './otel-settings-watcher.js';
import { repatchClaudeOtelSettings } from './otel-settings-patch.js';
import {
  inspectClaudeOtelConfig,
  parseOtlpHeaders,
  pickAuthHeader,
} from './otel-settings-drift.js';
import { isUrlSafeForForwarder, SENTINEL_BASE_URL } from './claude-otel-config.js';
import { createAgentsSyncEngine } from './optimize/agents-sync.js';
import { getCuratedLibrary, getCuratedSubagent } from './optimize/curated-library.js';
import { createOptimizationAnalyzer } from './optimize/optimization-analyzer.js';
import { homedir, hostname } from 'os';
import { join } from 'path';
import { runScanBenchmark } from './security/scanner-benchmark.js';
import { parseRule as parsePermissionRule } from './security/permissions/parser.js';
import type { Settings, MetricsWindow } from '@sentinel/shared';
import { getActiveAccount, setActiveAccount } from './claude-state.js';
import {
  readActiveCredentials,
  captureCurrentCredentials,
  writeSentinelCredentials,
  writeClaudeCodeCredentials,
  deleteSentinelCredentials,
  readSentinelCredentials,
} from './accounts.js';
import { startOAuthLogin, OAUTH_ABORTED, fetchProfile } from './oauth.js';
import type { OAuthResult } from './oauth.js';
import { verifyStartupActiveAccount, healDriftedRows } from './credential-verifier.js';
import {
  startTokenRefresher,
  refreshIfNeeded,
  markAccountReauthenticated,
} from './token-refresher.js';
import { probeRateLimits } from './rate-limit-probe.js';
import { startUsageProber, type UsageProberHandle } from './usage-probe.js';
import type {
  OAuthAccount,
  PlanType,
  ClaudeCodeCredentials,
  MetricsSummary,
  AlertScope,
} from '@sentinel/shared';
import { request as httpRequest, type Server } from 'http';
import { log } from './logger.js';
import { getRequestLogStore, closeRequestLogStore } from './request-log-db.js';
import {
  getCompressionStatsStore,
  closeCompressionStatsStore,
} from './optimize/compress/compression-stats-db.js';
import {
  getContextCostStore,
  closeContextCostStore,
  NATIVE_SERVER_KEY,
} from './context-bloat/context-cost-db.js';
import {
  buildMcpContextInsights,
  sanitizeServerName,
  backfillMigrationBaselines,
} from './context-bloat/mcp-insights.js';
import { createMcpClientManager } from './optimize/code-mode/mcp-client-manager.js';
import { createCodeModeHandler } from './optimize/code-mode/code-mode-server.js';
import { getOrCreateCodeModeToken } from './optimize/code-mode/code-mode-token.js';
import {
  disableNativeServer,
  restoreNativeServer,
  isNativeDisabled,
  findNativeServerEntries,
} from './optimize/code-mode/server-migration.js';
import {
  generateServerWorkspace,
  removeServerWorkspace,
  resolveCodeModeDir,
} from './optimize/code-mode/workspace-gen.js';
import {
  installCodeModeSkill,
  uninstallCodeModeSkill,
  writeCodeModeTokenFile,
} from './optimize/code-mode/skill-install.js';
import {
  createRetrieveMcpHandler,
  RETRIEVE_QUALIFIED_NAME,
} from './optimize/compress/mcp-retrieve-server.js';
import { getOrCreateMcpToken } from './optimize/compress/mcp-token.js';
import {
  installMcpServer,
  uninstallMcpServer,
  isMcpInstalled,
  buildMcpServerEntry,
} from './optimize/compress/mcp-install.js';

/**
 * Probe 127.0.0.1:getDaemonPort()/health to see whether another daemon is
 * already listening. Returns true iff the probe gets a 200 within ~500ms.
 *
 * Rationale: the Tauri app spawns the daemon as a child but does not kill it
 * on Quit (Sentinel is a tray app — the daemon is deliberately long-lived
 * so Claude Code's proxy keeps working when the UI is closed). On the next
 * app launch the new spawn would collide with the orphaned daemon: it would
 * unlink the IPC socket (orphaning the live daemon's listener) and then
 * fail to bind port 47284. Bailing out early keeps the running daemon's
 * socket file intact so the app's IPC reconnects cleanly.
 */
/* v8 ignore start */
function isDaemonAlreadyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: getDaemonPort(),
        path: '/health',
        method: 'GET',
        timeout: 500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
/* v8 ignore stop */

// Logger initialization is performed inside startDaemon() (see top of the
// function body) so tests can point the settings reader at a tmp file via
// SENTINEL_TEST_SETTINGS_FILE before the first settings load runs.
// The setup still happens before the first console.log in startDaemon, so
// production behavior is unchanged.

/**
 * Returns the Sentinel-internal key for an account: orgUuid when present,
 * else accountUuid. This allows the same Anthropic user (same accountUuid) to
 * appear as multiple distinct entries when they belong to different orgs
 * (e.g. a personal Max subscription + a Team org subscription).
 */
function sentinelKey(orgUuid: string, accountUuid: string): string {
  return orgUuid || accountUuid;
}

/** Resolve the effective metrics window for a metrics IPC message. The
 *  `window` field is preferred (and supports custom date ranges); the legacy
 *  `days` lookback is honored only when `window` is absent (`days <= 0` or
 *  omitted means all-time). */
function windowFromMessage(window?: MetricsWindow, days?: number): MetricsWindow {
  if (window) return window;
  if (typeof days === 'number' && days > 0) {
    return { sinceMs: Date.now() - days * 24 * 60 * 60 * 1000 };
  }
  return {};
}

/** Stable host identifier emitted as a resource attribute on every
 *  Sentinel-originated OTEL payload. Lets a multi-machine SigNoz instance
 *  disambiguate. Uses os.hostname() which is stable across daemon restarts;
 *  doesn't need to be globally unique, just consistent for one user. */
function hostUuidForOtel(): string {
  try {
    return hostname() || 'unknown-host';
  } catch {
    /* v8 ignore next */
    return 'unknown-host';
  }
}

function inferPlanType(account: OAuthAccount, creds?: ClaudeCodeCredentials | null): PlanType {
  // When credentials include a subscriptionType (from the OAuth profile API), trust it
  // as the authoritative source — it reflects the actual org type the token was minted for.
  const sub = creds?.subscriptionType?.toLowerCase() ?? '';
  if (sub === 'enterprise') return 'enterprise';
  if (sub === 'max') return 'max';
  if (sub === 'team') return 'team';
  if (sub === 'pro') return 'pro';
  //
  // Prior versions upgraded `team` → `max` when `account.hasExtraUsageEnabled`
  // (aka `account.has_claude_max` from the OAuth profile) was true. That was
  // wrong: `has_claude_max` is a USER-level flag that stays true across every
  // OAuth round for the same user, so anyone with a personal Max subscription
  // ALSO ends up flagged as Max within every Team org they're a member of.
  // Symptom: a Team account (Intevity) showed "Max" in Sentinel's UI because
  // the user happened to hold a personal Max elsewhere. Fix: trust the
  // organization_type the token was minted for.

  // No credential-based type available — fall back to account-level hints.
  // These only fire for freshly-enrolled accounts that never saw the OAuth
  // profile (unlikely path, kept for safety).
  if (account.workspaceRole !== null) return 'team';
  return 'pro';
}

// In-memory credential store for inactive accounts (populated via IPC from Tauri app)
const credentialStore = new Map<string, string>();

// Abort controller for the currently-pending OAuth login (if any).
// Replaced each time start_login is received; used by cancel_login.
let loginAbortController: AbortController | null = null;

// probeRateLimits now lives in ./rate-limit-probe.ts to avoid a circular
// dependency with ./usage-probe.ts, which imports it.

/**
 * Sprint 2 anti-tamper: read the IPC handshake token that the Tauri parent
 * writes to the daemon's stdin during `Command::spawn`. The first line of
 * stdin (terminated by `\n`) is the token; we consume up to that point and
 * leave the rest of stdin untouched.
 *
 * Behaviour:
 *   - Tauri-spawned daemon: stdin is a piped fd, the token arrives within
 *     ms, and this resolves with the trimmed token string.
 *   - `pnpm --filter @sentinel/daemon run start` (dev CLI): stdin is
 *     a TTY or empty; after `graceMs` we resolve null and the IPC server
 *     starts in unauthenticated mode (the dev needs to talk to it).
 *   - `SENTINEL_TEST_IPC_TOKEN` set: skip stdin entirely; the env
 *     value short-circuits the IPC handshake check.
 *
 * Reading from `process.stdin` with `'data'` listeners flips it into
 * flowing mode; we pause it again after the read so any stdin writes from
 * the parent that happen later (currently none, but safer) don't get
 * silently consumed.
 */
function readHandshakeTokenFromStdin(graceMs: number = 250): Promise<string | null> {
  if (process.env.SENTINEL_TEST_IPC_TOKEN !== undefined) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    let buffer = '';
    let done = false;
    const finish = (token: string | null): void => {
      if (done) return;
      done = true;
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.pause();
      clearTimeout(timer);
      resolve(token);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const newline = buffer.indexOf('\n');
      if (newline !== -1) {
        const token = buffer.slice(0, newline).trim();
        finish(token.length > 0 ? token : null);
      }
    };
    const onEnd = (): void => {
      // Stream closed before we saw a newline — treat the whole buffer
      // as the token if non-empty (shouldn't happen with well-behaved
      // parents, but tolerated).
      const token = buffer.trim();
      finish(token.length > 0 ? token : null);
    };
    const timer = setTimeout(() => finish(null), graceMs);
    /* v8 ignore next */
    timer.unref?.();
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    if (typeof process.stdin.resume === 'function') process.stdin.resume();
  });
}

/**
 * Start the sentinel daemon:
 *  1. Open SQLite database
 *  2. Start IPC server
 *  3. Start HTTP proxy server (proxy + OTEL receiver)
 */
// Captured once at daemon startup so get_daemon_status can report uptime.
const DAEMON_STARTED_AT = Date.now();

export interface DaemonHandle {
  httpServer: Server;
  ipcServer: IpcServer;
  /** Resolves when the deferred startup credential reconciliation (org-drift
   *  verify + heal, both network-bound) has finished. Runs in the background
   *  after the IPC server starts; exposed so tests can await it
   *  deterministically. Never rejects — failures are logged and swallowed. */
  startupReconciliation: Promise<void>;
  /** Close everything started by startDaemon(). Idempotent; safe to call
   *  multiple times. Does NOT call process.exit — the caller decides. */
  shutdown: () => Promise<void>;
}

export async function startDaemon(): Promise<DaemonHandle> {
  // The Tauri app pipes our stdout/stderr into ~/.sentinel/app.log
  // for Windows diagnosability. The daemon deliberately outlives the app
  // process, and once the parent exits the pipes' read ends close; without
  // these guards the next console write raises an unhandled EPIPE stream
  // error and crashes the proxy mid-session.
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);

  // One-time legacy data-dir migration (~/.claude-sentinel → ~/.sentinel) for
  // users upgrading across the "Claude Sentinel" → "Sentinel" rename, run before
  // anything below reads settings/DB/logs. The Tauri app already does this in
  // Rust before spawning us; this is the standalone-daemon fallback. Production-
  // startup-only: the test harness redirects every path via SENTINEL_TEST_* env
  // and must never touch the developer's real home dir (mirrors the
  // isDaemonAlreadyRunning guard below).
  /* v8 ignore next 3 -- production-startup-only; tests set SENTINEL_TEST_* and skip this */
  if (!Object.keys(process.env).some((k) => k.startsWith('SENTINEL_TEST_'))) {
    migrateLegacyDataDir();
  }

  // Read the IPC handshake token from stdin before any I/O so the parent's
  // pipe write isn't lost if startup races. Tauri-spawned daemons see a
  // value within ms; the dev CLI sees null after the grace window.
  const ipcHandshakeToken = await readHandshakeTokenFromStdin();

  // Logger setup: level filtering + ring buffer + console monkey-patch. Done
  // here (not at module scope) so tests that set SENTINEL_TEST_SETTINGS_FILE
  // between imports and startDaemon() see their tmp settings file. In
  // production the effect is identical: the first console.log below still
  // runs through the patched console with the persisted level already set.
  log.setLevel(loadSettings().logLevel);
  log.installConsolePatch();

  console.log('[Sentinel] Starting daemon v0.1.0...');
  // Environment banner: first line of every session in daemon.log so a log
  // captured from any OS/VM immediately identifies the platform, runtime,
  // and resolved paths without back-and-forth.
  console.log(
    `[Sentinel] env platform=${process.platform} arch=${process.arch} ` +
      `node=${process.versions.node} pid=${process.pid} home=${homedir()} ` +
      `ipc=${process.env.SENTINEL_TEST_IPC_SOCKET ?? IPC_PATH}`,
  );

  // Shared across this startup closure: set to true once shutdown() begins so
  // async background callbacks (usage poll → subscriber → DB read, claude-sync
  // engine start-up pull/push) can bail out cleanly instead of racing the DB
  // close. Declared here so every subsystem wired below can observe it.
  let shuttingDown = false;

  // Tests run many daemons concurrently on ephemeral ports. The production
  // double-launch guards (this /health probe and the EADDRINUSE handler at the
  // HTTP listen below) call process.exit, which Vitest turns into a worker-killing
  // failure if two parallel tests' pick-then-close ports ever collide. Detect test
  // mode via the port override the harness always sets, skip the probe, and below
  // bind an OS-assigned port (listen(0)) so a collision is impossible.
  const inTestMode = process.env.SENTINEL_TEST_DAEMON_PORT !== undefined;

  /* v8 ignore next 6 */
  if (!inTestMode && (await isDaemonAlreadyRunning())) {
    console.log(
      `[Sentinel] Another daemon is already listening on 127.0.0.1:${getDaemonPort()} — exiting cleanly.`,
    );
    process.exit(0);
  }

  const db = getDb();

  // Remove any corrupt account entries created before the profile field-name fix
  // (accounts with an empty UUID — email/UUID were not parsed correctly from the API).
  db.prepare("DELETE FROM accounts WHERE id = '' OR id IS NULL").run();

  // Seed the active account into the DB from ~/.claude.json so the UI shows
  // something immediately without waiting for an API call to come through.
  let activeAccount = getActiveAccount();
  // Capture + store the current keychain token under the Sentinel key so
  // Sentinel accumulates per-account credentials across switches.
  // Keying by sentinelKey (orgUuid || accountUuid) means two accounts sharing
  // the same Anthropic user UUID but in different orgs each get their own entry.
  let startupKey = activeAccount
    ? sentinelKey(activeAccount.organizationUuid ?? '', activeAccount.accountUuid)
    : null;
  let startupCreds = startupKey ? captureCurrentCredentials(startupKey) : null;

  // NOTE: verifying the captured credential against the token's actual org
  // (verifyStartupActiveAccount) and healing org-drifted rows happen in the
  // deferred reconciliation AFTER ipcServer.start() — see
  // "Startup credential reconciliation" below. Both call fetchProfile (real
  // outbound HTTPS); when they ran here, a slow first connection on a cold VM
  // delayed creation of the IPC pipe past the app's request timeout, so the
  // UI's first refresh_accounts died with "Refresh failed" and an empty
  // account list (observed on Windows). The optimistic seed below is local
  // and fast; drift is rare and self-corrects via broadcast moments later.

  if (activeAccount && startupKey) {
    // Preserve planType from the existing DB entry rather than re-deriving it from
    // ~/.claude.json metadata, which may reflect a PREVIOUS account's state (written
    // by Sentinel itself during a switch). Only infer for brand-new accounts.
    const existingStartupAcct = listAccounts(db).find((a) => a.id === startupKey);
    upsertAccount(db, {
      id: startupKey,
      accountUuid: activeAccount.accountUuid,
      email: activeAccount.emailAddress,
      displayName: activeAccount.displayName ?? '',
      orgUuid: activeAccount.organizationUuid ?? '',
      orgName: activeAccount.organizationName ?? '',
      planType: existingStartupAcct?.planType ?? inferPlanType(activeAccount, startupCreds),
      isActive: true,
      createdAt: Date.now(),
      color: existingStartupAcct?.color ?? null,
    });

    // Remove the old-style row (id = accountUuid) that may have been created
    // before the sentinelKey migration. Only delete it when the new key differs
    // (i.e. orgUuid is non-empty and therefore the key is the orgUuid, not the
    // accountUuid) to avoid deleting the only row for accounts without an org.
    if (startupKey !== activeAccount.accountUuid) {
      deleteAccount(db, activeAccount.accountUuid);
    }
  }

  // Self-heal planType on every startup. A bug in a prior version classified
  // some Team accounts as 'max' because `account.has_claude_max` in the
  // OAuth profile is a user-level flag (true when the user holds a personal
  // Max anywhere) rather than a per-org flag. Existing rows stay wrong until
  // the user re-authorizes, so we re-derive planType from the stored
  // credentials.subscriptionType on every boot and write the corrected
  // value back. No-op for rows that were already right.
  {
    const rehealAccounts = listAccounts(db);
    let healed = 0;
    for (const acct of rehealAccounts) {
      const credsForHeal = readSentinelCredentials(acct.id);
      if (!credsForHeal?.subscriptionType) continue;
      const oauthShape: OAuthAccount = {
        accountUuid: acct.accountUuid,
        emailAddress: acct.email,
        organizationUuid: acct.orgUuid,
        hasExtraUsageEnabled: false,
        billingType: credsForHeal.subscriptionType,
        accountCreatedAt: new Date().toISOString(),
        subscriptionCreatedAt: new Date().toISOString(),
        displayName: acct.displayName,
        organizationRole: 'user',
        workspaceRole: null,
        organizationName: acct.orgName,
      };
      const correct = inferPlanType(oauthShape, credsForHeal);
      if (correct !== acct.planType) {
        console.log(
          `[PlanType] Re-deriving for ${acct.email} (${acct.orgName || acct.id}): ${acct.planType} → ${correct} (subscriptionType=${credsForHeal.subscriptionType})`,
        );
        upsertAccount(db, {
          id: acct.id,
          accountUuid: acct.accountUuid,
          email: acct.email,
          displayName: acct.displayName,
          orgUuid: acct.orgUuid,
          orgName: acct.orgName,
          planType: correct,
          isActive: acct.isActive,
          createdAt: acct.createdAt,
          color: acct.color,
        });
        healed++;
      }
    }
    if (healed > 0) {
      console.log(`[PlanType] Healed ${healed} account(s) with stale planType`);
    }
  }

  // (healDriftedRows also moved into the deferred reconciliation below.)

  // Shared token reference — mutated on account switch, read by the proxy
  const activeToken: ActiveToken = { value: null };
  // Shared account-key reference — mutated on switch/refresh, used by proxy for rate limit storage
  const activeAccountId: ActiveAccountId = { value: startupKey ?? 'default' };

  // Seed the active token from keychain on startup
  if (startupCreds) activeToken.value = startupCreds.accessToken;
  console.log(
    `[Startup] local account seed complete (key=${startupKey ?? 'none'}, creds=${
      startupCreds ? 'present' : 'absent'
    })`,
  );

  const ipcServer = new IpcServer();

  // Push daemon log entries to every connected UI client. Batched by the
  // logger itself (100ms / 50 entries). Registered before the server starts
  // so entries logged during startup flow through the broadcast pipeline.
  log.onBroadcast((entries) => {
    ipcServer.broadcast({ type: 'daemon_log', entries });
  });

  const overageMachine = new OverageStateMachine();
  const sonnetMachine = new SonnetSaturationMachine();

  // Rehydrate the state machine from the DB so a daemon restart mid-overage-
  // window does not re-fire an `entered` transition on the very next request.
  // We seed from the newest event per account; if the window's resetsAt is
  // still in the future we also mark the transitions already recorded for
  // that window so dedup keeps them suppressed.
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const latestByAccount = getLastOverageEventPerAccount(db);
    for (const ev of latestByAccount) {
      if (ev.resetsAt !== null && ev.resetsAt <= nowSec) continue;
      const windowEvents = getOverageEvents(db, { accountId: ev.accountId }).filter(
        (e) => e.resetsAt === ev.resetsAt,
      );
      const transitions = Array.from(new Set(windowEvents.map((e) => e.transition)));
      const isUsingOverage = transitions.includes('entered') && !transitions.includes('exited');
      const isDisabled = transitions.includes('disabled');
      overageMachine.rehydrate(
        ev.accountId,
        {
          isUsingOverage,
          status: isDisabled ? 'disabled' : ev.status,
          resetsAt: ev.resetsAt,
          disabledReason: ev.disabledReason,
          lastUpdated: ev.ts,
        },
        transitions,
      );
    }
    /* v8 ignore next 3 */
  } catch (err) {
    console.error('[Sentinel] Overage state rehydration failed:', err);
  }

  // Shared correlation table: proxy writes Anthropic's `request-id` → per-
  // request Sentinel key on each upstream response; OtelReceiver reads it
  // when an `api_request`/`api_error` event arrives carrying the same id.
  // Required for correct OTEL attribution in round-robin mode.
  const requestAccountMap = new RequestAccountMap();
  const rateLimitStore = new RateLimitStore();

  // In-memory mirror of settings — read at startup, updated on every
  // update_settings call so proxy/rotator paths can consult it without
  // re-reading the JSON file per request.
  //
  // Sprint 2: the boot path uses `loadSettingsWithTamper` so we can
  // broadcast `settings_tamper_detected` to the UI when the file (or its
  // sidecar) failed integrity. Tamper means the user's last-known-good
  // settings have been replaced with DEFAULT_SETTINGS, so the UI banner is
  // the only signal they have that something changed. Broadcast happens
  // after IPC server starts (deferred via `setImmediate`); a synchronous
  // broadcast here would land before any clients connect.
  const initialLoad = loadSettingsWithTamper();
  let currentSettings: Settings = initialLoad.settings;

  // One-time auto-demote of provably-noisy detectors. Identifies every
  // detector that fired ≥20 times in the last 30 days with 0 blocks AND
  // 0 approvals, bulk-acknowledges their historical rows, and demotes
  // them to `'informational'` in settings so future matches still persist
  // for audit but skip the banner/notification path. Idempotent — the
  // `detector_tuning_v1` row in `_migrations` makes subsequent boots a
  // no-op. Skips ids the user has already explicitly tuned (Active or
  // Disabled) so the migration never overwrites an explicit choice.
  try {
    const result = runDetectorTuningMigration(db);
    if (result && result.demotedIds.length > 0) {
      const merged = { ...currentSettings.detectorOverrides };
      const newlyDemoted: string[] = [];
      for (const id of result.demotedIds) {
        if (merged[id] === undefined) {
          merged[id] = 'informational';
          newlyDemoted.push(id);
        }
      }
      if (newlyDemoted.length > 0) {
        currentSettings = writeSettings({ detectorOverrides: merged });
        const idList = newlyDemoted.join(', ');
        insertNotification(db, {
          ts: Date.now(),
          accountId: null,
          type: 'security_low',
          title: `Tuned ${newlyDemoted.length} noisy detector${newlyDemoted.length === 1 ? '' : 's'}`,
          body: `Auto-demoted to Low-signal observations after firing without ever blocking or being approved: ${idList}. Re-enable any in Settings > Security > Detectors.`,
        });
        console.log(
          `[Security] detector_tuning_v1: demoted ${newlyDemoted.length} detector(s) to informational: ${idList} (acknowledged ${result.acknowledgedRowCount} backlog row(s))`,
        );
      } else {
        console.log(
          '[Security] detector_tuning_v1: every candidate already had an explicit override; no changes',
        );
      }
    }
    /* v8 ignore next 3 */
  } catch (err) {
    console.error('[Security] detector_tuning_v1 failed:', err);
  }

  // Assigned after the proxy is listening — update_settings references it
  // via optional-chain so handler registration order doesn't matter.
  let usageProber: UsageProberHandle | null = null;

  // Shared settings getter so the rotator, alert evaluators, and other
  // subsystems read the same live in-memory snapshot that `update_settings`
  // mutates. Declared up-front so it can be referenced in constructors below.
  const getSettings = (): Settings => currentSettings;

  // External OTEL forwarder. Reads endpoint + header name from live
  // settings on every call; secret from the OS keychain (cached). Wired
  // into the receiver below so every OTLP/HTTP body Sentinel accepts is
  // also tee'd to the user's external backend, AND used by the periodic
  // emitter for Sentinel's own derived signals.
  const otelForwarder = new OtelForwarder({ getSettings });
  otelForwarder.onStatusChange((status) => {
    ipcServer.broadcast({ type: 'otel_forwarder_status', status });
  });
  const otelReceiver = new OtelReceiver(
    db,
    activeAccountId,
    ipcServer,
    requestAccountMap,
    otelForwarder,
  );
  const otelEmitter = new OtelEmitter({
    forwarder: otelForwarder,
    getSettings,
    db,
    serviceVersion: '0.1.0',
    hostUuid: hostUuidForOtel(),
    // Live readers — settings.otelServiceInstanceId stays stable across
    // restarts (auto-generated + persisted by `coerce()`); active-account
    // changes pick up at the next 30s tick automatically.
    getServiceInstanceId: () => currentSettings.otelServiceInstanceId,
    getActiveAccount,
  });
  otelEmitter.attachToIpc(ipcServer);
  otelEmitter.start();

  // Round-robin token pool. Only consulted when switchingMode === 'round-robin'.
  // The excluded-ids getter reads the live in-memory settings so pool-membership
  // toggles take effect on the next `tokenRotator.refresh()` (called from the
  // update_settings handler). The strategy getter is read on every `pick()` so
  // toggling the sub-strategy in Settings takes effect for the next request
  // without a restart or refresh.
  // Sentinel-side paused set — populated by SpendTracker once it's wired in
  // (stage 4). For now it's an empty reference so existing pick() callsites
  // keep working. Replacing the reference in-place keeps the rotator's live
  // getter pointed at the real set once the tracker exists.
  let getPausedAccountIds: () => ReadonlySet<string> = () => new Set();

  const tokenRotator = new TokenRotator(
    db,
    rateLimitStore,
    activeAccountId,
    () => new Set(currentSettings.poolExcludedIds),
    () => currentSettings.roundRobinStrategy,
    () => new Set(currentSettings.overageEnabledIds),
    () => getPausedAccountIds(),
    () => currentSettings.overageBufferPct,
  );

  // Mirror of `~/.claude.json:overageCreditGrantCache`. Reloaded on startup,
  // after switches, and on demand via the refresh_overage_grants IPC.
  // Broadcasts fire automatically via subscriber callback on any change.
  const overageGrantStore = new OverageGrantStore();
  overageGrantStore.load();
  overageGrantStore.onUpdate((grants) => {
    ipcServer.broadcast({ type: 'overage_grants_updated', grants });
  });

  // Real-usage fetcher: polls claude.ai's /api/organizations/{org}/usage
  // endpoint (the only source of truth for dollar-denominated overage spend
  // + limit) using the per-account sessionKey cookie stored in the keychain.
  // Broadcasts claude_ai_usage_updated on every fetch outcome.
  const claudeAiUsageStore = new ClaudeAiUsageStore({
    ipcServer,
    getOrgUuid: (accountId) => {
      const acc = listAccounts(db).find((a) => a.id === accountId);
      return acc?.orgUuid || null;
    },
    getAccountIds: () => listAccounts(db).map((a) => a.id),
    // Force a token refresh on auth_expired so a silently-revoked refresh
    // token surfaces as `token_refresh_failed` within one poll cycle. The
    // background refresher alone can't catch this — it keys on local
    // `expiresAt`, which a server-side-revoked but not-yet-expired token
    // still satisfies. On successful refresh the store retries the fetch
    // once with the new access token before recording failure.
    refreshCredential: async (accountId) => {
      // Skip when the daemon is tearing down — the DB is about to close or
      // already has, and the refresh chain would throw TypeError on listAccounts.
      if (shuttingDown) return { success: false };
      const acc = listAccounts(db).find((a) => a.id === accountId);
      const result = await refreshIfNeeded(
        { db, activeToken, activeAccountId, ipcServer, tokenRotator },
        accountId,
        acc?.email ?? '',
        /* force */ true,
      );
      return result.needsReauth
        ? { success: result.success, needsReauth: true }
        : { success: result.success };
    },
  });
  claudeAiUsageStore.start();

  // Sentinel-side spend tracker: enforces the user's weekly cap by pausing
  // accounts whose Anthropic-reported spend has reached the configured
  // limit, and fires budget-scope alerts. Hooks back into the rotator via
  // the live paused-id getter declared above.
  const spendTracker = new SpendTracker({
    db,
    rateLimitStore,
    ipcServer,
    getSettings,
    getAnthropicSpend: (accountId) => {
      const snap = claudeAiUsageStore.getSnapshot(accountId);
      return snap?.extraUsage?.usedUsd ?? null;
    },
    getOverageAllowedIds: () => new Set(currentSettings.overageEnabledIds),
  });
  getPausedAccountIds = () => spendTracker.getPausedIds();
  // The initial `spendTracker.recompute()` is deferred to after the
  // rate-limit store and the persisted paused set are loaded (see below),
  // so the first evaluator pass has full state and won't re-fire
  // `account_paused` for pauses that were already active before restart.
  //
  // Start the weekly-pause fallback sweep. Idempotent; cleared by
  // spendTracker.stop() in the SIGTERM/SIGINT handlers.
  spendTracker.start();

  /**
   * Change the active account: update ~/.claude.json, swap the Claude Code
   * keychain slot, inject the new token into the proxy, probe fresh rate
   * limits, upsert the DB row, refresh the rotator pool, and broadcast.
   *
   * Used by the `switch_account` IPC handler. Returns a serializable result
   * so callers can decide whether to retry or surface the failure.
   */
  function performSwitch(
    accountId: string,
    email: string,
  ): { success: true; data: OAuthAccount } | { success: false; error: string } {
    const currentActive = getActiveAccount();
    const lookupKey = accountId || email;
    const activeKey = currentActive
      ? sentinelKey(currentActive.organizationUuid ?? '', currentActive.accountUuid)
      : undefined;
    const creds = readActiveCredentials(lookupKey, activeKey);
    if (!creds) {
      return {
        success: false,
        error: `No credentials stored for this account. Use Sync after switching to it in Claude Code, or use "Add Account" to sign in again.`,
      };
    }

    const existingAccounts = listAccounts(db);
    const existingAccount = accountId
      ? existingAccounts.find((a) => a.id === accountId)
      : existingAccounts.find((a) => a.email === email);

    const realAccountUuid =
      existingAccount?.accountUuid || existingAccount?.id || accountId || email;

    const switchPlanType: PlanType =
      existingAccount?.planType ??
      inferPlanType({ hasExtraUsageEnabled: false, workspaceRole: null } as OAuthAccount, creds);

    const oauthAccount: OAuthAccount = {
      accountUuid: realAccountUuid,
      emailAddress: email,
      organizationUuid: existingAccount?.orgUuid ?? '',
      hasExtraUsageEnabled: switchPlanType === 'max' || switchPlanType === 'enterprise',
      billingType: creds.subscriptionType ?? 'unknown',
      accountCreatedAt: new Date().toISOString(),
      subscriptionCreatedAt: new Date().toISOString(),
      displayName: existingAccount?.displayName ?? '',
      organizationRole: 'user',
      workspaceRole: switchPlanType === 'team' || switchPlanType === 'enterprise' ? 'member' : null,
      organizationName: existingAccount?.orgName ?? '',
    };

    setActiveAccount(oauthAccount);
    activeToken.value = creds.accessToken;
    activeAccountId.value = lookupKey;

    // Drop any cached rate-limit data for the target account BEFORE probing.
    // Without this the UI reads whatever was persisted the last time this
    // account was used (possibly hours or days ago) and flashes those stale
    // numbers until the probe's response lands. probeRateLimits will
    // repopulate the store with fresh headers via rateLimitStore.update().
    rateLimitStore.clearAccount(lookupKey);
    deleteRateLimitsForAccount(db, lookupKey);

    probeRateLimits(lookupKey, ipcServer);

    try {
      writeClaudeCodeCredentials(creds);
    } catch (err) {
      console.warn(
        '[Switch] Could not update Claude Code keychain:',
        err instanceof Error ? err.message : String(err),
      );
    }

    reactivateAccount(db, lookupKey);
    upsertAccount(db, {
      id: lookupKey,
      accountUuid: realAccountUuid,
      email: oauthAccount.emailAddress,
      displayName: oauthAccount.displayName,
      orgUuid: oauthAccount.organizationUuid,
      orgName: oauthAccount.organizationName,
      planType: switchPlanType,
      isActive: true,
      createdAt: Date.now(),
      // ON CONFLICT DO UPDATE SET omits the color column, so an existing
      // user-picked color is preserved across this upsert.
      color: null,
    });

    tokenRotator.refresh();
    // Claude Code rewrote ~/.claude.json as part of the switch, so the grant
    // cache may have been updated too — re-read so subscribers and the next
    // get_overage_grants caller see fresh numbers.
    overageGrantStore.load();
    ipcServer.broadcast({ type: 'account_switched', to: oauthAccount });
    return { success: true, data: oauthAccount };
  }

  // Restore persisted rate-limit windows from SQLite so the Usage tab shows
  // data immediately on restart without waiting for a new API request.
  for (const [accountId, windows] of loadRateLimits(db)) {
    rateLimitStore.loadAccount(accountId, windows);
    console.log(`[RateLimit] Loaded ${windows.length} window(s) from DB for ${accountId}`);
  }

  // Rehydrate the SpendTracker paused set from SQLite. Must run AFTER the
  // rate-limit store is populated so loadPersistedPauses can detect
  // rollovers that happened while the daemon was off. Must also run BEFORE
  // the first recompute() so the evaluators see `this.paused.has(id)` is
  // true and skip the redundant `account_paused` broadcast +
  // insertNotification that caused the on-restart notification bug.
  spendTracker.loadPersistedPauses();
  // First recompute with full state: spend summary broadcast seeds the UI
  // dashboard, paused set is intact, evaluators no-op on already-paused
  // accounts.
  spendTracker.recompute();

  // Write through to SQLite whenever live rate-limit data arrives from API headers.
  rateLimitStore.onUpdate((accountId, windows) => {
    for (const w of windows) {
      upsertRateLimit(db, accountId, w);
    }
  });

  // Piggyback on rate-limit updates to re-read the Anthropic overage grant
  // cache — it's rewritten by Claude Code whenever it interacts with the API,
  // and those interactions are exactly the moments that also produce fresh
  // rate-limit headers. Cheap (one file read + JSON diff), silent when
  // nothing changed, and broadcasts overage_grants_updated to the UI when
  // the numbers do move.
  rateLimitStore.onUpdate(() => {
    overageGrantStore.load();
  });

  // Spend tracker also watches rate-limit updates for 5h-window rollover so
  // it can auto-unpause + re-evaluate accounts that Sentinel paused earlier.
  rateLimitStore.onUpdate((accountId) => {
    spendTracker.handleRateLimitUpdate(accountId);
  });

  // Spend source of truth is now Anthropic's usage endpoint via
  // ClaudeAiUsageStore. Every successful or failed fetch triggers a
  // tracker recompute so the paused set reflects the freshest numbers.
  //
  // Also bootstrap rateLimitStore from the snapshot for accounts that can't
  // be probed via api.anthropic.com. Silent-sibling team enrollments share
  // the parent's claude.ai sessionKey but have NO OAuth token, so
  // probeRateLimits() can't run for them. Claude.ai's usage endpoint
  // returns 5h/7d/sonnet utilization + reset times alongside the overage
  // numbers, so syncing those into rateLimitStore closes the "empty usage
  // until first proxied request" gap.
  claudeAiUsageStore.onUpdate((accountId) => {
    // Skip if the daemon is tearing down: the DB may already be closed and a
    // recompute would throw an unhandled rejection up through tick().
    if (shuttingDown) return;
    spendTracker.recompute();
    const snap = claudeAiUsageStore.getSnapshot(accountId);
    if (!snap) return;
    const synced = rateLimitStore.syncFromClaudeAiSnapshot(accountId, snap);
    if (synced > 0) {
      console.log(`[RateLimit] Synced ${synced} window(s) from claude.ai for ${accountId}`);
      ipcServer.broadcast({ type: 'rate_limits_updated', accountId });
    }
  });

  /**
   * Persist an OAuthResult into Sentinel's keychain + DB and broadcast
   * login_complete. Shared between the browser-driven `start_login`
   * path and the server-to-server `silent_sibling_login` path — both
   * end with the same state transition (new credentials, new DB row,
   * default alert seeded, login_complete broadcast), so centralizing
   * the logic means they can't drift.
   *
   * Reachable only via `start_login` → real PKCE callback → `startOAuthLogin`
   * resolution. The in-process integration harness drives `start_login` but
   * stops at the ack; completing the callback flow requires the `openAuthUrl`
   * seam that Sprint 5 already wired into `oauth.integration.test.ts`.
   * Wiring that seam through `start_login` for Sprint 6 is out of scope (see
   * documentation/TEST_MIGRATION_PLAN.md), so the body rides on an ignore
   * block. Each field it touches is exercised elsewhere (`upsertAccount`,
   * `upsertAlert`, `writeSentinelCredentials`, `probeRateLimits`,
   * `setActiveAccount`, `tokenRotator.refresh`).
   */
  /* v8 ignore start */
  const persistOAuthResult = (result: OAuthResult): void => {
    const {
      credentials,
      email,
      displayName,
      accountUuid,
      orgUuid,
      orgName,
      subscriptionType,
      organizationRole,
      workspaceRole,
      hasExtraUsageEnabled,
    } = result;
    const credKey = sentinelKey(orgUuid, accountUuid) || email;
    const wasReauth = hasActiveAccount(db, credKey);

    writeSentinelCredentials(credKey, credentials);

    // Immediately probe rate-limit headers so the Usage tab shows the 5h
    // quota bar on first render after add, rather than waiting for the
    // first proxied Claude Code request (or the 300s background poller)
    // to populate rateLimitStore. Mirrors what performSwitch does at the
    // switch path.
    probeRateLimits(credKey, ipcServer, credentials.accessToken);

    const newAccount: OAuthAccount = {
      accountUuid: accountUuid || email,
      emailAddress: email,
      organizationUuid: orgUuid,
      hasExtraUsageEnabled,
      billingType: subscriptionType ?? 'unknown',
      accountCreatedAt: new Date().toISOString(),
      subscriptionCreatedAt: new Date().toISOString(),
      displayName,
      organizationRole: (organizationRole as OAuthAccount['organizationRole']) || 'user',
      workspaceRole,
      organizationName: orgName,
    };

    reactivateAccount(db, credKey);
    markAccountReauthenticated(credKey);

    const planType = inferPlanType(newAccount, credentials);
    upsertAccount(db, {
      id: credKey,
      accountUuid: newAccount.accountUuid,
      email: newAccount.emailAddress,
      displayName: newAccount.displayName,
      orgUuid: newAccount.organizationUuid,
      orgName: newAccount.organizationName,
      planType,
      isActive: false,
      createdAt: Date.now(),
      color: null,
    });

    if (listAlerts(db, { scope: 'account', accountId: credKey }).length === 0) {
      upsertAlert(db, { scope: 'account', accountId: credKey, thresholdPct: 95, enabled: true });
      console.log(`[OAuth] Seeded default 95% alert for ${credKey}`);
    }

    const current = getActiveAccount();
    if (!current) {
      setActiveAccount(newAccount);
      activeToken.value = credentials.accessToken;
    }

    tokenRotator.refresh();

    // Kick an immediate usage fetch for the new account so the Usage
    // tab renders real overage / extra-usage numbers on first open
    // rather than waiting up to 30s for the next poll tick. Fire-and-
    // forget: failures are surfaced via the store's own broadcast path
    // (claude_ai_usage_updated with an error discriminator).
    void claudeAiUsageStore.refresh(credKey);

    console.log(
      `[OAuth] Login complete for ${email} (org: ${orgName || '?'}, reauth: ${wasReauth}), broadcasting to ${ipcServer.connectedClients} client(s)`,
    );
    ipcServer.broadcast({ type: 'login_complete', email, orgName, reauth: wasReauth });
  };
  /* v8 ignore stop */

  // Register IPC message handlers
  ipcServer.onMessage((msg, respond) => {
    switch (msg.type) {
      case 'get_accounts': {
        const accounts = listAccounts(db);
        const active = getActiveAccount();
        const activeKey = active
          ? sentinelKey(active.organizationUuid ?? '', active.accountUuid)
          : null;
        respond({
          requestType: 'get_accounts',
          success: true,
          data: accounts.map((a) => ({
            ...a,
            isActive: activeKey === a.id,
          })),
        });
        break;
      }

      case 'get_credentials': {
        const blob = credentialStore.get(msg.email) ?? null;
        if (blob !== null) {
          respond({ requestType: 'get_credentials', success: true, data: blob });
        } else {
          respond({
            requestType: 'get_credentials',
            success: false,
            error: `No credentials stored for ${msg.email}`,
          });
        }
        break;
      }

      case 'store_credentials': {
        credentialStore.set(msg.email, msg.blob);
        respond({ requestType: 'store_credentials', success: true });
        break;
      }

      case 'set_otel_exporter_secret': {
        // Empty value is treated as "clear" — convenient for the UI's
        // single-input save flow.
        if (typeof msg.value === 'string' && msg.value.length > 0) {
          writeOtelExporterSecret(msg.value);
        } else {
          deleteOtelExporterSecret();
        }
        otelForwarder.onSecretChanged();
        respond({ requestType: 'set_otel_exporter_secret', success: true });
        break;
      }

      case 'clear_otel_exporter_secret': {
        deleteOtelExporterSecret();
        otelForwarder.onSecretChanged();
        respond({ requestType: 'clear_otel_exporter_secret', success: true });
        break;
      }

      case 'get_otel_exporter_status': {
        respond({
          requestType: 'get_otel_exporter_status',
          success: true,
          data: otelForwarder.getStatus(),
        });
        break;
      }

      case 'test_otel_exporter': {
        // User-initiated probe; bounded by the forwarder's per-request
        // timeout. Don't block the IPC switch — respond from the .then().
        void otelForwarder
          .testConnection()
          .then((result) => {
            respond({ requestType: 'test_otel_exporter', success: true, data: result });
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            respond({
              requestType: 'test_otel_exporter',
              success: false,
              error: message,
            });
          });
        break;
      }

      case 'get_otel_drift_state': {
        // Always re-inspect — cheap (single file read) and avoids stale
        // results if the user just hand-edited settings.json a moment
        // before opening the Metrics tab.
        void inspectClaudeOtelConfig(claudeSettingsPath, currentSettings.otelExporterEndpoint)
          .then((details) => {
            respond({ requestType: 'get_otel_drift_state', success: true, data: details });
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            respond({ requestType: 'get_otel_drift_state', success: false, error: message });
          });
        break;
      }

      case 'repatch_otel_settings': {
        void (async () => {
          try {
            const written = await repatchClaudeOtelSettings(claudeSettingsPath);
            const envBlock = (written['env'] as Record<string, unknown> | undefined) ?? {};
            otelSettingsWatcher.markWritten(envBlock);
            const details = await otelSettingsWatcher.inspectAndBroadcast();
            respond({ requestType: 'repatch_otel_settings', success: true, data: details });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            respond({ requestType: 'repatch_otel_settings', success: false, error: message });
          }
        })();
        break;
      }

      case 'promote_foreign_otel_endpoint': {
        void (async () => {
          try {
            // Re-inspect so promote operates on the file's current state
            // rather than a stale broadcast cache. Cheap, removes a class
            // of TOCTOU bugs around the user racing a foreign tool.
            const before = await inspectClaudeOtelConfig(
              claudeSettingsPath,
              currentSettings.otelExporterEndpoint,
            );
            if (before.state !== 'foreign-endpoint') {
              respond({
                requestType: 'promote_foreign_otel_endpoint',
                success: false,
                error: `Cannot promote: drift state is "${before.state}", expected "foreign-endpoint"`,
              });
              return;
            }
            const candidateEndpoint =
              before.actual.metricsEndpoint ?? before.actual.logsEndpoint ?? before.actual.endpoint;
            if (!candidateEndpoint || !isUrlSafeForForwarder(candidateEndpoint)) {
              respond({
                requestType: 'promote_foreign_otel_endpoint',
                success: false,
                error:
                  'Foreign endpoint is HTTP (and not loopback). Sentinel only forwards to HTTPS or loopback endpoints to keep ingestion keys off the wire in plaintext.',
              });
              return;
            }
            const headers = parseOtlpHeaders(before.actual.headers);
            const chosenName = msg.chosenHeaderName;
            const chosen = chosenName
              ? (headers.find((h) => h.name === chosenName) ?? null)
              : pickAuthHeader(headers);

            // Sequence matters: secret → settings → re-patch. Reversing
            // risks a window where Claude Code points at Sentinel but
            // Sentinel has no downstream destination, so the user's
            // foreign tool silently stops receiving data.
            if (chosen) {
              writeOtelExporterSecret(chosen.value);
            }
            const patch: Partial<Settings> = {
              otelExporterEndpoint: candidateEndpoint,
              otelForwardingEnabled: true,
            };
            if (chosen) patch.otelExporterHeaderName = chosen.name;
            currentSettings = writeSettings(patch);
            ipcServer.broadcast({ type: 'settings_changed', settings: currentSettings });
            otelForwarder.onSecretChanged();

            const written = await repatchClaudeOtelSettings(claudeSettingsPath);
            const envBlock = (written['env'] as Record<string, unknown> | undefined) ?? {};
            otelSettingsWatcher.markWritten(envBlock);
            const details = await otelSettingsWatcher.inspectAndBroadcast();
            respond({
              requestType: 'promote_foreign_otel_endpoint',
              success: true,
              data: details,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            respond({
              requestType: 'promote_foreign_otel_endpoint',
              success: false,
              error: message,
            });
          }
        })();
        break;
      }

      case 'get_usage_summary': {
        const active = getActiveAccount();
        if (!active) {
          respond({ requestType: 'get_usage_summary', success: false, error: 'No active account' });
          break;
        }
        // Query by sentinel key (org-specific) so that switching accounts shows
        // per-org usage. Falls back gracefully: if no events exist under the
        // sentinel key yet, the chart is empty until the first API call comes in.
        const usageSentinelKey = sentinelKey(active.organizationUuid ?? '', active.accountUuid);
        const byDayModel = getUsageByDayModel(db, usageSentinelKey, msg.days ?? 7);
        respond({
          requestType: 'get_usage_summary',
          success: true,
          data: { days: msg.days ?? 7, accountId: usageSentinelKey, byDayModel },
        });
        break;
      }

      case 'get_metrics_summary': {
        // Scope resolution — priority:
        //   1. msg.accountIds: aggregate across the list (pool/all views)
        //   2. msg.accountId: single explicit account (per-tab picker)
        //   3. active account fallback
        let keys: string[] = [];
        let responseAccountId = '';
        let scope: MetricsSummary['scope'];
        if (msg.accountIds && msg.accountIds.length > 0) {
          keys = msg.accountIds;
          const kind = msg.scopeKind ?? 'pool';
          const label = msg.scopeLabel ?? (kind === 'all' ? 'All accounts' : 'Pool');
          responseAccountId = kind === 'all' ? '__all__' : '__pool__';
          scope = { kind, label, memberCount: keys.length };
        } else if (msg.accountId) {
          keys = [msg.accountId];
          responseAccountId = msg.accountId;
          scope = { kind: 'account', id: msg.accountId };
        } else {
          const active = getActiveAccount();
          if (active) {
            const k = sentinelKey(active.organizationUuid ?? '', active.accountUuid);
            keys = [k];
            responseAccountId = k;
            scope = { kind: 'account', id: k };
          }
        }
        if (keys.length === 0) {
          respond({
            requestType: 'get_metrics_summary',
            success: false,
            error: 'No active account',
          });
          break;
        }
        const days = msg.days ?? 7;
        // Bundle every dashboard slice in one round-trip. Query helpers all
        // accept (accountIds, days, …, win) and do their own windowing, so
        // ordering here is just for readability. When `msg.window` is present
        // it overrides the rolling `days` lookback inside each helper.
        const win = msg.window;
        const byDayModel = getTokensByDayModel(db, keys, days, win);
        const cacheHitRate = getCacheHitRate(db, keys, days, win);
        const errors = getApiErrorsByDay(db, keys, days, win);
        const tools = getToolStats(db, keys, days, 20, win);
        const perDayCounters = getActivityCounters(
          db,
          keys,
          days,
          [
            'session',
            'commit',
            'pull_request',
            'lines_added',
            'lines_removed',
            'active_user_seconds',
            'active_cli_seconds',
          ],
          win,
        );
        const editAcceptRate = getEditAcceptRate(db, keys, days, win);
        const toolDecisions = getToolDecisionBreakdown(db, keys, days, win);
        const prompts = getUserPromptStats(db, keys, days, win);
        const skills = getTopSkills(db, keys, days, 10, win);
        const plugins = getRecentPlugins(db, keys, 10);
        const cacheTtl = {
          byDayModel: getCacheTtlByDayModel(db, keys, days, win),
          bySession: getCacheTtlBySession(db, keys, days, 50, win),
        };

        // [OTEL-DIAG] Temporary: compare the query's account filter + window to
        // what the receiver stored — settles "written but not shown" (attribution
        // or day-window mismatch). Remove before merging to main.
        console.log(
          `[OTEL-DIAG] get_metrics_summary keys=${JSON.stringify(keys)} days=${days} ` +
            `win=${win ? JSON.stringify(win) : '-'} ` +
            `byDayModelDays=${Object.keys(byDayModel).length} ` +
            `errorDays=${Object.keys(errors.byDay).length} tools=${tools.length} ` +
            `activityDays=${Object.keys(perDayCounters).length}`,
        );

        // Reshape per-day counters into the flat per-kind records the UI wants.
        const sessionsPerDay: Record<string, number> = {};
        const commitsPerDay: Record<string, number> = {};
        const prsPerDay: Record<string, number> = {};
        const linesPerDay: Record<string, { added: number; removed: number }> = {};
        const activeTimePerDay: Record<string, { user: number; cli: number }> = {};
        for (const [day, row] of Object.entries(perDayCounters)) {
          if (row.session != null) sessionsPerDay[day] = row.session;
          if (row.commit != null) commitsPerDay[day] = row.commit;
          if (row.pull_request != null) prsPerDay[day] = row.pull_request;
          if (row.lines_added != null || row.lines_removed != null) {
            linesPerDay[day] = { added: row.lines_added ?? 0, removed: row.lines_removed ?? 0 };
          }
          if (row.active_user_seconds != null || row.active_cli_seconds != null) {
            activeTimePerDay[day] = {
              user: row.active_user_seconds ?? 0,
              cli: row.active_cli_seconds ?? 0,
            };
          }
        }

        respond({
          requestType: 'get_metrics_summary',
          success: true,
          data: {
            days,
            accountId: responseAccountId,
            scope,
            byDayModel,
            cacheHitRate,
            errors,
            tools,
            activity: { sessionsPerDay, commitsPerDay, prsPerDay, linesPerDay, activeTimePerDay },
            editAcceptRate,
            toolDecisions,
            prompts,
            skills,
            plugins,
            cacheTtl,
          },
        });
        break;
      }

      case 'switch_account': {
        const result = performSwitch(msg.accountId, msg.email);
        if (!result.success) {
          respond({ requestType: 'switch_account', success: false, error: result.error });
        } else {
          respond({ requestType: 'switch_account', success: true, data: result.data });
        }
        break;
      }

      case 'refresh_accounts': {
        // Re-read ~/.claude.json and snapshot the current active account's
        // keychain token into Sentinel's own store so we can restore it later
        // when switching back to this account from the UI.
        const current = getActiveAccount();
        if (current) {
          const credKey = sentinelKey(current.organizationUuid ?? '', current.accountUuid);
          const creds = captureCurrentCredentials(credKey);
          // Preserve the existing planType from the DB — don't re-derive it from
          // ~/.claude.json metadata, which may reflect a previous account's state
          // (Sentinel itself writes hasExtraUsageEnabled during switches, so it can
          // be stale when a different account becomes active). Only infer for new entries.
          const allAcctsForRefresh = listAccounts(db);
          const existingForRefresh = allAcctsForRefresh.find((a) => a.id === credKey);
          upsertAccount(db, {
            id: credKey,
            accountUuid: current.accountUuid,
            email: current.emailAddress,
            displayName: current.displayName ?? '',
            orgUuid: current.organizationUuid ?? '',
            orgName: current.organizationName ?? '',
            planType: existingForRefresh?.planType ?? inferPlanType(current, creds),
            isActive: true,
            createdAt: Date.now(),
            color: existingForRefresh?.color ?? null,
          });
          if (creds) activeToken.value = creds.accessToken;
          // Keep proxy rate-limit key in sync with active account
          activeAccountId.value = credKey;

          // Remove old-style duplicate rows for this email+org (pre-sentinelKey rows
          // where id = accountUuid instead of orgUuid). Scoped to the same org_uuid
          // so accounts in other orgs with the same email are left untouched.
          deleteStaleAccountRows(db, current.emailAddress, credKey, current.organizationUuid ?? '');
        }
        const accounts = listAccounts(db);
        const active = getActiveAccount();
        const activeCredKey = active
          ? sentinelKey(active.organizationUuid ?? '', active.accountUuid)
          : null;
        respond({
          requestType: 'refresh_accounts',
          success: true,
          data: accounts.map((a) => ({ ...a, isActive: activeCredKey === a.id })),
        });
        break;
      }

      case 'remove_account': {
        // "Keep Data" path — soft-delete only, data remains accessible later.
        // "Delete Data" path — purge data and leave a tombstone (removed = 2).
        const removed = msg.deleteData
          ? purgeAccount(db, msg.accountId)
          : markAccountRemoved(db, msg.accountId);
        tokenRotator.refresh();
        respond({ requestType: 'remove_account', success: removed });
        break;
      }

      case 'purge_account': {
        const purged = purgeAccount(db, msg.accountId);
        tokenRotator.refresh();
        respond({ requestType: 'purge_account', success: purged });
        break;
      }

      case 'get_removed_accounts': {
        const removedAccounts = listRemovedAccounts(db);
        respond({ requestType: 'get_removed_accounts', success: true, data: removedAccounts });
        break;
      }

      case 'acknowledge_notification': {
        const ok = acknowledgeNotification(db, msg.id);
        respond({ requestType: 'acknowledge_notification', success: ok });
        break;
      }

      case 'acknowledge_all_notifications': {
        const count = acknowledgeAllNotifications(db, msg.accountId);
        respond({ requestType: 'acknowledge_all_notifications', success: true, data: { count } });
        break;
      }

      case 'get_rate_limits': {
        // View-scope account: use msg.accountId when provided (per-tab picker),
        // otherwise fall back to the currently active account (legacy behavior).
        let rlKey: string;
        if (msg.accountId) {
          rlKey = msg.accountId;
        } else {
          const activeForRl = getActiveAccount();
          rlKey = activeForRl
            ? sentinelKey(activeForRl.organizationUuid ?? '', activeForRl.accountUuid)
            : 'default';
        }
        const rlData = rateLimitStore.getAll(rlKey);
        console.log(`[IPC] get_rate_limits: key=${rlKey}, windows=${rlData.length}`);
        respond({ requestType: 'get_rate_limits', success: true, data: rlData });
        break;
      }

      case 'get_all_rate_limits': {
        const all = rateLimitStore.getAllByAccount();
        respond({ requestType: 'get_all_rate_limits', success: true, data: all });
        break;
      }

      case 'get_daemon_status': {
        respond({
          requestType: 'get_daemon_status',
          success: true,
          data: {
            pid: process.pid,
            uptimeMs: Date.now() - DAEMON_STARTED_AT,
            startedAt: DAEMON_STARTED_AT,
          },
        });
        break;
      }

      case 'shutdown_daemon': {
        console.log('[Sentinel] Shutdown requested via IPC — exiting.');
        // Respond first so the caller sees success before the socket closes.
        respond({ requestType: 'shutdown_daemon', success: true });
        // Give the response a moment to flush, then exit cleanly.
        setTimeout(() => process.exit(0), 100);
        break;
      }

      case 'purge_all_data': {
        // Delete every Sentinel-owned keychain entry. Also cover any lingering
        // soft- or hard-removed rows — once the user hits Uninstall we want
        // zero trace of their credentials left on the system.
        //
        // Covers both services Sentinel writes to: `Sentinel-credentials`
        // (OAuth tokens) AND `Sentinel-claude-ai-session` (claude.ai
        // session cookies used to read overage budget). Missing the session
        // service meant a post-uninstall reinstall silently inherited the old
        // cookie, so the app never asked the user to reconnect claude.ai.
        //
        // Does NOT touch `Claude Code-credentials` — that slot is owned by
        // Claude Code, not Sentinel. Users who want to also sign out of
        // Claude Code must do so through CC's own flow.
        const active = listAccounts(db);
        const removed = listRemovedAccounts(db);
        const seen = new Set<string>();
        const purgeKey = (key: string): void => {
          if (seen.has(key)) return;
          deleteSentinelCredentials(key);
          seen.add(key);
        };
        for (const a of [...active, ...removed]) {
          purgeKey(a.id);
          // Cover the legacy case where the entry was keyed by accountUuid
          // (pre-sentinelKey rows) rather than the sentinel id.
          if (a.accountUuid) purgeKey(a.accountUuid);
          // Older entries were email-keyed (see SENTINEL_SERVICE fallback in
          // persistOAuthResult's credKey). Clear those too when present.
          if (a.email) purgeKey(a.email);
        }
        console.log(`[Sentinel] Purged keychain entries for ${seen.size} identifier(s).`);
        respond({ requestType: 'purge_all_data', success: true });
        break;
      }

      case 'get_settings': {
        respond({ requestType: 'get_settings', success: true, data: loadSettings() });
        break;
      }

      case 'get_overage_grants': {
        respond({
          requestType: 'get_overage_grants',
          success: true,
          data: overageGrantStore.getAll(),
        });
        break;
      }

      case 'refresh_overage_grants': {
        overageGrantStore.load();
        respond({
          requestType: 'refresh_overage_grants',
          success: true,
          data: overageGrantStore.getAll(),
        });
        break;
      }

      case 'get_spend_summary': {
        respond({
          requestType: 'get_spend_summary',
          success: true,
          data: spendTracker.getSpendSummary(),
        });
        break;
      }

      case 'get_paused_accounts': {
        respond({
          requestType: 'get_paused_accounts',
          success: true,
          data: spendTracker.getPausedDetails(),
        });
        break;
      }

      case 'get_claude_ai_usage': {
        respond({
          requestType: 'get_claude_ai_usage',
          success: true,
          data: {
            snapshot: claudeAiUsageStore.getSnapshot(msg.accountId),
            error: claudeAiUsageStore.getLastError(msg.accountId),
          },
        });
        break;
      }

      case 'refresh_claude_ai_usage': {
        // Kick off the fetch and respond immediately; the result lands via
        // the usual claude_ai_usage_updated broadcast when it completes.
        // Avoiding `await` keeps this handler sync-friendly (the outer
        // switch isn't an async fn). Deliberately free (no Haiku probe) so
        // the UI can fire this on mount/focus for every account as an
        // auth-liveness check without burning tokens — the fetch's 401
        // path triggers the force-refresh cascade that surfaces dead
        // tokens as the Re-authenticate banner.
        void claudeAiUsageStore.refresh(msg.accountId);
        respond({ requestType: 'refresh_claude_ai_usage', success: true });
        break;
      }

      case 'probe_rate_limits': {
        // Fire a minimal /v1/messages request through our local proxy to
        // capture a fresh `unified-5h-reset` header into RateLimitStore.
        // Claude.ai's usage endpoint often returns null for that field,
        // and syncFromClaudeAiSnapshot's merge preserves a stale value —
        // the probe is the only reliable way to force the countdown to
        // advance. Skipped for silent-sibling team enrollments that have
        // no OAuth token. Costs ~1 Haiku token, fire-and-forget.
        const credsForProbe = readSentinelCredentials(msg.accountId);
        if (credsForProbe?.accessToken) {
          probeRateLimits(msg.accountId, ipcServer, credsForProbe.accessToken);
        }
        respond({ requestType: 'probe_rate_limits', success: true });
        break;
      }

      case 'update_settings': {
        const prev = currentSettings;
        const next = writeSettings(msg.settings);
        currentSettings = next;
        // Mode flipping to round-robin may need a fresh token pool (e.g. new
        // account was just added). Cheap to refresh unconditionally.
        tokenRotator.refresh();
        // Budget field changes should re-evaluate paused state + alerts
        // immediately so the UI reflects the new caps without waiting on
        // another OTEL batch. Also covers setting a cap lower than the
        // current spend — the pause fires right away.
        const budgetsChanged =
          prev.budgetWeeklyUsdGlobal !== next.budgetWeeklyUsdGlobal ||
          JSON.stringify(prev.budgetWeeklyUsdByAccount) !==
            JSON.stringify(next.budgetWeeklyUsdByAccount);
        if (budgetsChanged) spendTracker.recompute();
        // Pool composition may have changed (mode toggle or exclusion list
        // edit). Re-evaluate pool alerts so crossings visible to the new
        // pool fire now instead of waiting for the next rate-limit header.
        const poolChanged =
          prev.switchingMode !== next.switchingMode ||
          prev.poolExcludedIds.length !== next.poolExcludedIds.length ||
          prev.poolExcludedIds.some((id, i) => id !== next.poolExcludedIds[i]);
        if (poolChanged) {
          evaluatePoolOnce(poolAlertDeps);
          evaluateWeeklyPoolOnce(poolAlertDeps);
        }
        // Interval change → restart the background prober so the new cadence
        // takes effect immediately (no daemon restart).
        if (prev.backgroundProbeIntervalSec !== next.backgroundProbeIntervalSec) {
          usageProber?.restart();
        }
        // Log level change — single mutation on the logger; next emit sees it.
        if (prev.logLevel !== next.logLevel) {
          log.setLevel(next.logLevel);
          log.info(`[Logger] Level changed to ${next.logLevel}`);
        }
        // Manual auto-mode override flipped? Let the enforcer re-broadcast
        // its unified status so the UI banner doesn't have to compose it.
        if (
          prev.toolPermissionAutoModeActive !== next.toolPermissionAutoModeActive ||
          prev.toolPermissionSkipInAutoMode !== next.toolPermissionSkipInAutoMode
        ) {
          permissionsEnforcer.onSettingsChanged();
        }
        // Claude Code sync toggle. Engine start/stop is async but we
        // don't block the IPC response on it — the UI updates from
        // the `claude_sync_status` broadcast the engine emits once
        // its initial pull finishes.
        if (prev.claudeCodeSyncEnabled !== next.claudeCodeSyncEnabled) {
          if (next.claudeCodeSyncEnabled) {
            void claudeSyncEngine.start().catch((err: unknown) => {
              console.error('[ClaudeSync] start failed:', err);
            });
          } else {
            claudeSyncEngine.stop();
          }
        }
        ipcServer.broadcast({ type: 'settings_changed', settings: next });
        respond({ requestType: 'update_settings', success: true, data: next });
        break;
      }

      case 'update_account': {
        // Only the fields the message carries are persisted; others are
        // left untouched. Currently just `color` (with `null` meaning reset).
        if (msg.color !== undefined) {
          setAccountColor(db, msg.accountId, msg.color);
        }
        const updated = getAccount(db, msg.accountId);
        if (updated) {
          ipcServer.broadcast({ type: 'account_updated', accountId: msg.accountId });
        }
        respond({
          requestType: 'update_account',
          success: updated !== null,
          ...(updated ? { data: updated } : { error: `unknown accountId: ${msg.accountId}` }),
        });
        break;
      }

      case 'get_daemon_logs': {
        respond({
          requestType: 'get_daemon_logs',
          success: true,
          data: log.getHistory(msg.limit ?? 2000),
        });
        break;
      }

      case 'clear_daemon_logs': {
        const { count } = log.clear();
        ipcServer.broadcast({ type: 'daemon_logs_cleared' });
        respond({ requestType: 'clear_daemon_logs', success: true, data: { count } });
        break;
      }

      case 'get_request_detail': {
        const detail = requestLogStore.get(msg.requestId);
        respond({ requestType: 'get_request_detail', success: true, data: detail });
        break;
      }

      case 'get_request_summaries': {
        const summaries = requestLogStore.getSummaries(msg.requestIds);
        respond({ requestType: 'get_request_summaries', success: true, data: summaries });
        break;
      }

      case 'clear_request_logs': {
        const deleted = requestLogStore.clearAll();
        ipcServer.broadcast({ type: 'request_logs_cleared', deleted });
        respond({ requestType: 'clear_request_logs', success: true, data: { deleted } });
        break;
      }

      case 'get_notifications': {
        const rows = listNotifications(db, {
          limit: msg.limit ?? 50,
          ...(msg.beforeTs !== undefined ? { beforeTs: msg.beforeTs } : {}),
          ...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}),
          ...(msg.types !== undefined ? { types: msg.types } : {}),
        });
        respond({ requestType: 'get_notifications', success: true, data: rows });
        break;
      }

      case 'get_security_events': {
        const rows = listSecurityEvents(db, {
          ...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}),
          limit: msg.limit ?? 50,
          ...(msg.beforeTs !== undefined ? { beforeTs: msg.beforeTs } : {}),
          excludeTelemetry: msg.includeWeakSignals !== true,
          ...(msg.severity !== undefined ? { severity: msg.severity } : {}),
          ...(msg.kinds !== undefined ? { kinds: msg.kinds } : {}),
          ...(msg.search !== undefined ? { search: msg.search } : {}),
        });
        respond({ requestType: 'get_security_events', success: true, data: rows });
        break;
      }

      case 'get_detector_stats': {
        const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
        const rows = listDetectorStats(db, msg.windowMs ?? DEFAULT_WINDOW_MS);
        const overrides = currentSettings.detectorOverrides ?? {};
        const data = rows.map((r) => ({
          ...r,
          override: (overrides[r.detectorId] ?? 'active') as
            | 'active'
            | 'informational'
            | 'disabled',
        }));
        respond({ requestType: 'get_detector_stats', success: true, data });
        break;
      }

      case 'acknowledge_security_event': {
        const ok = acknowledgeSecurityEvent(db, msg.id);
        respond({ requestType: 'acknowledge_security_event', success: ok });
        break;
      }

      case 'acknowledge_all_security_events': {
        const n = acknowledgeAllSecurityEvents(db, msg.accountId);
        respond({
          requestType: 'acknowledge_all_security_events',
          success: true,
          data: { count: n },
        });
        break;
      }

      case 'clear_security_events': {
        const n = clearSecurityEvents(db, msg.accountId);
        respond({ requestType: 'clear_security_events', success: true, data: { count: n } });
        break;
      }

      case 'get_security_allowlist': {
        const entries = listSecurityAllowlist(db);
        respond({ requestType: 'get_security_allowlist', success: true, data: entries });
        break;
      }

      case 'add_to_security_allowlist': {
        let args: {
          matchHash: string;
          detectorId: string;
          matchMask?: string | null;
          title?: string | null;
          note?: string | null;
        } | null = null;

        if (msg.eventId !== undefined) {
          const row = db
            .prepare(
              'SELECT match_hash, detector_id, match_mask, title FROM security_events WHERE id = ?',
            )
            .get(msg.eventId) as
            | { match_hash: string; detector_id: string; match_mask: string | null; title: string }
            | undefined;
          if (!row) {
            respond({
              requestType: 'add_to_security_allowlist',
              success: false,
              error: 'event not found',
            });
            break;
          }
          args = {
            matchHash: row.match_hash,
            detectorId: row.detector_id,
            matchMask: row.match_mask,
            title: row.title,
            note: msg.note ?? null,
          };
        } else if (msg.matchHash && msg.detectorId) {
          args = {
            matchHash: msg.matchHash,
            detectorId: msg.detectorId,
            matchMask: msg.matchMask ?? null,
            title: msg.title ?? null,
            note: msg.note ?? null,
          };
        } else {
          respond({
            requestType: 'add_to_security_allowlist',
            success: false,
            error: 'eventId or (matchHash, detectorId) required',
          });
          break;
        }

        const result = addSecurityAllowlist(db, args);
        respond({ requestType: 'add_to_security_allowlist', success: true, data: result });
        ipcServer.broadcast({ type: 'security_allowlist_updated' });
        break;
      }

      case 'remove_from_security_allowlist': {
        const ok = removeSecurityAllowlist(db, msg.id);
        respond({ requestType: 'remove_from_security_allowlist', success: ok });
        if (ok) ipcServer.broadcast({ type: 'security_allowlist_updated' });
        break;
      }

      case 'get_permission_bypasses': {
        const rows = listPermissionBypasses(db);
        respond({ requestType: 'get_permission_bypasses', success: true, data: rows });
        break;
      }

      case 'remove_permission_bypass': {
        const ok = removePermissionBypass(db, msg.id);
        respond({ requestType: 'remove_permission_bypass', success: ok });
        if (ok) ipcServer.broadcast({ type: 'permission_bypasses_updated' });
        break;
      }

      case 'get_incident_replay': {
        try {
          const replay = listIncidentReplay(db, msg.eventId);
          respond({ requestType: 'get_incident_replay', success: true, data: replay });
          /* v8 ignore next 4 */
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          respond({ requestType: 'get_incident_replay', success: false, error: message });
        }
        break;
      }

      case 'export_audit_log_signed': {
        try {
          const opts: { accountId?: string; sinceTs?: number } = {};
          if (msg.accountId !== undefined) opts.accountId = msg.accountId;
          if (msg.sinceTs !== undefined) opts.sinceTs = msg.sinceTs;
          const entries = listAuditExport(db, opts);
          const tipPayloadHash = entries.length > 0 ? entries[entries.length - 1]!.payloadHash : '';
          const exportPayload = {
            integrity: {
              algorithm: 'sha256',
              tipPayloadHash,
              count: entries.length,
              generatedAt: Date.now(),
            },
            entries,
          };
          respond({
            requestType: 'export_audit_log_signed',
            success: true,
            data: exportPayload,
          });
          /* v8 ignore next 4 */
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          respond({ requestType: 'export_audit_log_signed', success: false, error: message });
        }
        break;
      }

      case 'claude_sync_pull': {
        // Honour the caller's initial-merge preference for first-enable.
        // Subsequent manual pulls default to 'merge' which leaves
        // local rules alone. Fire-and-forget: the engine broadcasts
        // `claude_sync_status` with success/error, and the UI uses
        // that rather than the RPC response for end-state.
        void claudeSyncEngine.pullNow(msg.mode ?? 'merge');
        respond({ requestType: 'claude_sync_pull', success: true });
        break;
      }

      case 'claude_sync_push': {
        void claudeSyncEngine.pushNow();
        respond({ requestType: 'claude_sync_push', success: true });
        break;
      }

      case 'get_claude_sync_status': {
        respond({
          requestType: 'get_claude_sync_status',
          success: true,
          data: claudeSyncEngine.getStatus(),
        });
        break;
      }

      case 'run_scan_benchmark': {
        // The bench is CPU-heavy (3-10 s on typical hardware).
        // Defer via setImmediate so the current IPC message's ack
        // flushes before the scan loop blocks the event loop, and
        // any broadcasts queued behind us get a chance to drain.
        // The response still comes back on the same requestId once
        // the bench completes.
        setImmediate(() => {
          try {
            const result = runScanBenchmark();
            // Persist alongside other settings so the UI's
            // "last tuned" display and the wizard's bench step see
            // the same state after restart.
            try {
              writeSettings({ ...currentSettings, lastScanBenchmark: result });
              currentSettings = { ...currentSettings, lastScanBenchmark: result };
              ipcServer.broadcast({ type: 'settings_changed', settings: currentSettings });
            } catch (err) {
              console.error('[ScanBench] persist failed:', err);
            }
            respond({ requestType: 'run_scan_benchmark', success: true, data: result });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[ScanBench] run failed:', err);
            respond({
              requestType: 'run_scan_benchmark',
              success: false,
              error: `benchmark failed: ${message}`,
            });
          }
        });
        break;
      }

      case 'approve_blocked_request': {
        // Scanner + permissions each own a pending-block registry with
        // disjoint UUID namespaces, so trying both is safe — at most
        // one returns true. Accept success from either. The scanner
        // doesn't take opts (it always adds to its own allowlist on
        // approve); the permissions path forwards `addBypass` and the
        // Sprint 9 `mode` so the banner's radio routes to either a
        // session grant (12h TTL row) or a permanent allow rule.
        const addBypass = msg.addBypass === true;
        const mode: 'once' | 'session' | 'always' | undefined =
          msg.mode === 'session' || msg.mode === 'always' || msg.mode === 'once'
            ? msg.mode
            : undefined;
        const opts: { addBypass: boolean; mode?: 'once' | 'session' | 'always' } = { addBypass };
        if (mode) opts.mode = mode;
        const ok =
          securityScanner.resolvePending(msg.pendingId, 'approve') ||
          (permissionsEnforcer?.resolvePending(msg.pendingId, 'approve', opts) ?? false);
        respond({ requestType: 'approve_blocked_request', success: ok });
        break;
      }

      case 'list_recent_working_dirs': {
        const cwds = permissionsEnforcer?.getRecentCwds() ?? [];
        respond({ requestType: 'list_recent_working_dirs', success: true, data: cwds });
        break;
      }

      case 'deny_blocked_request': {
        const ok =
          securityScanner.resolvePending(msg.pendingId, 'deny') ||
          (permissionsEnforcer?.resolvePending(msg.pendingId, 'deny') ?? false);
        respond({ requestType: 'deny_blocked_request', success: ok });
        break;
      }

      case 'list_pending_blocks': {
        // Merge both registries so the app can re-render a full banner
        // stack after an IPC reconnect. Scanner entries carry an
        // implicit source of 'scanner' (default); permission entries
        // set their source explicitly.
        const scannerPending = securityScanner.listPending();
        const permissionsPending = permissionsEnforcer?.listPending() ?? [];
        const rows = [...scannerPending, ...permissionsPending];
        respond({ requestType: 'list_pending_blocks', success: true, data: rows });
        break;
      }

      case 'dev_trigger_security_event': {
        // Fire a synthetic security event through the normal scanner or
        // enforcer plumbing. Exposed for `pnpm security:test`; see
        // packages/daemon/src/security/scanner.ts for the scanner scenario
        // set and packages/daemon/src/security/permissions/enforcer.ts for
        // the permissions-* scenario set.
        const targetAccountId = msg.accountId ?? activeAccountId.value ?? 'default';
        try {
          if (msg.scenario.startsWith('permissions-')) {
            permissionsEnforcer.triggerTestScenario(
              msg.scenario as
                | 'permissions-strip'
                | 'permissions-tool-use-block'
                | 'permissions-tool-use-pending',
              targetAccountId,
            );
          } else {
            securityScanner.triggerTestScenario(msg.scenario, targetAccountId);
          }
          respond({ requestType: 'dev_trigger_security_event', success: true });
        } catch (err) {
          respond({
            requestType: 'dev_trigger_security_event',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'dev_trigger_alert_event': {
        // Synthesize a non-security alert (usage / overage / spend / account
        // lifecycle) through the same insertNotification + broadcast path the
        // real evaluators use. Safe to run repeatedly: does NOT mutate real
        // alert-row `last_triggered_reset_ts` or the SpendTracker paused set.
        const targetAccountId = msg.accountId ?? activeAccountId.value ?? 'default';
        const now = Date.now();
        try {
          switch (msg.scenario) {
            case 'usage-account': {
              ipcServer.broadcast({
                type: 'alert_triggered',
                alertId: -1,
                accountId: targetAccountId,
                scope: 'account',
                thresholdPct: 85,
                utilization: 0.85,
              });
              insertNotification(db, {
                ts: now,
                accountId: targetAccountId,
                type: 'usage_alert',
                title: 'Sentinel: 85% usage reached (synthetic)',
                body: `${targetAccountId} has used 85.0% of its 5-hour window. TEST SCENARIO — \`pnpm alerts:test usage-account\``,
              });
              break;
            }
            case 'usage-pool': {
              ipcServer.broadcast({
                type: 'alert_triggered',
                alertId: -2,
                accountId: null,
                scope: 'pool',
                thresholdPct: 75,
                utilization: 0.75,
              });
              insertNotification(db, {
                ts: now,
                accountId: null,
                type: 'usage_alert',
                title: 'Sentinel: pool at 75% (synthetic)',
                body: 'Round-robin pool has used 75.0% of its 5-hour window on average. TEST SCENARIO — `pnpm alerts:test usage-pool`',
              });
              break;
            }
            case 'usage-budget': {
              ipcServer.broadcast({
                type: 'alert_triggered',
                alertId: -3,
                accountId: targetAccountId,
                scope: 'budget',
                thresholdPct: 90,
                utilization: 0.9,
                spendUsd: 90,
                budgetUsd: 100,
                budgetScope: 'account',
              });
              insertNotification(db, {
                ts: now,
                accountId: targetAccountId,
                type: 'usage_alert',
                title: 'Sentinel: 90% of weekly budget (synthetic)',
                body: '$90.00 of $100.00 weekly budget used. TEST SCENARIO — `pnpm alerts:test usage-budget`',
              });
              break;
            }
            case 'overage-entered': {
              ipcServer.broadcast({
                type: 'overage_entered',
                accountId: targetAccountId,
                resetsAt: Math.floor(now / 1000) + 3600,
              });
              insertNotification(db, {
                ts: now,
                accountId: targetAccountId,
                type: 'overage_entered',
                title: `Overage started — ${targetAccountId} (synthetic)`,
                body: 'TEST SCENARIO — `pnpm alerts:test overage-entered`',
              });
              break;
            }
            case 'overage-disabled': {
              ipcServer.broadcast({
                type: 'overage_disabled',
                accountId: targetAccountId,
                reason: 'budget exhausted (synthetic)',
              });
              insertNotification(db, {
                ts: now,
                accountId: targetAccountId,
                type: 'overage_disabled',
                title: `Overage cap reached — ${targetAccountId} (synthetic)`,
                body: 'TEST SCENARIO — `pnpm alerts:test overage-disabled`',
              });
              break;
            }
            case 'account-switched': {
              // Live path broadcasts without writing a notification row —
              // the synthetic scenario inserts one so the event is visible
              // from the Alerts tab history (documented divergence).
              const synthetic: OAuthAccount = {
                accountUuid: targetAccountId,
                emailAddress: `${targetAccountId}@test.local`,
                organizationUuid: `${targetAccountId}-org`,
                hasExtraUsageEnabled: false,
                organizationRole: 'user',
                workspaceRole: null,
              } as OAuthAccount;
              ipcServer.broadcast({ type: 'account_switched', to: synthetic });
              insertNotification(db, {
                ts: now,
                accountId: targetAccountId,
                type: 'account_switched',
                title: `Switched to ${synthetic.emailAddress} (synthetic)`,
                body: 'TEST SCENARIO — `pnpm alerts:test account-switched`',
              });
              break;
            }
            case 'account-paused': {
              ipcServer.broadcast({
                type: 'account_paused',
                accountId: targetAccountId,
                reason: 'sentinel_budget',
                resetsAt: Math.floor(now / 1000) + 3600,
              });
              insertNotification(db, {
                ts: now,
                accountId: targetAccountId,
                type: 'usage_alert',
                title: `Account paused — ${targetAccountId} (synthetic)`,
                body: 'Weekly budget cap reached. TEST SCENARIO — `pnpm alerts:test account-paused`',
              });
              break;
            }
            case 'account-unpaused': {
              // Broadcast-only by design — mirrors the live path which fires
              // no notification row on unpause (the Alerts tab treats pause
              // clearance as a silent state transition).
              ipcServer.broadcast({
                type: 'account_unpaused',
                accountId: targetAccountId,
              });
              break;
            }
          }
          respond({ requestType: 'dev_trigger_alert_event', success: true });
        } catch (err) {
          respond({
            requestType: 'dev_trigger_alert_event',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'list_alerts': {
        const opts: { scope?: AlertScope; accountId?: string } = {};
        if (msg.scope && msg.scope !== 'all') opts.scope = msg.scope;
        if (msg.accountId) opts.accountId = msg.accountId;
        const rows = listAlerts(db, opts);
        respond({ requestType: 'list_alerts', success: true, data: rows });
        break;
      }

      case 'upsert_alert': {
        if (msg.thresholdPct < 1 || msg.thresholdPct > 99) {
          respond({
            requestType: 'upsert_alert',
            success: false,
            error: 'thresholdPct must be between 1 and 99',
          });
          break;
        }
        const scope = msg.scope ?? 'account';
        if ((scope === 'pool' || scope === 'pool-weekly') && msg.accountId != null) {
          respond({
            requestType: 'upsert_alert',
            success: false,
            error: `${scope} alerts must have accountId = null`,
          });
          break;
        }
        if (
          (scope === 'account' || scope === 'account-sonnet' || scope === 'account-weekly') &&
          !msg.accountId
        ) {
          respond({
            requestType: 'upsert_alert',
            success: false,
            error: `${scope} alerts require an accountId`,
          });
          break;
        }
        if (scope === 'budget') {
          const budgetScope = msg.budgetScope ?? 'account';
          if (budgetScope === 'account' && !msg.accountId) {
            respond({
              requestType: 'upsert_alert',
              success: false,
              error: 'budget account alerts require an accountId',
            });
            break;
          }
          if (budgetScope === 'global' && msg.accountId != null) {
            respond({
              requestType: 'upsert_alert',
              success: false,
              error: 'budget global alerts must have accountId = null',
            });
            break;
          }
        }
        const isNew = msg.id === undefined;
        const saved = upsertAlert(db, {
          ...(msg.id !== undefined ? { id: msg.id } : {}),
          scope,
          accountId: msg.accountId,
          thresholdPct: msg.thresholdPct,
          enabled: msg.enabled,
          ...(scope === 'budget' ? { budgetScope: msg.budgetScope ?? 'account' } : {}),
        });
        if (isNew) primeNewAlertAgainstCurrentWindow(db, rateLimitStore, saved, getSettings);
        respond({ requestType: 'upsert_alert', success: true, data: saved });
        break;
      }

      case 'delete_alert': {
        const removed = deleteAlert(db, msg.id);
        respond({ requestType: 'delete_alert', success: removed });
        break;
      }

      case 'list_permission_rules': {
        respond({
          requestType: 'list_permission_rules',
          success: true,
          data: permissionsEnforcer.listRules(),
        });
        break;
      }

      case 'get_permissions_status': {
        respond({
          requestType: 'get_permissions_status',
          success: true,
          data: permissionsEnforcer.getAutoModeStatus(),
        });
        break;
      }

      case 'upsert_permission_rule': {
        const input = msg.rule;
        if (input.decision !== 'allow' && input.decision !== 'deny' && input.decision !== 'ask') {
          respond({
            requestType: 'upsert_permission_rule',
            success: false,
            error: 'decision must be "allow", "deny", or "ask"',
          });
          break;
        }
        // Validate that the supplied raw parses to the same tool/pattern
        // pair we're about to store. Keeps bad inputs out of the DB even
        // if a UI sends inconsistent form+raw fields.
        const parsed = parsePermissionRule(input.raw);
        if (!parsed.ok) {
          respond({
            requestType: 'upsert_permission_rule',
            success: false,
            error: `invalid rule syntax: ${parsed.error}`,
          });
          break;
        }
        const saved = upsertPermissionRule(db, {
          ...input,
          tool: parsed.parsed.tool,
          pattern: parsed.parsed.pattern,
          raw: parsed.parsed.raw,
        });
        permissionsEnforcer.invalidate();
        const rules = permissionsEnforcer.listRules();
        ipcServer.broadcast({ type: 'permission_rules_changed', rules });
        // Mirror the new state out to Claude Code's settings.json if
        // sync is live. Fire-and-forget — the engine debounces and
        // handles errors by broadcasting a `claude_sync_status` with
        // lastError set, so the UI surfaces failures without blocking
        // the IPC response here.
        if (currentSettings.claudeCodeSyncEnabled) {
          void claudeSyncEngine.pushNow();
        }
        respond({ requestType: 'upsert_permission_rule', success: true, data: saved });
        break;
      }

      case 'delete_permission_rule': {
        const removed = deletePermissionRule(db, msg.id);
        if (removed) {
          permissionsEnforcer.invalidate();
          const rules = permissionsEnforcer.listRules();
          ipcServer.broadcast({ type: 'permission_rules_changed', rules });
          if (currentSettings.claudeCodeSyncEnabled) {
            void claudeSyncEngine.pushNow();
          }
        }
        respond({ requestType: 'delete_permission_rule', success: removed });
        break;
      }

      case 'refresh_token': {
        const acct = listAccounts(db).find((a) => a.id === msg.accountId);
        if (!acct) {
          respond({ requestType: 'refresh_token', success: false, error: 'Unknown account' });
          break;
        }
        refreshIfNeeded(
          { db, activeToken, activeAccountId, ipcServer, tokenRotator },
          msg.accountId,
          acct.email,
          true,
        )
          .then((result) => {
            if (result.success) {
              respond({
                requestType: 'refresh_token',
                success: true,
                data: { expiresAt: result.expiresAt ?? 0 },
              });
            } else {
              respond({
                requestType: 'refresh_token',
                success: false,
                error: result.error ?? 'Refresh failed',
              });
            }
          })
          .catch((err: unknown) => {
            respond({
              requestType: 'refresh_token',
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        break;
      }

      case 'cancel_login': {
        if (loginAbortController) {
          loginAbortController.abort();
          loginAbortController = null;
          console.log('[OAuth] Login cancelled by user.');
        }
        respond({ requestType: 'cancel_login', success: true });
        break;
      }

      case 'start_login': {
        // If a login is already pending, abort it silently before starting a new
        // one. This happens when the user clicks Cancel in the UI (which only
        // resets UI state) and then clicks Add Account again.
        if (loginAbortController) {
          loginAbortController.abort();
          loginAbortController = null;
          console.log('[OAuth] Aborting previous pending login to start a new one.');
        }

        const abortController = new AbortController();
        loginAbortController = abortController;

        // Respond immediately — the login is async and we broadcast when done
        respond({ requestType: 'start_login', success: true });

        // E2E seam: when SENTINEL_TEST_OAUTH_ECHO is set, intercept
        // the authorize URL and broadcast it so the Playwright harness can
        // extract the PKCE state and POST a synthetic callback to the
        // loopback callback server. Off by default — production falls
        // through to the platform browser launcher inside oauth.ts.
        /* v8 ignore next 5 */
        const testOauthEcho =
          process.env.SENTINEL_TEST_OAUTH_ECHO === '1'
            ? (url: string): void => {
                ipcServer.broadcast({ type: 'test_oauth_url_opened', url });
              }
            : undefined;

        startOAuthLogin({
          signal: abortController.signal,
          ...(msg.orgUuidHint ? { orgUuidHint: msg.orgUuidHint } : {}),
          // When the UI requests incognito, open the OAuth URL in a
          // private-mode browser window. Used for Add Account when the
          // user is enrolling a different email/identity than any
          // existing Sentinel account — claude.ai's "switch accounts"
          // link on the OAuth consent page drops OAuth state in a
          // default browser that already has a live sessionKey. A
          // fresh cookie jar lets the user complete the flow cleanly.
          ...(msg.incognito ? { incognito: true } : {}),
          ...(testOauthEcho ? { openAuthUrl: testOauthEcho } : {}),
        })
          .then((result) => {
            loginAbortController = null;
            persistOAuthResult(result);
          })
          .catch((err: unknown) => {
            loginAbortController = null;
            const errMsg = err instanceof Error ? err.message : String(err);
            // Don't broadcast a failure when the login was intentionally aborted
            // (user clicked Cancel or started a new login — the UI already knows).
            if (errMsg === OAUTH_ABORTED) {
              console.log('[OAuth] Login aborted — suppressing failure broadcast.');
              return;
            }
            console.error('[OAuth] Login failed:', errMsg);
            console.log(
              `[OAuth] Broadcasting login_complete(failure) to ${ipcServer.connectedClients} client(s)`,
            );
            ipcServer.broadcast({ type: 'login_complete', email: '' });
          });
        break;
      }

      // ─── Optimize feature ─────────────────────────────────────────
      case 'list_installed_subagents': {
        const rows = listSubagentInstalls(db);
        respond({ requestType: 'list_installed_subagents', success: true, data: rows });
        break;
      }
      case 'get_curated_library': {
        const lib = getCuratedLibrary().map((s) => ({
          curatedId: s.curatedId,
          name: s.gap.name,
          description: s.gap.description,
          model: s.gap.model,
          tools: s.gap.tools,
          fingerprint: s.fingerprint,
        }));
        respond({ requestType: 'get_curated_library', success: true, data: lib });
        break;
      }
      case 'install_curated_subagent': {
        const entry = getCuratedSubagent(msg.curatedId);
        if (!entry) {
          respond({
            requestType: 'install_curated_subagent',
            success: false,
            error: `unknown curated id: ${msg.curatedId}`,
          });
          break;
        }
        const agentsDir =
          process.env['SENTINEL_TEST_AGENTS_DIR'] ?? join(homedir(), '.claude', 'agents');
        const mdPath = join(agentsDir, `${entry.curatedId}.md`);
        agentsSyncEngine
          .installCuratedFile({
            name: entry.curatedId,
            mdPath,
            renderedMd: entry.renderedMd,
            curatedId: entry.curatedId,
            gapFingerprint: entry.fingerprint,
          })
          .then(() => {
            insertOptimizationEvent(db, {
              ts: Date.now(),
              accountId: activeAccountId.value ?? '',
              sessionId: null,
              curatedId: entry.curatedId,
              kind: 'installed',
              pattern: null,
              savingsUsd: null,
              actualInputTokens: null,
              actualCachedTokens: null,
              actualCostUsd: null,
              hypotheticalCostUsd: null,
              hypotheticalTotalTokens: null,
              sourceToolCallIds: [],
            });
            ipcServer.broadcast({
              type: 'subagent_installed',
              name: entry.curatedId,
              curatedId: entry.curatedId,
            });
            respond({
              requestType: 'install_curated_subagent',
              success: true,
              data: { name: entry.curatedId, mdPath },
            });
          })
          /* v8 ignore next 7 */
          .catch((err: unknown) => {
            respond({
              requestType: 'install_curated_subagent',
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        break;
      }
      case 'uninstall_subagent': {
        agentsSyncEngine
          .uninstallByName(msg.name)
          .then(() => {
            ipcServer.broadcast({ type: 'subagent_uninstalled', name: msg.name });
            respond({ requestType: 'uninstall_subagent', success: true, data: { name: msg.name } });
          })
          /* v8 ignore next 7 */
          .catch((err: unknown) => {
            respond({
              requestType: 'uninstall_subagent',
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        break;
      }
      case 'get_agents_sync_status': {
        respond({
          requestType: 'get_agents_sync_status',
          success: true,
          data: agentsSyncEngine.getStatus(),
        });
        break;
      }
      case 'get_optimization_opportunities': {
        // M3 fills this in from the analyzer. For M2, return an empty
        // list so the UI scaffolding can be wired before the analyzer
        // ships.
        respond({
          requestType: 'get_optimization_opportunities',
          success: true,
          data: [],
        });
        break;
      }
      case 'get_optimization_metrics': {
        // `window` (preferred) selects the range; `days` is the legacy
        // lookback honored only when `window` is absent (0 = all-time).
        respond({
          requestType: 'get_optimization_metrics',
          success: true,
          data: getOptimizationMetrics(db, windowFromMessage(msg.window, msg.days)),
        });
        break;
      }
      case 'get_compression_metrics': {
        // Compression stats live in their own store; cache health is a
        // cross-check from the main telemetry DB (cache_ttl_events) over the
        // same window and the full known-account set.
        const win = windowFromMessage(msg.window, msg.days);
        const metrics = compressionStore.getCompressionMetricsWindow(win);
        const accountIds = listAccounts(db).map((a) => a.id);
        metrics.cacheHealth = getCacheHealthWindowRange(db, accountIds, win);
        respond({
          requestType: 'get_compression_metrics',
          success: true,
          data: metrics,
        });
        break;
      }
      case 'get_processed_tokens': {
        // Total tokens Sentinel forwarded over the window, across all accounts
        // — the denominator for the Optimize header's savings percentage.
        respond({
          requestType: 'get_processed_tokens',
          success: true,
          data: getProcessedTokenTotals(db, windowFromMessage(msg.window)),
        });
        break;
      }
      case 'get_proxy_activity': {
        // Idle gate for silent auto-updates: the Tauri updater refuses to
        // restart the app (and therefore the proxy) while a Claude Code
        // session is in flight or was active moments ago.
        respond({
          requestType: 'get_proxy_activity',
          success: true,
          data: getProxyActivity(),
        });
        break;
      }
      case 'install_retrieval_mcp': {
        const directory = msg.directory ?? null;
        if (msg.scope !== 'user' && (directory === null || directory.length === 0)) {
          respond({
            requestType: 'install_retrieval_mcp',
            success: false,
            error: 'A directory is required for local/project scope.',
          });
          break;
        }
        try {
          const { configPath } = installMcpServer({
            scope: msg.scope,
            directory,
            port: getDaemonPort(),
            token: getOrCreateMcpToken(),
          });
          // Record the install (dedup by scope+directory) and enable reversible
          // compression so the compressor starts emitting retrieval markers.
          const recordDir = msg.scope === 'user' ? null : directory;
          const installs = currentSettings.compressionRetrievalInstalls.filter(
            (i) => !(i.scope === msg.scope && i.directory === recordDir),
          );
          installs.push({ scope: msg.scope, directory: recordDir, installedAt: Date.now() });
          currentSettings = writeSettings({
            compressionRetrievalEnabled: true,
            compressionRetrievalInstalls: installs,
          });
          ipcServer.broadcast({ type: 'settings_changed', settings: currentSettings });
          respond({
            requestType: 'install_retrieval_mcp',
            success: true,
            data: {
              configPath,
              toolName: RETRIEVE_QUALIFIED_NAME,
              restartRequired: true,
            },
          });
        } catch (err) {
          respond({
            requestType: 'install_retrieval_mcp',
            success: false,
            error: err instanceof Error ? err.message : 'install failed',
          });
        }
        break;
      }
      case 'uninstall_retrieval_mcp': {
        const directory = msg.directory ?? null;
        try {
          uninstallMcpServer({ scope: msg.scope, directory });
          const recordDir = msg.scope === 'user' ? null : directory;
          const installs = currentSettings.compressionRetrievalInstalls.filter(
            (i) => !(i.scope === msg.scope && i.directory === recordDir),
          );
          currentSettings = writeSettings({ compressionRetrievalInstalls: installs });
          ipcServer.broadcast({ type: 'settings_changed', settings: currentSettings });
          respond({ requestType: 'uninstall_retrieval_mcp', success: true });
        } catch (err) {
          respond({
            requestType: 'uninstall_retrieval_mcp',
            success: false,
            error: err instanceof Error ? err.message : 'uninstall failed',
          });
        }
        break;
      }
      case 'get_retrieval_mcp_status': {
        // Verify each recorded install is still present in its config file, so
        // the UI reflects reality after external edits.
        const installs = currentSettings.compressionRetrievalInstalls.filter((i) =>
          isMcpInstalled({ scope: i.scope, directory: i.directory }),
        );
        respond({
          requestType: 'get_retrieval_mcp_status',
          success: true,
          data: {
            enabled: currentSettings.compressionRetrievalEnabled,
            toolName: RETRIEVE_QUALIFIED_NAME,
            url: buildMcpServerEntry(getDaemonPort(), '').url,
            installs,
          },
        });
        break;
      }
      case 'run_optimization_analysis': {
        const written = optimizationAnalyzer.runOnce();
        respond({
          requestType: 'run_optimization_analysis',
          success: true,
          data: { written },
        });
        break;
      }
      case 'dismiss_optimization': {
        insertOptimizationEvent(db, {
          ts: Date.now(),
          accountId: activeAccountId.value ?? '',
          sessionId: null,
          curatedId: msg.curatedId,
          kind: 'dismissed',
          pattern: msg.pattern,
          savingsUsd: null,
          actualInputTokens: null,
          actualCachedTokens: null,
          actualCostUsd: null,
          hypotheticalCostUsd: null,
          hypotheticalTotalTokens: null,
          sourceToolCallIds: [],
        });
        respond({ requestType: 'dismiss_optimization', success: true, data: {} });
        break;
      }
      case 'list_optimization_events': {
        // Drill-down query: surfaces individual measured / dismissed
        // opportunities with their source tool_calls so the dashboard
        // can answer "what triggered this savings number?"
        // exactOptionalPropertyTypes requires us to elide undefined
        // keys rather than pass `undefined` through.
        const opts: Parameters<typeof listOptimizationEventsWithSources>[1] = {};
        if (msg.kind !== undefined) opts.kind = msg.kind;
        if (msg.curatedId !== undefined) opts.curatedId = msg.curatedId;
        if (msg.realized !== undefined) opts.realized = msg.realized;
        if (msg.regressionsOnly !== undefined) opts.regressionsOnly = msg.regressionsOnly;
        if (msg.positiveSavingsOnly !== undefined)
          opts.positiveSavingsOnly = msg.positiveSavingsOnly;
        if (msg.search !== undefined) opts.search = msg.search;
        if (msg.window !== undefined) opts.window = msg.window;
        if (msg.limit !== undefined) opts.limit = msg.limit;
        if (msg.offset !== undefined) opts.offset = msg.offset;
        const result = listOptimizationEventsWithSources(db, opts);
        respond({
          requestType: 'list_optimization_events',
          success: true,
          data: result,
        });
        break;
      }
      case 'get_context_inventory': {
        // Snapshot every surface contributing to Claude Code's request
        // context. Read-only — disable controls are deferred to a
        // follow-up that handles project-vs-global scope explicitly.
        respond({
          requestType: 'get_context_inventory',
          success: true,
          data: buildContextInventory(db),
        });
        break;
      }
      case 'get_mcp_context_costs': {
        // Per-server MCP insight: config presence + measured tools[]
        // definition cost + 7d usage, with recommendation badges and
        // bridge status. Powers the Context tab's cost table.
        respond({
          requestType: 'get_mcp_context_costs',
          success: true,
          data: buildMcpContextInsights({
            db,
            contextStore: contextCostStore,
            migrations: currentSettings.codeModeMigrations,
            disabledStashes: currentSettings.mcpDisabledStashes,
            unavailableServers: codeModeUnavailable,
            window: windowFromMessage(msg.window),
          }),
        });
        break;
      }
      case 'disable_mcp_server': {
        // Plain disable (no bridging): remove the entry, stash it for
        // Enable. Stash list is separate from migrations on purpose — a
        // disabled server must never join the bridge allowlist.
        const directory = msg.scope === 'user' ? null : (msg.directory ?? null);
        if (msg.scope !== 'user' && (directory === null || directory.length === 0)) {
          respond({
            requestType: 'disable_mcp_server',
            success: false,
            error: 'A directory is required for local/project scope.',
          });
          break;
        }
        try {
          const ref = { server: msg.server, scope: msg.scope, directory };
          const { originalEntry } = disableNativeServer(ref);
          const stashes = [
            ...currentSettings.mcpDisabledStashes.filter(
              (s) =>
                !(s.server === msg.server && s.scope === msg.scope && s.directory === directory),
            ),
            { ...ref, originalEntry, migratedAt: Date.now() },
          ];
          currentSettings = writeSettings({ mcpDisabledStashes: stashes });
          ipcServer.broadcast({ type: 'settings_changed', settings: currentSettings });
          ipcServer.broadcast({ type: 'mcp_context_costs_updated' });
          respond({
            requestType: 'disable_mcp_server',
            success: true,
            data: { restartRequired: true },
          });
        } catch (err) {
          respond({
            requestType: 'disable_mcp_server',
            success: false,
            error: err instanceof Error ? err.message : 'disable failed',
          });
        }
        break;
      }
      case 'enable_mcp_server': {
        const directory = msg.scope === 'user' ? null : (msg.directory ?? null);
        const stash = currentSettings.mcpDisabledStashes.find(
          (s) => s.server === msg.server && s.scope === msg.scope && s.directory === directory,
        );
        if (!stash) {
          respond({
            requestType: 'enable_mcp_server',
            success: false,
            error: `No stashed entry for '${msg.server}' at ${msg.scope} scope; re-add it in Claude Code instead.`,
          });
          break;
        }
        try {
          restoreNativeServer({ ...stash, originalEntry: stash.originalEntry });
          currentSettings = writeSettings({
            mcpDisabledStashes: currentSettings.mcpDisabledStashes.filter((s) => s !== stash),
          });
          ipcServer.broadcast({ type: 'settings_changed', settings: currentSettings });
          ipcServer.broadcast({ type: 'mcp_context_costs_updated' });
          respond({
            requestType: 'enable_mcp_server',
            success: true,
            data: { restartRequired: true },
          });
        } catch (err) {
          respond({
            requestType: 'enable_mcp_server',
            success: false,
            error: err instanceof Error ? err.message : 'enable failed',
          });
        }
        break;
      }
      case 'migrate_server_to_code_mode': {
        // Safety ordering: verify we can bridge BEFORE touching the user's
        // config. A server we can't connect to is never disabled. Migration
        // acts on EVERY configured entry for the server (user scope + each
        // project's local scope): Claude Code resolves same-named servers
        // local-over-global, so disabling only one entry would leave the
        // others loading the definitions natively. Idempotent: entries
        // already recorded as migrated are skipped, so re-running bridges
        // entries added since.
        void (async () => {
          const recorded = new Set(
            currentSettings.codeModeMigrations
              .filter((m) => m.server === msg.server)
              .map((m) => `${m.scope}:${m.directory ?? ''}`),
          );
          const entries = findNativeServerEntries(msg.server).filter(
            (e) => !recorded.has(`${e.scope}:${e.directory ?? ''}`),
          );
          if (entries.length === 0) {
            respond({
              requestType: 'migrate_server_to_code_mode',
              success: false,
              error:
                recorded.size > 0
                  ? `Every configured entry for '${msg.server}' is already bridged.`
                  : `MCP server '${msg.server}' not found in ~/.claude.json or any known project's .mcp.json.`,
            });
            return;
          }
          codeModePendingEntries.set(msg.server, entries[0]!.entry);
          try {
            const verified = await codeModeManager.verify(msg.server);
            if (!verified.ok) {
              respond({
                requestType: 'migrate_server_to_code_mode',
                success: false,
                error: `Could not connect to '${msg.server}': ${verified.error}. The native server was left untouched.`,
              });
              return;
            }
            const workspaceDir = await generateServerWorkspace({
              server: msg.server,
              tools: verified.tools,
              port: getDaemonPort(),
            });
            await writeCodeModeTokenFile(getOrCreateCodeModeToken());
            const migratedAt = Date.now();
            // Snapshot the all-time request counts now so realized savings count
            // requests since *this* moment, not from the start of today's day
            // bucket (see realizedRequests in mcp-insights).
            const baselineAggs = contextCostStore.getServerDefinitionCosts({});
            const baselineNativeRequests =
              baselineAggs.find((a) => a.server === NATIVE_SERVER_KEY)?.requestCount ?? 0;
            const baselineServerRequests =
              baselineAggs.find((a) => a.server === sanitizeServerName(msg.server))?.requestCount ??
              0;
            const newRecords = entries.map((e) => {
              const { originalEntry } = disableNativeServer({
                server: msg.server,
                scope: e.scope,
                directory: e.directory,
              });
              return {
                server: msg.server,
                scope: e.scope,
                directory: e.directory,
                originalEntry,
                migratedAt,
                baselineNativeRequests,
                baselineServerRequests,
              };
            });
            const migrations = [...currentSettings.codeModeMigrations, ...newRecords];
            await installCodeModeSkill({
              servers: [...new Set(migrations.map((m) => m.server))],
              port: getDaemonPort(),
            });
            currentSettings = writeSettings({
              codeModeMigrations: migrations,
              codeModeEnabled: true,
              codeModeSkillInstalled: true,
            });
            ipcServer.broadcast({ type: 'settings_changed', settings: currentSettings });
            ipcServer.broadcast({ type: 'code_mode_status' });
            ipcServer.broadcast({ type: 'mcp_context_costs_updated' });
            respond({
              requestType: 'migrate_server_to_code_mode',
              success: true,
              data: {
                restartRequired: true,
                workspaceDir,
                toolCount: verified.tools.length,
                entriesDisabled: newRecords.length,
              },
            });
          } finally {
            codeModePendingEntries.delete(msg.server);
          }
        })().catch((err: unknown) => {
          respond({
            requestType: 'migrate_server_to_code_mode',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      }
      case 'revert_server_from_code_mode': {
        // Restores EVERY stashed entry for the server: one migration may
        // span the user scope plus several projects' local scopes.
        const mine = currentSettings.codeModeMigrations.filter((m) => m.server === msg.server);
        if (mine.length === 0) {
          respond({
            requestType: 'revert_server_from_code_mode',
            success: false,
            error: `No recorded code-mode migration for '${msg.server}'.`,
          });
          break;
        }
        void (async () => {
          for (const migration of mine) {
            restoreNativeServer({ ...migration, originalEntry: migration.originalEntry });
          }
          const remaining = currentSettings.codeModeMigrations.filter(
            (m) => m.server !== msg.server,
          );
          await removeServerWorkspace(msg.server);
          if (remaining.length > 0) {
            await installCodeModeSkill({
              servers: [...new Set(remaining.map((m) => m.server))],
              port: getDaemonPort(),
            });
          } else {
            await uninstallCodeModeSkill();
          }
          currentSettings = writeSettings({
            codeModeMigrations: remaining,
            codeModeEnabled: remaining.length > 0,
            codeModeSkillInstalled: remaining.length > 0,
          });
          codeModeUnavailable.delete(sanitizeServerName(msg.server));
          ipcServer.broadcast({ type: 'settings_changed', settings: currentSettings });
          ipcServer.broadcast({ type: 'code_mode_status' });
          ipcServer.broadcast({ type: 'mcp_context_costs_updated' });
          respond({
            requestType: 'revert_server_from_code_mode',
            success: true,
            data: { restartRequired: true },
          });
        })().catch((err: unknown) => {
          respond({
            requestType: 'revert_server_from_code_mode',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      }
      case 'get_code_mode_status': {
        // `drifted` flags a migration whose native entry has been hand-
        // restored in the config file (the disable is no longer in effect),
        // mirroring get_retrieval_mcp_status's verify-against-reality.
        const migrations = currentSettings.codeModeMigrations.map((m) => ({
          ...m,
          drifted: !isNativeDisabled(m),
        }));
        respond({
          requestType: 'get_code_mode_status',
          success: true,
          data: {
            enabled: currentSettings.codeModeEnabled,
            skillInstalled: currentSettings.codeModeSkillInstalled,
            migrations,
            endpointUrl: `http://127.0.0.1:${getDaemonPort()}/code-mode/call`,
            workspaceDir: resolveCodeModeDir(),
          },
        });
        break;
      }
      case 'get_code_mode_audit': {
        respond({
          requestType: 'get_code_mode_audit',
          success: true,
          data: contextCostStore.getAudit(windowFromMessage(msg.window), msg.limit ?? 50),
        });
        break;
      }
    }
  });

  // Evaluate user-created per-account alerts on every rate-limit update.
  // `getSettings` enables the round-robin exclusion guard inside the
  // per-account + Sonnet evaluators: rate-limit headers can still arrive for
  // excluded accounts (via background probes that run immediately post-reset,
  // or via claude.ai usage-store sync) and without this guard the evaluator
  // would fire alerts for accounts the user has explicitly taken out of
  // rotation — noisy and misleading.
  const alertEvaluatorDeps = {
    db,
    rateLimitStore,
    ipcServer,
    getSettings,
    getEmailForAccount: (accountId: string): string | null => {
      const acct = listAccounts(db).find((a) => a.id === accountId);
      return acct?.email ?? null;
    },
  };
  startAlertEvaluator(alertEvaluatorDeps);

  // Evaluate user-created `account-sonnet`-scoped alerts on every
  // rate-limit update. Reads the unified-7d_sonnet window rather than
  // unified-5h; re-fire gated per Sonnet window reset.
  startSonnetAlertEvaluator(alertEvaluatorDeps);

  // Evaluate user-created `account-weekly`-scoped alerts. Reads the general
  // unified-7d window (non-Sonnet weekly cap); an account can saturate its
  // Sonnet 7-day quota while the general 7-day window is fresh, and vice
  // versa, so this is deliberately a separate evaluator/scope.
  startWeeklyAlertEvaluator(alertEvaluatorDeps);

  // Pool-wide alerts (round-robin only). No-ops outside round-robin mode.
  // Also called eagerly from the update_settings handler when the user
  // changes pool membership or switches into round-robin, so the new pool's
  // utilization is checked without waiting for the next rate-limit update.
  const poolAlertDeps = { ...alertEvaluatorDeps, getSettings };
  startPoolAlertEvaluator(poolAlertDeps);
  // Pool-weekly alerts — same gating as pool, but mean is over unified-7d.
  startWeeklyPoolAlertEvaluator(poolAlertDeps);

  // Sonnet saturation transitions — fire native notifications + persist a
  // timeline entry when an account's unified-7d_sonnet utilization crosses
  // the overage-buffer threshold (default 95%). Uses the same overageOsNotify
  // toggle as the regular overage transitions: the user's mental model is
  // "a spillover just became likely" in both cases, so a single mute switch
  // is sufficient.
  sonnetMachine.onTransition((event) => {
    const { accountId, transition, utilization, resetsAt } = event;
    if (transition === 'entered') {
      const acct = listAccounts(db).find((a) => a.id === accountId);
      const who = acct?.email ?? accountId;
      const optedIn = currentSettings.overageEnabledIds.includes(accountId);
      insertNotification(db, {
        ts: Date.now(),
        accountId,
        type: 'overage_entered',
        title: 'Sentinel: Sonnet 7-day saturated',
        body: buildSonnetSaturationBody(who, utilization, optedIn),
      });
      ipcServer.broadcast({
        type: 'sonnet_saturation_entered',
        accountId,
        resetsAt,
        utilization,
      });
    } else {
      ipcServer.broadcast({ type: 'sonnet_saturation_exited', accountId });
    }
  });

  // Feed rate-limit updates into the Sonnet machine. Uses the live
  // overageBufferPct so the threshold stays in lockstep with the rotator
  // and proxy short-circuit.
  rateLimitStore.onUpdate((accountId) => {
    const sonnetWindow = rateLimitStore
      .getAll(accountId)
      .find((w) => w.name === 'unified-7d_sonnet');
    if (!sonnetWindow) return;
    const clampedBuffer = Math.max(0, Math.min(50, currentSettings.overageBufferPct ?? 5));
    const thresholdPct = 100 - clampedBuffer;
    sonnetMachine.update(
      accountId,
      sonnetWindow.utilization ?? null,
      sonnetWindow.reset ?? null,
      thresholdPct,
    );
  });

  // Purge stale security events per the retention window. Sprint 8
  // upgrades this from a one-shot to a 24h timer to match telemetry
  // retention's cadence, and the underlying purge now writes summary
  // bridge rows so the audit log chain stays internally consistent
  // across the gap. Without that, walkChain would flag a chain break
  // every time retention deleted a row.
  const runSecurityEventPurge = (): void => {
    try {
      const cutoff = Date.now() - currentSettings.securityEventRetentionDays * 24 * 60 * 60 * 1000;
      const purged = purgeSecurityEventsOlderThan(db, cutoff);
      if (purged > 0) {
        console.log(
          `[Security] Purged ${purged} security event(s) older than ${currentSettings.securityEventRetentionDays} days`,
        );
      }
      /* v8 ignore next 3 */
    } catch (err) {
      console.error('[Security] retention purge failed:', err);
    }
  };
  runSecurityEventPurge();
  const securityEventPurgeTimer = setInterval(runSecurityEventPurge, 24 * 60 * 60 * 1000);

  // Sprint 8 audit log integrity: walk the chain at startup and once
  // per 24h. A break means either retention got out of sync (bug) or
  // someone tampered directly with the SQLite file out of band. Either
  // way the user needs to know — broadcast `audit_log_tampered` so the
  // UI can render a banner.
  const runChainIntegrityCheck = (): void => {
    try {
      const result = walkChain(db);
      if (result.ok) {
        console.log(
          `[Security] audit chain OK (${result.eventCount} event(s), ${result.summaryCount} bridge row(s), tip=${result.tipPayloadHash.slice(0, 12)}…)`,
        );
        return;
      }
      console.error(
        `[Security] audit chain BROKEN at row id=${result.brokenAtRowId}: ${result.reason}`,
      );
      ipcServer.broadcast({
        type: 'audit_log_tampered',
        brokenAtRowId: result.brokenAtRowId,
        reason: result.reason,
      });
      /* v8 ignore next 3 */
    } catch (err) {
      console.error('[Security] chain integrity check failed:', err);
    }
  };
  runChainIntegrityCheck();
  const chainIntegrityTimer = setInterval(runChainIntegrityCheck, 24 * 60 * 60 * 1000);

  // Purge stale OTEL telemetry (usage_events, tool_events, api_errors,
  // activity_events) per the Metrics page's retention window. Runs once at
  // startup and re-runs every 24h so an always-on daemon doesn't accumulate
  // data indefinitely.
  const runTelemetryPurge = (): void => {
    try {
      const cutoff = Date.now() - currentSettings.metricsRetentionDays * 24 * 60 * 60 * 1000;
      const purged = purgeTelemetryOlderThan(db, cutoff);
      if (purged > 0) {
        console.log(
          `[Telemetry] Purged ${purged} row(s) older than ${currentSettings.metricsRetentionDays} days`,
        );
      }
      /* v8 ignore next 3 */
    } catch (err) {
      console.error('[Telemetry] retention purge failed:', err);
    }
  };
  runTelemetryPurge();
  const telemetryPurgeTimer = setInterval(runTelemetryPurge, 24 * 60 * 60 * 1000);

  // Optimize analyzer rows (optimization_events) follow the Optimize page's
  // retention window; runs at startup + every 24h like telemetry.
  const runOptimizationPurge = (): void => {
    try {
      const cutoff = Date.now() - currentSettings.optimizeRetentionDays * 24 * 60 * 60 * 1000;
      const purged = purgeOptimizationOlderThan(db, cutoff);
      if (purged > 0) {
        console.log(
          `[Optimize] Purged ${purged} optimization row(s) older than ${currentSettings.optimizeRetentionDays} days`,
        );
      }
      /* v8 ignore next 3 */
    } catch (err) {
      console.error('[Optimize] retention purge failed:', err);
    }
  };
  runOptimizationPurge();
  const optimizationPurgeTimer = setInterval(runOptimizationPurge, 24 * 60 * 60 * 1000);

  // Request/response capture store — opened up-front so the Logs UI can
  // always call get_request_detail / clear_request_logs even when capture
  // is disabled (table just stays empty). Purge respects the user's
  // configured retention window; runs at startup + every 24h like telemetry.
  const requestLogStore = getRequestLogStore();
  const runRequestLogPurge = (): void => {
    try {
      const cutoff = Date.now() - currentSettings.requestLogRetentionDays * 24 * 60 * 60 * 1000;
      const purged = requestLogStore.purgeOlderThan(cutoff);
      if (purged > 0) {
        console.log(
          `[RequestLog] Purged ${purged} row(s) older than ${currentSettings.requestLogRetentionDays} days`,
        );
      }
      /* v8 ignore next 3 */
    } catch (err) {
      console.error('[RequestLog] retention purge failed:', err);
    }
  };
  runRequestLogPurge();
  const requestLogPurgeTimer = setInterval(runRequestLogPurge, 24 * 60 * 60 * 1000);

  // Compression stats store — opened up-front so the Optimize page can always
  // fetch get_compression_metrics even when compression is disabled (table
  // just stays empty). Per-request rows follow the Optimize page's retention
  // window; purge runs at startup + every 24h like telemetry/request-logs.
  const compressionStore = getCompressionStatsStore({ ipcServer });
  // Reversible-compression retrieval MCP endpoint, served on the daemon's
  // HTTP server at `/mcp`. Reads originals from the compression store; gated
  // by a per-installation bearer token written into the MCP config.
  const mcpHandler = createRetrieveMcpHandler({
    getRetrieval: (id) => compressionStore.getRetrieval(id),
    getToken: () => getOrCreateMcpToken(),
  });
  const runCompressionPurge = (): void => {
    try {
      const cutoff = Date.now() - currentSettings.optimizeRetentionDays * 24 * 60 * 60 * 1000;
      const purged = compressionStore.purgeOlderThan(cutoff);
      if (purged > 0) {
        console.log(
          `[Compression] Purged ${purged} row(s) older than ${currentSettings.optimizeRetentionDays} days`,
        );
      }
      /* v8 ignore next 3 */
    } catch (err) {
      console.error('[Compression] retention purge failed:', err);
    }
  };
  runCompressionPurge();
  const compressionPurgeTimer = setInterval(runCompressionPurge, 24 * 60 * 60 * 1000);

  // Context-cost store — measured MCP tool-definition costs (the Optimize
  // page's Context tab) plus the code-mode call audit. Opened up-front like
  // the compression store so get_mcp_context_costs always answers; purge
  // reuses the same retention window and cadence.
  const contextCostStore = getContextCostStore({ ipcServer });
  // Backfill realized-savings baselines for any migration recorded before the
  // baseline fields existed, so legacy bridges count requests from upgrade time
  // instead of reporting the day-bucket inflated figure. One-time and idempotent.
  {
    const backfill = backfillMigrationBaselines(
      currentSettings.codeModeMigrations,
      contextCostStore,
    );
    if (backfill.changed) {
      currentSettings = writeSettings({ codeModeMigrations: backfill.migrations });
      console.log('[ContextCost] Backfilled code-mode savings baselines');
    }
  }
  // Bridged servers the code-mode client manager failed to connect to since
  // startup. Surfaced as bridgeStatus 'unavailable' on the Context tab so a
  // broken bridge is visible rather than silently dropping tool access.
  // Keyed by SANITIZED server name to match the insights join key.
  const codeModeUnavailable = new Set<string>();
  // Entries registered transiently by the migrate handler so verify() can
  // connect BEFORE the server is bridged (post-migration connects read the
  // stash in settings instead). Cleared in the handler's finally block.
  const codeModePendingEntries = new Map<string, unknown>();
  // Code-mode bridge: the daemon-side MCP client manager plus the
  // `/code-mode/call` HTTP handler the proxy routes to. The allowlist is the
  // recorded migrations — the endpoint can never reach a server the user
  // didn't explicitly bridge.
  const codeModeManager = createMcpClientManager({
    resolveEntry: (server) =>
      currentSettings.codeModeMigrations.find((m) => m.server === server)?.originalEntry ??
      codeModePendingEntries.get(server),
    isAllowed: (server) => currentSettings.codeModeMigrations.some((m) => m.server === server),
    onAvailability: (server, available) => {
      const key = sanitizeServerName(server);
      if (available) codeModeUnavailable.delete(key);
      else codeModeUnavailable.add(key);
    },
  });
  const codeModeHandler = createCodeModeHandler({
    manager: codeModeManager,
    getToken: () => getOrCreateCodeModeToken(),
    isEnabled: () => currentSettings.codeModeEnabled,
    recordCall: (row) => contextCostStore.recordCall(row),
  });
  const runContextCostPurge = (): void => {
    try {
      const cutoff = Date.now() - currentSettings.optimizeRetentionDays * 24 * 60 * 60 * 1000;
      const purged = contextCostStore.purgeOlderThan(cutoff);
      if (purged > 0) {
        console.log(
          `[ContextCost] Purged ${purged} row(s) older than ${currentSettings.optimizeRetentionDays} days`,
        );
      }
      /* v8 ignore next 3 */
    } catch (err) {
      console.error('[ContextCost] retention purge failed:', err);
    }
  };
  runContextCostPurge();
  const contextCostPurgeTimer = setInterval(runContextCostPurge, 24 * 60 * 60 * 1000);

  // Sprint 8 forensic incident replay recorder. Built once and shared
  // with both scanner + enforcer so the same in-memory ring buffer is
  // captured regardless of which subsystem fires the security event.
  // The recorder's redact function is the secret-detector pipeline so
  // any secrets in tool-use messages are masked at push time, not at
  // capture time — a buffer leak via memory dump reveals only the
  // masked form.
  const incidentReplay = createIncidentReplayRecorder({
    db,
    redact: redactSecretsInString,
  });

  // Build the security scanner. Settings getter is passed as a thunk so the
  // scanner re-reads toggles and enforcement-mode on every request without
  // needing a restart.
  const securityScanner = createSecurityScanner({
    db,
    ipcServer,
    getSettings: () => currentSettings,
    incidentReplay,
  });

  // Build the permission enforcer. Compiled rule cache is invalidated on
  // every IPC rule mutation; all settings are pulled via the thunk.
  const permissionsEnforcer = createPermissionsEnforcer({
    db,
    ipcServer,
    getSettings: () => currentSettings,
    incidentReplay,
  });

  // Sprint 9 webhook emitter — passive subscriber on the broadcast
  // pipeline. Settings drive whether anything actually goes out;
  // an unset URL turns the emitter into a silent no-op.
  attachWebhookToIpc(ipcServer, { getSettings: () => currentSettings });

  // Claude Code auto-sync engine. Owns the file watcher lifecycle.
  // Started when `claudeCodeSyncEnabled` is on; stopped when toggled
  // off. A local rule mutation (upsert / delete) fires pushNow so
  // the file reflects the new state within the next tick.
  const claudeSyncEngine = createClaudeSyncEngine({
    db,
    ipcServer,
    invalidateRuleCache: () => permissionsEnforcer.invalidate(),
  });
  if (currentSettings.claudeCodeSyncEnabled) {
    void claudeSyncEngine.start().catch((err: unknown) => {
      console.error('[ClaudeSync] initial start failed:', err);
    });
  }

  // OTEL settings drift watcher. Tracks the eight env vars Sentinel
  // manages in ~/.claude/settings.json and surfaces the drift state
  // through `otel_drift_state` broadcasts. Constructed here so the IPC
  // handlers can capture it in their closure; started just before the
  // IPC server accepts connections to keep daemon startup deterministic.
  const claudeSettingsPath =
    process.env.SENTINEL_TEST_CLAUDE_SETTINGS_FILE ??
    join(homedir(), '.claude', 'settings.json');
  const otelSettingsWatcher = createOtelSettingsWatcher({
    settingsPath: claudeSettingsPath,
    ipcServer,
    getSentinelExporterEndpoint: () => currentSettings.otelExporterEndpoint,
  });

  // Optimize feature: agents-sync engine. Always started — capture
  // can be off (no new tool_calls accumulate), but if the user has
  // installed curated subagents in the past, we still want the sync
  // engine alive to detect orphans, hand-edits, and to support
  // uninstall. The engine is lightweight when AGENTS_DIR is empty.
  const agentsSyncEngine = createAgentsSyncEngine({ db, ipcServer });
  const agentsSyncStartedAt = Date.now();
  try {
    await agentsSyncEngine.start();
    console.log(`[Startup] agents-sync engine started (${Date.now() - agentsSyncStartedAt}ms)`);
  } catch (err) {
    /* v8 ignore next 2 */
    console.error('[AgentsSync] initial start failed:', err);
  }

  // Optimize feature: periodic analyzer. Runs every 5 minutes,
  // detecting opportunities in recent tool_calls and writing
  // `kind='measured'` rows. Drives the dashboard's continuous savings
  // tracking. Realized vs. potential is determined at query time by
  // joining with subagent_installs, so this analyzer doesn't need to
  // know whether anything is installed.
  const optimizationAnalyzer = createOptimizationAnalyzer({ db, ipcServer });
  optimizationAnalyzer.start();

  // Start IPC server. Sprint 2: when the Tauri parent piped a handshake
  // token through stdin, we enforce it on every connection. When stdin
  // produced nothing (dev CLI launches), the server runs unauthenticated
  // — that's an explicit dev-mode opt-out, not a production code path.
  ipcServer.start(undefined, ipcHandshakeToken);
  if (ipcHandshakeToken) {
    console.log(
      `[Sentinel] IPC server started (handshake auth enabled, ${ipcHandshakeToken.length} byte token)`,
    );
  } else {
    console.log('[Sentinel] IPC server started (UNAUTHENTICATED — dev mode)');
  }

  // Startup credential reconciliation — deliberately deferred to AFTER the
  // IPC server is listening. verifyStartupActiveAccount and healDriftedRows
  // both call fetchProfile (real outbound HTTPS, bounded but still seconds
  // when slow); when they gated startup, the IPC pipe didn't exist yet when
  // the UI mounted and its first refresh_accounts timed out ("Refresh
  // failed", empty account list — observed on Windows VMs). The optimistic
  // local seed already populated the DB; these only correct rare org-drift
  // after the fact and broadcast so the UI refetches.
  const startupReconciliation = (async () => {
    try {
      console.log('[Startup] background credential reconciliation starting');
      const reconStartedAt = Date.now();
      const drift = await verifyStartupActiveAccount(activeAccount, startupCreds, {
        readCredentials: readSentinelCredentials,
      });
      /* v8 ignore next 1 -- shutdown race guard; exercised only when a test tears down mid-reconcile */
      if (shuttingDown) return;
      // Drift realign: same correction the old pre-seed inline branch made,
      // plus cleanup of the stale optimistic row that now already exists
      // (keyed by the JSON file's wrong org). credential-verifier.test.ts
      // owns full drift-path coverage; this branch is wiring glue.
      /* v8 ignore start */
      if (drift?.drifted && startupKey) {
        const staleKey = startupKey;
        activeAccount = drift.activeAccount;
        startupKey = drift.startupKey;
        // Re-capture under the corrected key so the credential is accessible
        // under the new row id.
        startupCreds = captureCurrentCredentials(startupKey);
        if (startupCreds) activeToken.value = startupCreds.accessToken;
        activeAccountId.value = startupKey;
        const existingAcct = listAccounts(db).find((a) => a.id === startupKey);
        upsertAccount(db, {
          id: startupKey,
          accountUuid: activeAccount.accountUuid,
          email: activeAccount.emailAddress,
          displayName: activeAccount.displayName ?? '',
          orgUuid: activeAccount.organizationUuid ?? '',
          orgName: activeAccount.organizationName ?? '',
          planType: existingAcct?.planType ?? inferPlanType(activeAccount, startupCreds),
          isActive: true,
          createdAt: Date.now(),
          color: existingAcct?.color ?? null,
        });
        if (staleKey !== startupKey) deleteAccount(db, staleKey);
        if (startupKey !== activeAccount.accountUuid) deleteAccount(db, activeAccount.accountUuid);
        ipcServer.broadcast({ type: 'account_switched', to: activeAccount });
      }
      /* v8 ignore stop */

      // Self-heal rows whose stored credentials no longer match their row's
      // orgUuid. Regression fix for the duplicate-Max scenario — see
      // credential-verifier.ts#healDriftedRows for the full rationale.
      const drifted = await healDriftedRows(db, { readCredentials: readSentinelCredentials });
      /* v8 ignore next 1 -- shutdown race guard; exercised only when a test tears down mid-reconcile */
      if (shuttingDown) return;
      if (drifted > 0) {
        console.log(`[Startup] Soft-removed ${drifted} row(s) with org-drifted credentials`);
        /* v8 ignore next 1 -- broadcast nudge; UI refetch is covered by hook tests */
        if (activeAccount) ipcServer.broadcast({ type: 'account_switched', to: activeAccount });
      }
      console.log(
        `[Startup] background credential reconciliation done (${Date.now() - reconStartedAt}ms)`,
      );
    } catch (err) {
      /* v8 ignore next 2 */
      console.error('[Startup] credential reconciliation failed:', err);
    }
  })();

  // Start the OTEL drift watcher after the IPC server is up. Placed
  // here so it doesn't shift the event-loop scheduling between the
  // earlier void agentsSyncEngine.start() and the IPC server's listen,
  // which keeps the agents-sync `active=true` flip race-free.
  void otelSettingsWatcher.start().catch((err: unknown) => {
    console.error('[OtelDrift] initial start failed:', err);
  });

  // Sprint 2: surface settings-file tamper to the UI as soon as a client
  // connects. Defer the broadcast to the next tick so the IPC `clients`
  // set has had a chance to populate.
  if (initialLoad.tamperDetected) {
    console.warn(
      `[Sentinel] Settings tamper detected at startup (reason=${initialLoad.reason}); broadcasting to UI`,
    );
    setImmediate(() => {
      ipcServer.broadcast({
        type: 'settings_tamper_detected',
        reason: initialLoad.reason ?? 'sig_mismatch',
        path: initialLoad.path,
      });
    });
  }

  // Tracks which accounts have an in-flight inline refresh triggered by a
  // proxy 401, so a burst of concurrent 401s (Claude Code running multiple
  // tool calls in parallel against a dead token) fires only one refresh
  // attempt rather than N.
  const inFlightAuthRefresh = new Set<string>();

  // Create HTTP proxy server. The tokenProvider returns a rotated credential
  // only when the user has opted into round-robin mode; otherwise the proxy
  // falls back to the shared activeToken/activeAccountId refs (original flow).
  const httpServer = createProxyServer(
    {
      db,
      ipcServer,
      overageMachine,
      activeToken,
      activeAccountId,
      rateLimitStore,
      // Callback wiring for createProxyServer: these only fire when a request
      // flows through the proxy. The full in-daemon wiring is tested by
      // `proxy.*.integration.test.ts`, which uses `startProxyWithFake` to
      // exercise each callback shape directly. Driving live proxy requests
      // from the IPC-focused daemon harness would re-cover the same paths,
      // so the callbacks here ride on an ignore block and the proxy-side
      // files own the assertions.
      /* v8 ignore start */
      tokenProvider: (ctx) => {
        if (currentSettings.switchingMode !== 'round-robin') return null;
        return tokenRotator.pick(ctx);
      },
      getPausedAccountIds: () => spendTracker.getPausedIds(),
      getPauseReason: (accountId) => spendTracker.getPauseReason(accountId),
      getSessionResetAt: (accountId) => {
        const w = rateLimitStore.getAll(accountId).find((x) => x.name === 'unified-5h');
        return w?.reset ?? null;
      },
      getWeeklyResetAt: (accountId) => {
        const w = rateLimitStore.getAll(accountId).find((x) => x.name === 'unified-7d');
        return w?.reset ?? null;
      },
      getOverageAllowedIds: () => new Set(currentSettings.overageEnabledIds),
      getOverageBufferPct: () => currentSettings.overageBufferPct ?? 5,
      /* v8 ignore stop */
      securityScanner,
      permissionsEnforcer,
      requestLogStore,
      compressionStore,
      contextCostStore,
      mcpHandler,
      codeModeHandler,
      requestAccountMap,
      // A 401 on a real Claude Code request means the token was revoked
      // server-side while the local `expiresAt` still claims it's valid —
      // the background refresher can't detect this because it only refreshes
      // within 30 min of local expiry. Force a refresh inline so the NEXT
      // request uses the fresh token; on refresh failure, refreshIfNeeded
      // broadcasts `token_refresh_failed` → the UI's Re-authenticate banner
      // appears within seconds of the failing command.
      // Also only reachable through proxy request flow (see block above).
      /* v8 ignore start */
      onUpstreamAuthFailure: (accountId) => {
        if (inFlightAuthRefresh.has(accountId)) return;
        const acct = getAccount(db, accountId);
        if (!acct) return;
        inFlightAuthRefresh.add(accountId);
        console.log(`[Proxy] 401 from upstream for ${accountId} — forcing token refresh`);
        void refreshIfNeeded(
          { db, activeToken, activeAccountId, ipcServer, tokenRotator },
          accountId,
          acct.email,
          /* force */ true,
        ).finally(() => {
          inFlightAuthRefresh.delete(accountId);
        });
      },
      /* v8 ignore stop */
      // Sprint 9 health probe. Each component check is sub-millisecond
      // and runs inline on `/health` requests + on the fail-mode gate.
      // SELECT 1 catches a closed/locked DB; the scanner/enforcer truthy
      // check guards against a partial-init regression in the future.
      getHealth: () => {
        let dbStatus: string = 'ok';
        try {
          db.prepare('SELECT 1 AS ok').get();
        } catch (err) {
          dbStatus = err instanceof Error ? `error:${err.message}` : 'error:unknown';
        }
        return {
          db: dbStatus,
          scanner: securityScanner ? 'ok' : 'error:not_initialized',
          enforcer: permissionsEnforcer ? 'ok' : 'error:not_initialized',
        };
      },
      getSettings: () => ({ daemonHealthFailMode: currentSettings.daemonHealthFailMode }),
      // Optimize feature: poke the analyzer when the proxy has just
      // flushed a non-empty tool_calls batch. The analyzer's debounced
      // runOnce produces an `optimization_metrics_updated` broadcast
      // within ~1.5s, giving the dashboard Metrics-like responsiveness.
      onToolCallsFlushed: () => optimizationAnalyzer.scheduleRun(),
    },
    (req, res) => {
      const url = req.url ?? '/';
      // [OTEL-DIAG] Temporary: log every OTLP request reaching the receiver so
      // we can tell on Windows whether Claude Code's exporter connects at all
      // (settles "never arrived" vs "arrived but wrote nothing"). Remove before
      // merging to main.
      console.log(
        `[OTEL-DIAG] OTLP ${req.method ?? '?'} ${url} ` +
          `ct=${req.headers['content-type'] ?? '-'} ` +
          `ce=${req.headers['content-encoding'] ?? '-'} ` +
          `len=${req.headers['content-length'] ?? '-'}`,
      );
      if (url.startsWith('/v1/metrics')) {
        return otelReceiver.handleMetrics(req, res);
      }
      return otelReceiver.handleLogs(req, res);
    },
  );

  // Safety net in case the pre-startup health probe missed an existing
  // daemon (race window between isDaemonAlreadyRunning() and listen()).
  // Without this, EADDRINUSE surfaces as an unhandled 'error' event and
  // crashes the daemon — which is still correct exit behavior, but this
  // gives us a clear log line instead of an unhandled exception trace.
  /* v8 ignore start */
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(
        `[Sentinel] Port ${getDaemonPort()} already in use — another daemon is running. Exiting.`,
      );
      process.exit(0);
    }
    console.error('[Sentinel] HTTP server error:', err);
    process.exit(1);
  });
  /* v8 ignore stop */

  // In test mode bind an OS-assigned ephemeral port (listen(0)) so parallel
  // workers can't collide on a pre-picked port — listen(0) binds atomically with
  // no pick-then-close reuse window. Production binds the fixed daemon port. Await
  // the bind so the handle is only returned once the server is actually listening.
  /* v8 ignore next -- prod binds the fixed port; the in-process suite always runs in test mode */
  const listenPort = inTestMode ? 0 : getDaemonPort();
  await new Promise<void>((resolve) => {
    httpServer.listen(listenPort, '127.0.0.1', () => {
      const boundPort = (httpServer.address() as AddressInfo).port;
      // Reflect the actually-bound port so getDaemonPort() (which reads this env
      // var) stays consistent in tests; in production the var is unset (no-op).
      /* v8 ignore next -- prod leaves the env var unset, making this a no-op */
      if (inTestMode) process.env.SENTINEL_TEST_DAEMON_PORT = String(boundPort);
      console.log(`[Sentinel] HTTP proxy listening on http://127.0.0.1:${boundPort}`);
      // [OTEL-DIAG] Temporary: confirm the platform-resolved paths + bound
      // address the receiver writes to / reads from. Remove before merging.
      console.log(
        `[OTEL-DIAG] startup platform=${process.platform} homedir=${homedir()} ` +
          `db=${join(homedir(), '.sentinel', 'sentinel.db')} ` +
          `listen=127.0.0.1:${boundPort} endpoint=${SENTINEL_BASE_URL}`,
      );
      // Probe for fresh rate-limit headers through the proxy now that it is ready.
      // The proxy injects the active OAuth token, so this works even for accounts
      // whose tokens cannot be used to call api.anthropic.com directly.
      if (startupKey) {
        probeRateLimits(startupKey, ipcServer);
      }
      resolve();
    });
  });

  // Keep OAuth tokens fresh in the background. Runs once immediately (catching
  // any account whose token expired overnight) then every 15 minutes.
  const stopTokenRefresher = startTokenRefresher({
    db,
    activeToken,
    activeAccountId,
    ipcServer,
    tokenRotator,
  });

  // One-shot forced refresh + profile resync across every enrolled account.
  // Two goals:
  //   1. Catch silently-revoked refresh tokens at startup. The background
  //      refresher's timestamp-gated pass skips any token whose local
  //      `expiresAt` is >30 min out, so a refresh_token the server has
  //      revoked (but whose access_token hasn't yet expired) produces zero
  //      `token_refresh_failed` broadcasts and no reauth prompt. A forced
  //      refresh on boot tries them all and fires the broadcast when the
  //      refresh endpoint rejects the token.
  //   2. Populate `subscriptionType` on imported-from-Claude-Code creds so
  //      the next boot's heal loop (see the healed-planType block earlier in
  //      this function) can correct any stale `plan_type='max'` rows left
  //      behind by the pre-fix `has_claude_max` bug. CC's keychain slot
  //      doesn't carry this field; the OAuth profile endpoint does.
  // Runs on queueMicrotask so we don't gate the rest of daemon startup.
  // Every branch inside the IIFE fires asynchronously after startDaemon()
  // resolves, so the integration harness cleans up before each branch has
  // a chance to be recorded. The refresh pipeline is covered end-to-end by
  // `token-refresher.integration.test.ts` + `oauth.integration.test.ts`;
  // reproducing it here would add test time without new signal.
  /* v8 ignore start */
  queueMicrotask(() => {
    void (async () => {
      for (const acct of listAccounts(db)) {
        const refreshResult = await refreshIfNeeded(
          { db, activeToken, activeAccountId, ipcServer, tokenRotator },
          acct.id,
          acct.email,
          /* force */ true,
        );
        if (!refreshResult.success) continue;
        // Refresh succeeded — use the fresh token to fetch profile and write
        // `subscriptionType` back into the credential so heal can correct
        // plan type on the next boot. No-op on accounts already carrying
        // subscriptionType (merged on top of existing fields).
        const freshCreds = readSentinelCredentials(acct.id);
        if (!freshCreds?.accessToken) continue;
        try {
          const profile = await fetchProfile(freshCreds.accessToken);
          if (profile.subscriptionType && !freshCreds.subscriptionType) {
            writeSentinelCredentials(acct.id, {
              ...freshCreds,
              subscriptionType: profile.subscriptionType,
              ...(profile.rateLimitTier && !freshCreds.rateLimitTier
                ? { rateLimitTier: profile.rateLimitTier }
                : {}),
            });
            console.log(
              `[Startup] Populated subscriptionType='${profile.subscriptionType}' for ${acct.email} — next boot's heal will correct plan_type if stale`,
            );
          }
        } catch (err) {
          console.warn(
            `[Startup] fetchProfile failed for ${acct.email}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    })();
  });
  /* v8 ignore stop */

  // Keep rate-limit / usage state fresh for all non-active accounts so the
  // Usage tab reflects consumption from other Anthropic surfaces (claude.ai,
  // Claude Desktop, direct API) even when Claude Code isn't driving them.
  //
  // `shouldSkipProbe` pauses probing on accounts the user has excluded from
  // the round-robin pool. Each probe is a real `POST /v1/messages` that
  // consumes ~1 output token on the target account — probing an excluded
  // account keeps its 5h utilization climbing from Sentinel traffic, which
  // is exactly the signal the user wanted to stop. The exception: once the
  // stored `unified-5h.reset` is in the past, the window has rolled over on
  // Anthropic's side, so one probe runs to capture fresh numbers (util ≈ 0,
  // new reset ~5h ahead) for the dashboard. The next tick sees a future
  // reset again and skips — net effect: one probe per excluded account per
  // 5h window. Outside round-robin mode the predicate never short-circuits.
  usageProber = startUsageProber({
    db,
    ipcServer,
    getIntervalSec: () => currentSettings.backgroundProbeIntervalSec,
    shouldSkipProbe: (accountId: string): boolean => {
      if (currentSettings.switchingMode !== 'round-robin') return false;
      if (!currentSettings.poolExcludedIds.includes(accountId)) return false;
      const w = rateLimitStore.getAll(accountId).find((x) => x.name === 'unified-5h');
      // No stored reset → let the first probe happen so we have a baseline.
      if (!w || w.reset == null) return false;
      // Reset is still in the future → window hasn't rolled over yet → skip.
      return Date.now() / 1000 < w.reset;
    },
  });

  // Graceful shutdown. Idempotent (guarded by shuttingDown) so tests can call
  // it from afterEach without fear of double-close exceptions, and so a
  // second SIGINT/SIGTERM from the user during shutdown is a no-op. Returns
  // a Promise that resolves once the HTTP server has finished draining
  // connections. cli.ts wraps this with process.exit(0); tests just await.
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[Sentinel] Shutting down...');
    stopTokenRefresher();
    usageProber?.stop();
    // Stop the claude.ai usage poller BEFORE closing the DB so an in-flight
    // tick() cannot land on a freed connection. The tick reads listAccounts
    // from the shared DB handle and subscribers call into SpendTracker.
    claudeAiUsageStore.stop();
    clearInterval(telemetryPurgeTimer);
    clearInterval(optimizationPurgeTimer);
    clearInterval(requestLogPurgeTimer);
    clearInterval(compressionPurgeTimer);
    clearInterval(contextCostPurgeTimer);
    clearInterval(securityEventPurgeTimer);
    clearInterval(chainIntegrityTimer);
    spendTracker.stop();
    permissionsEnforcer.shutdown();
    await codeModeManager.stopAll();
    optimizationAnalyzer.stop();
    agentsSyncEngine.stop();
    otelSettingsWatcher.stop();
    ipcServer.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    closeDb();
    closeRequestLogStore();
    closeCompressionStatsStore();
    closeContextCostStore();
  };

  return { httpServer, ipcServer, startupReconciliation, shutdown };
}
