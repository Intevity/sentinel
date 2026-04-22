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
  clearOverageEvents,
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
  addSecurityAllowlist,
  removeSecurityAllowlist,
  listSecurityAllowlist,
  listPermissionBypasses,
  removePermissionBypass,
  upsertPermissionRule,
  deletePermissionRule,
  insertNotification,
  getCacheTtlByDayModel,
  getCacheTtlBySession,
} from './db.js';
import { loadSettings, updateSettings as writeSettings } from './settings.js';
import { IpcServer } from './ipc.js';
import { OtelReceiver } from './otel-receiver.js';
import { OverageStateMachine } from './overage.js';
import { createProxyServer, DAEMON_PORT } from './proxy.js';
import type { ActiveToken, ActiveAccountId } from './proxy.js';
import { RateLimitStore } from './rate-limit-store.js';
import { TokenRotator } from './token-rotator.js';
import { OverageGrantStore } from './overage-grant-store.js';
import { SpendTracker } from './spend-tracker.js';
import { ClaudeAiUsageStore } from './claude-ai-usage.js';
import {
  writeClaudeAiSessionKey,
  deleteClaudeAiSessionKey,
  hasClaudeAiSessionKey,
  readClaudeAiSessionKey,
} from './accounts.js';
import { fetchBootstrap } from './claude-ai-bootstrap.js';
import {
  startAlertEvaluator,
  startPoolAlertEvaluator,
  evaluatePoolOnce,
  primeNewAlertAgainstCurrentWindow,
} from './alerts.js';
import { createSecurityScanner } from './security/scanner.js';
import { createPermissionsEnforcer } from './security/permissions/enforcer.js';
import { createClaudeSyncEngine } from './security/permissions/claude-sync.js';
import { runScanBenchmark } from './security/scanner-benchmark.js';
import { parseRule as parsePermissionRule } from './security/permissions/parser.js';
import type { Settings } from '@claude-sentinel/shared';
import { getActiveAccount, setActiveAccount } from './claude-state.js';
import {
  readActiveCredentials,
  captureCurrentCredentials,
  writeSentinelCredentials,
  writeClaudeCodeCredentials,
  deleteSentinelCredentials,
  readSentinelCredentials,
} from './accounts.js';
import { startOAuthLogin, OAUTH_ABORTED } from './oauth.js';
import type { OAuthResult } from './oauth.js';
import { switchActiveOrg } from './claude-ai-bootstrap.js';
import {
  startTokenRefresher,
  refreshIfNeeded,
  markAccountReauthenticated,
} from './token-refresher.js';
import { probeRateLimits } from './rate-limit-probe.js';
import { startUsageProber, type UsageProberHandle } from './usage-probe.js';
import type { OAuthAccount, PlanType, ClaudeCodeCredentials } from '@claude-sentinel/shared';
import { request as httpRequest, type Server } from 'http';
import { log } from './logger.js';
import { getRequestLogStore, closeRequestLogStore } from './request-log-db.js';

/**
 * Probe 127.0.0.1:DAEMON_PORT/health to see whether another daemon is
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
        port: DAEMON_PORT,
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

// ─── File logger ─────────────────────────────────────────────────────────────
// The logger singleton owns: level filtering, ring buffer, file rotation
// (10MB × 3), and broadcast batching to the UI. Apply the persisted level
// BEFORE installing the console monkey-patch so the very first console.log
// call (`[Sentinel] Starting daemon…` below) is already subject to filtering.
log.setLevel(loadSettings().logLevel);
log.installConsolePatch();

/**
 * Returns the Sentinel-internal key for an account: orgUuid when present,
 * else accountUuid. This allows the same Anthropic user (same accountUuid) to
 * appear as multiple distinct entries when they belong to different orgs
 * (e.g. a personal Max subscription + a Team org subscription).
 */
function sentinelKey(orgUuid: string, accountUuid: string): string {
  return orgUuid || accountUuid;
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
 * Start the sentinel daemon:
 *  1. Open SQLite database
 *  2. Start IPC server
 *  3. Start HTTP proxy server (proxy + OTEL receiver)
 */
// Captured once at daemon startup so get_daemon_status can report uptime.
const DAEMON_STARTED_AT = Date.now();

export async function startDaemon(): Promise<void> {
  console.log('[Sentinel] Starting daemon v0.1.0...');

  /* v8 ignore next 6 */
  if (await isDaemonAlreadyRunning()) {
    console.log(
      `[Sentinel] Another daemon is already listening on 127.0.0.1:${DAEMON_PORT} — exiting cleanly.`,
    );
    process.exit(0);
  }

  const db = getDb();

  // Remove any corrupt account entries created before the profile field-name fix
  // (accounts with an empty UUID — email/UUID were not parsed correctly from the API).
  db.prepare("DELETE FROM accounts WHERE id = '' OR id IS NULL").run();

  // Seed the active account into the DB from ~/.claude.json so the UI shows
  // something immediately without waiting for an API call to come through.
  const activeAccount = getActiveAccount();
  // Capture + store the current keychain token under the Sentinel key so
  // Sentinel accumulates per-account credentials across switches.
  // Keying by sentinelKey (orgUuid || accountUuid) means two accounts sharing
  // the same Anthropic user UUID but in different orgs each get their own entry.
  const startupKey = activeAccount
    ? sentinelKey(activeAccount.organizationUuid ?? '', activeAccount.accountUuid)
    : null;
  const startupCreds = startupKey ? captureCurrentCredentials(startupKey) : null;

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

  // Shared token reference — mutated on account switch, read by the proxy
  const activeToken: ActiveToken = { value: null };
  // Shared account-key reference — mutated on switch/refresh, used by proxy for rate limit storage
  const activeAccountId: ActiveAccountId = { value: startupKey ?? 'default' };

  // Seed the active token from keychain on startup
  if (startupCreds) activeToken.value = startupCreds.accessToken;

  const ipcServer = new IpcServer();

  // Push daemon log entries to every connected UI client. Batched by the
  // logger itself (100ms / 50 entries). Registered before the server starts
  // so entries logged during startup flow through the broadcast pipeline.
  log.onBroadcast((entries) => {
    ipcServer.broadcast({ type: 'daemon_log', entries });
  });

  const overageMachine = new OverageStateMachine();

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
  } catch (err) {
    console.error('[Sentinel] Overage state rehydration failed:', err);
  }

  const otelReceiver = new OtelReceiver(db, activeAccountId, ipcServer);
  const rateLimitStore = new RateLimitStore();

  // In-memory mirror of settings — read at startup, updated on every
  // update_settings call so proxy/rotator paths can consult it without
  // re-reading the JSON file per request.
  let currentSettings: Settings = loadSettings();

  // Assigned after the proxy is listening — update_settings references it
  // via optional-chain so handler registration order doesn't matter.
  let usageProber: UsageProberHandle | null = null;

  // Shared settings getter so the rotator, alert evaluators, and other
  // subsystems read the same live in-memory snapshot that `update_settings`
  // mutates. Declared up-front so it can be referenced in constructors below.
  const getSettings = (): Settings => currentSettings;

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
  });
  getPausedAccountIds = () => spendTracker.getPausedIds();
  // Initial pass — paused state is empty at startup, but a spend summary
  // broadcast lets the UI seed its dashboard without waiting for the first
  // OTEL batch.
  spendTracker.recompute();

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
   */
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

    console.log(
      `[OAuth] Login complete for ${email} (org: ${orgName || '?'}, reauth: ${wasReauth}), broadcasting to ${ipcServer.connectedClients} client(s)`,
    );
    ipcServer.broadcast({ type: 'login_complete', email, orgName, reauth: wasReauth });
  };

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
        // View-scope account: prefer msg.accountId (per-tab picker), otherwise
        // derive from the currently active account. Either must resolve.
        let key: string | null = null;
        if (msg.accountId) {
          key = msg.accountId;
        } else {
          const active = getActiveAccount();
          if (active) key = sentinelKey(active.organizationUuid ?? '', active.accountUuid);
        }
        if (!key) {
          respond({
            requestType: 'get_metrics_summary',
            success: false,
            error: 'No active account',
          });
          break;
        }
        const days = msg.days ?? 7;
        // Bundle every dashboard slice in one round-trip. Query helpers all
        // accept (accountId, days) and do their own windowing, so ordering
        // here is just for readability.
        const byDayModel = getTokensByDayModel(db, key, days);
        const cacheHitRate = getCacheHitRate(db, key, days);
        const errors = getApiErrorsByDay(db, key, days);
        const tools = getToolStats(db, key, days);
        const perDayCounters = getActivityCounters(db, key, days, [
          'session',
          'commit',
          'pull_request',
          'lines_added',
          'lines_removed',
          'active_user_seconds',
          'active_cli_seconds',
        ]);
        const editAcceptRate = getEditAcceptRate(db, key, days);
        const toolDecisions = getToolDecisionBreakdown(db, key, days);
        const prompts = getUserPromptStats(db, key, days);
        const skills = getTopSkills(db, key, days, 10);
        const plugins = getRecentPlugins(db, key, 10);
        const cacheTtl = {
          byDayModel: getCacheTtlByDayModel(db, key, days),
          bySession: getCacheTtlBySession(db, key, days),
        };

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
            accountId: key,
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

      case 'get_overage_events': {
        const events = getOverageEvents(db, {
          limit: msg.limit ?? 100,
          ...(msg.accountId ? { accountId: msg.accountId } : {}),
        });
        respond({ requestType: 'get_overage_events', success: true, data: events });
        break;
      }

      case 'clear_overage_events': {
        const count = clearOverageEvents(db, msg.accountId);
        respond({ requestType: 'clear_overage_events', success: true, data: { count } });
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
        // Covers both services Sentinel writes to: `Claude Sentinel-credentials`
        // (OAuth tokens) AND `Claude Sentinel-claude-ai-session` (claude.ai
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
          deleteClaudeAiSessionKey(key);
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

      case 'set_claude_ai_session_key': {
        try {
          console.log(
            `[SessionMirror] set_claude_ai_session_key received for ${msg.accountId} (key len=${msg.sessionKey.length})`,
          );
          writeClaudeAiSessionKey(msg.accountId, msg.sessionKey);
          void claudeAiUsageStore.refresh(msg.accountId);
          // Respond to the UI immediately so the spinner on the
          // triggering account's Connect button clears. Mirroring to
          // sibling accounts (same Google login → multiple Sentinel
          // rows) runs async below.
          respond({ requestType: 'set_claude_ai_session_key', success: true });

          // Shared-session mirroring: one claude.ai sessionKey covers
          // every org the user is a member of, so when a Sentinel
          // account gets its key set we propagate the same key to every
          // other Sentinel row whose orgUuid appears in the user's
          // membership list. That turns a single Connect click into a
          // simultaneous Connect for all sibling accounts the user has
          // enrolled under the same login — no per-account Connect
          // dance required.
          void (async (): Promise<void> => {
            // Pass the just-connected account's orgUuid as the
            // edge-api hint — any membership the user has is a valid
            // path param and the response enumerates every org.
            const hintAccount = listAccounts(db).find((a) => a.id === msg.accountId);
            const orgHint = hintAccount?.orgUuid || msg.accountId;
            console.log(`[SessionMirror] calling fetchBootstrap (orgHint=${orgHint})…`);
            const boot = await fetchBootstrap(msg.sessionKey, orgHint);
            if (!boot) {
              console.log(
                '[SessionMirror] fetchBootstrap returned null, aborting sibling mirror/prompt',
              );
              return;
            }
            console.log(
              `[SessionMirror] bootstrap result: email=${boot.email ?? '?'} orgs=${boot.orgs.length} (${boot.orgs.map((o) => o.orgName || o.orgUuid).join(', ')})`,
            );
            const allAccounts = listAccounts(db);
            let mirrored = 0;
            for (const acc of allAccounts) {
              if (acc.id === msg.accountId) continue;
              if (!acc.orgUuid || !boot.orgUuids.includes(acc.orgUuid)) continue;
              try {
                writeClaudeAiSessionKey(acc.id, msg.sessionKey);
                void claudeAiUsageStore.refresh(acc.id);
                mirrored++;
              } catch (e) {
                console.warn(
                  '[SessionMirror] write failed for',
                  acc.id,
                  e instanceof Error ? e.message : String(e),
                );
              }
            }
            if (mirrored > 0) {
              console.log(
                '[SessionMirror] mirrored sessionKey to',
                mirrored,
                'sibling account(s) for email',
                boot.email,
              );
            }

            // Sibling enrollment prompt: bootstrap lists every chat-capable
            // org the user can access with this login. Any of those that
            // DON'T have a Sentinel row yet are candidates for the "add
            // remaining accounts" prompt. The UI surfaces them so the user
            // can sign in once more per org without having to remember they
            // exist. We broadcast even when the list is empty? No — stay
            // quiet in that case so the user isn't interrupted on the
            // normal happy path.
            const enrolledOrgUuids = new Set(
              allAccounts.map((a) => a.orgUuid).filter((u): u is string => !!u),
            );
            const missing = boot.orgs.filter((o) => !enrolledOrgUuids.has(o.orgUuid));
            console.log(
              `[SessionMirror] enrolled orgs: [${Array.from(enrolledOrgUuids).join(', ')}]; missing: [${missing.map((o) => o.orgName || o.orgUuid).join(', ')}]`,
            );
            if (boot.email) {
              // Always broadcast — even with empty missing list.
              // The UI clears its banner when it receives an empty
              // list, which is how the sibling-add walk knows "I'm
              // done, hide the prompt." Previously we suppressed
              // empty broadcasts and the banner got stuck after the
              // last sibling was added because the UI never got the
              // signal.
              console.log(
                `[SessionMirror] broadcasting additional_orgs_available for ${boot.email} — ${missing.length === 0 ? '(empty: all siblings enrolled)' : missing.map((o) => o.orgName || o.orgUuid).join(', ')}`,
              );
              ipcServer.broadcast({
                type: 'additional_orgs_available',
                email: boot.email,
                orgs: missing,
              });
            }
          })();
        } catch (err) {
          respond({
            requestType: 'set_claude_ai_session_key',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case 'clear_claude_ai_session_key': {
        // Read the key BEFORE deleting so we can enumerate siblings via
        // /api/bootstrap. The endpoint needs a live sessionKey; once
        // we've deleted ours we can't ask Anthropic "which orgs did
        // this token cover?"
        const keyBeforeDelete = readClaudeAiSessionKey(msg.accountId);
        deleteClaudeAiSessionKey(msg.accountId);
        void claudeAiUsageStore.refresh(msg.accountId);
        respond({ requestType: 'clear_claude_ai_session_key', success: true });

        // Mirror the disconnect to siblings the same way Connect
        // mirrors writes. If bootstrap fails (network, already
        // server-side expired) we fall back to a local-match strategy:
        // clear the session-key for every account whose stored value
        // equals the one we just deleted, since shared-session siblings
        // all hold byte-for-byte identical copies in keychain.
        if (keyBeforeDelete) {
          // Do the byte-match cascade SYNCHRONOUSLY first — it's a
          // keychain read per account, fast and reliable. Then fire
          // the /api/bootstrap lookup async as a belt-and-suspenders
          // catch for accounts whose keychain entry got out of sync
          // but are still listed as a sibling membership (e.g. one
          // was written by an older daemon version that didn't
          // mirror).
          //
          // The previous implementation gated stored-key matching
          // behind "only if bootstrap failed" — that left the door
          // open for accounts where the stored value matched
          // perfectly but bootstrap happened to not return their
          // orgUuid (different routing region, billing state, etc.),
          // producing exactly the "I disconnected one, the sibling
          // stayed Connected" bug. Always matching by bytes eliminates
          // that class entirely.
          const allAccounts = listAccounts(db);
          let cleared = 0;
          for (const acc of allAccounts) {
            if (acc.id === msg.accountId) continue;
            if (readClaudeAiSessionKey(acc.id) !== keyBeforeDelete) continue;
            try {
              deleteClaudeAiSessionKey(acc.id);
              void claudeAiUsageStore.refresh(acc.id);
              cleared++;
            } catch (e) {
              console.warn(
                '[SessionMirror] clear failed for',
                acc.id,
                e instanceof Error ? e.message : String(e),
              );
            }
          }
          if (cleared > 0) {
            console.log(
              '[SessionMirror] byte-match cleared sessionKey for',
              cleared,
              'sibling account(s)',
            );
          }

          // Async bootstrap pass — catches siblings whose stored key
          // drifted or was never written (legacy data). Fire-and-forget.
          // Use the disconnecting account's orgUuid as the edge-api
          // hint so the enumeration runs on the same path as Connect.
          void (async (): Promise<void> => {
            const disconnectHint =
              allAccounts.find((a) => a.id === msg.accountId)?.orgUuid || msg.accountId;
            const boot = await fetchBootstrap(keyBeforeDelete, disconnectHint);
            if (!boot) return;
            let clearedByBoot = 0;
            for (const acc of allAccounts) {
              if (acc.id === msg.accountId) continue;
              if (!acc.orgUuid || !boot.orgUuids.includes(acc.orgUuid)) continue;
              if (!hasClaudeAiSessionKey(acc.id)) continue; // already byte-cleared or never had one
              try {
                deleteClaudeAiSessionKey(acc.id);
                void claudeAiUsageStore.refresh(acc.id);
                clearedByBoot++;
              } catch (e) {
                console.warn(
                  '[SessionMirror] bootstrap-clear failed for',
                  acc.id,
                  e instanceof Error ? e.message : String(e),
                );
              }
            }
            if (clearedByBoot > 0) {
              console.log(
                '[SessionMirror] bootstrap-match cleared',
                clearedByBoot,
                'extra sibling(s) for email',
                boot.email,
              );
            }
          })();
        }
        break;
      }

      case 'has_claude_ai_session_key': {
        respond({
          requestType: 'has_claude_ai_session_key',
          success: true,
          data: { hasKey: hasClaudeAiSessionKey(msg.accountId) },
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
        // switch isn't an async fn).
        void claudeAiUsageStore.refresh(msg.accountId);
        respond({ requestType: 'refresh_claude_ai_usage', success: true });
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
        if (poolChanged) evaluatePoolOnce(poolAlertDeps);
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

      case 'clear_request_logs': {
        const deleted = requestLogStore.clearAll();
        ipcServer.broadcast({ type: 'request_logs_cleared', deleted });
        respond({ requestType: 'clear_request_logs', success: true, data: { deleted } });
        break;
      }

      case 'get_notifications': {
        const rows = listNotifications(db, { limit: msg.limit ?? 100 });
        respond({ requestType: 'get_notifications', success: true, data: rows });
        break;
      }

      case 'get_security_events': {
        const minConfidence = msg.includeWeakSignals === true ? 0 : 0.7;
        const rows = listSecurityEvents(db, {
          ...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}),
          limit: msg.limit ?? 200,
          minConfidence,
        });
        respond({ requestType: 'get_security_events', success: true, data: rows });
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
        // approve); the permissions path forwards `addBypass` so the
        // banner's "Always allow this exact input" checkbox can
        // insert a permission_bypass row atomically with the approve.
        const addBypass = msg.addBypass === true;
        const ok =
          securityScanner.resolvePending(msg.pendingId, 'approve') ||
          (permissionsEnforcer?.resolvePending(msg.pendingId, 'approve', { addBypass }) ?? false);
        respond({ requestType: 'approve_blocked_request', success: ok });
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
        const opts: { scope?: 'account' | 'pool' | 'budget'; accountId?: string } = {};
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
        if (scope === 'pool' && msg.accountId != null) {
          respond({
            requestType: 'upsert_alert',
            success: false,
            error: 'pool alerts must have accountId = null',
          });
          break;
        }
        if (scope === 'account' && !msg.accountId) {
          respond({
            requestType: 'upsert_alert',
            success: false,
            error: 'account alerts require an accountId',
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

      case 'get_sibling_candidates': {
        // Enumerate unenrolled chat-capable siblings per email. For
        // each distinct email among active accounts that has at
        // least one stored sessionKey, call bootstrap once (sessionKey
        // is shared across orgs so the first one is enough), filter
        // out orgs we already have a Sentinel row for, return the
        // leftovers keyed by email.
        //
        // Async so respond() fires after the bootstrap round trips
        // complete — callers rely on the response for their initial
        // state.
        void (async (): Promise<void> => {
          const all = listAccounts(db);
          const emails = Array.from(new Set(all.map((a) => a.email).filter((e) => e.length > 0)));
          const out: Record<string, Array<{ orgUuid: string; orgName: string }>> = {};
          for (const email of emails) {
            const bearer = all.find((a) => a.email === email && hasClaudeAiSessionKey(a.id));
            if (!bearer) continue;
            const key = readClaudeAiSessionKey(bearer.id);
            if (!key) continue;
            const boot = await fetchBootstrap(key, bearer.orgUuid || bearer.id);
            if (!boot) continue;
            const enrolled = new Set(
              all
                .filter((a) => a.email === email)
                .map((a) => a.orgUuid)
                .filter((u): u is string => !!u),
            );
            const missing = boot.orgs.filter((o) => !enrolled.has(o.orgUuid));
            if (missing.length > 0) {
              out[email] = missing.map((o) => ({
                orgUuid: o.orgUuid,
                orgName: o.orgName,
              }));
            }
          }
          respond({ requestType: 'get_sibling_candidates', success: true, data: out });
        })();
        break;
      }

      case 'silent_sibling_login': {
        // Silent (no-window) sibling enrollment.
        //
        // Approach: since claude.ai's sessionKey is shared across every
        // org the user belongs to, an "enrollment" for a sibling org
        // doesn't strictly need an OAuth token to exist in Sentinel —
        // usage fetching is sessionKey-authenticated, and the DB row
        // plus the mirrored sessionKey are enough to show the account
        // with full visibility. The tradeoff is that Claude Code
        // switching + the Sentinel proxy route-per-account can't use
        // this stub until the user triggers a real OAuth flow later.
        //
        // Flow:
        //   1. Find the parent account that owns a live sessionKey
        //      for this email.
        //   2. Hit /api/organizations/{target}/sync/settings to flip
        //      claude.ai's server-side "active org" for this session
        //      — mirrors what the web client does when you switch
        //      orgs in the UI, and primes any subsequent org-scoped
        //      API call we make with this sessionKey.
        //   3. Re-fetch bootstrap with the target org uuid as the
        //      hint. The response carries the org's name + raven_type
        //      + the user's email/displayName — everything Sentinel
        //      needs for the DB row.
        //   4. Upsert the Sentinel account (no keychain credential
        //      entry — zero OAuth tokens to store) and mirror the
        //      sessionKey under the new account id so the usage
        //      fetcher starts returning real data on the next tick.
        //   5. Broadcast login_complete with `silent: true` so the
        //      UI shows the account and skips the auto-Connect
        //      claude.ai flow (which would pop a window and defeat
        //      the whole point).
        respond({ requestType: 'silent_sibling_login', success: true });

        void (async (): Promise<void> => {
          const parentAccount = listAccounts(db).find(
            (a) => a.email === msg.email && hasClaudeAiSessionKey(a.id),
          );
          const parentSessionKey = parentAccount ? readClaudeAiSessionKey(parentAccount.id) : null;
          if (!parentSessionKey) {
            console.warn(
              `[SilentSibling] no sessionKey on file for ${msg.email} — aborting silent enrollment`,
            );
            ipcServer.broadcast({ type: 'login_complete', email: '' });
            return;
          }

          // 2. Flip server-side active org.
          await switchActiveOrg(parentSessionKey, msg.orgUuidHint);

          // 3. Fetch bootstrap scoped to the target org for fresh
          //    metadata.
          const boot = await fetchBootstrap(parentSessionKey, msg.orgUuidHint);
          if (!boot) {
            console.warn('[SilentSibling] bootstrap returned null — aborting silent enrollment');
            ipcServer.broadcast({ type: 'login_complete', email: '' });
            return;
          }
          const target = boot.orgs.find((o) => o.orgUuid === msg.orgUuidHint);
          if (!target) {
            console.warn(
              `[SilentSibling] target org ${msg.orgUuidHint} not present in bootstrap memberships — aborting`,
            );
            ipcServer.broadcast({ type: 'login_complete', email: '' });
            return;
          }

          const email = boot.email ?? msg.email;
          const displayName = boot.displayName ?? '';
          const accountUuid = boot.accountUuid ?? '';
          const orgName = target.orgName;
          const orgUuid = target.orgUuid;

          // Map claude.ai's raven_type to Sentinel's planType.
          // 'team' / 'claude_pro' / 'claude_max' / 'claude_enterprise'
          // are the values we've observed. Anything else → 'pro' as
          // the safe default.
          const planType: PlanType =
            target.ravenType === 'team'
              ? 'team'
              : target.ravenType === 'claude_max'
                ? 'max'
                : target.ravenType === 'max'
                  ? 'max'
                  : target.ravenType === 'claude_pro'
                    ? 'pro'
                    : target.ravenType === 'pro'
                      ? 'pro'
                      : target.ravenType === 'claude_enterprise'
                        ? 'enterprise'
                        : 'pro';

          const credKey = sentinelKey(orgUuid, accountUuid) || email;

          // 4. Upsert DB row. No credentials are written — the account
          //    has no accessToken/refreshToken, which is the stub
          //    marker performSwitch already handles (it refuses to
          //    switch with a friendly error).
          const wasReauth = hasActiveAccount(db, credKey);
          reactivateAccount(db, credKey);
          upsertAccount(db, {
            id: credKey,
            accountUuid: accountUuid || email,
            email,
            displayName,
            orgUuid,
            orgName,
            planType,
            isActive: false,
            createdAt: Date.now(),
            color: null,
          });

          // Seed a default alert on first enrollment (same policy as
          // full OAuth path so stub vs full parity is preserved).
          if (listAlerts(db, { scope: 'account', accountId: credKey }).length === 0) {
            upsertAlert(db, {
              scope: 'account',
              accountId: credKey,
              thresholdPct: 95,
              enabled: true,
            });
          }

          // 5. Mirror the sessionKey into the sibling's keychain
          //    entry so the usage fetcher can start hitting
          //    claude.ai on its behalf immediately.
          try {
            writeClaudeAiSessionKey(credKey, parentSessionKey);
            void claudeAiUsageStore.refresh(credKey);
          } catch (e) {
            console.warn(
              '[SilentSibling] mirrored sessionKey write failed:',
              e instanceof Error ? e.message : String(e),
            );
          }

          tokenRotator.refresh();

          console.log(
            `[SilentSibling] enrolled ${email} / ${orgName} (${planType}, reauth=${wasReauth}) without OAuth`,
          );
          ipcServer.broadcast({
            type: 'login_complete',
            email,
            orgName,
            reauth: wasReauth,
            silent: true,
          });
        })();
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

        startOAuthLogin({
          signal: abortController.signal,
          ...(msg.orgUuidHint ? { orgUuidHint: msg.orgUuidHint } : {}),
          // Surface the authorize URL via IPC broadcast instead of
          // exec('open URL'). The Tauri app listens for
          // `oauth_authorize_url` and opens the URL inside a
          // WebviewWindow so claude.ai's cookies (sessionKey
          // included) land in the shared WKHTTPCookieStore — the
          // Connect claude.ai flow that auto-triggers after the
          // account is created then finds those cookies instantly,
          // skipping the second-login hop. We also ALWAYS call
          // openBrowser as a safety net: if the frontend isn't
          // listening (daemon running headless during dev, or an
          // IPC hiccup), the user still gets their system browser
          // open so the flow isn't stuck.
          openAuthUrl: (url) => {
            try {
              ipcServer.broadcast({
                type: 'oauth_authorize_url',
                url,
                ...(msg.orgUuidHint ? { orgUuidHint: msg.orgUuidHint } : {}),
              });
            } catch (e) {
              console.warn('[OAuth] broadcast failed:', e instanceof Error ? e.message : String(e));
            }
          },
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
    }
  });

  // Evaluate user-created per-account alerts on every rate-limit update.
  const alertEvaluatorDeps = {
    db,
    rateLimitStore,
    ipcServer,
    getEmailForAccount: (accountId: string): string | null => {
      const acct = listAccounts(db).find((a) => a.id === accountId);
      return acct?.email ?? null;
    },
  };
  startAlertEvaluator(alertEvaluatorDeps);

  // Pool-wide alerts (round-robin only). No-ops outside round-robin mode.
  // Also called eagerly from the update_settings handler when the user
  // changes pool membership or switches into round-robin, so the new pool's
  // utilization is checked without waiting for the next rate-limit update.
  const poolAlertDeps = { ...alertEvaluatorDeps, getSettings };
  startPoolAlertEvaluator(poolAlertDeps);

  // Purge stale security events per the retention window. Runs once at
  // startup; rows continue to accumulate between restarts.
  try {
    const cutoff = Date.now() - currentSettings.securityEventRetentionDays * 24 * 60 * 60 * 1000;
    const purged = purgeSecurityEventsOlderThan(db, cutoff);
    if (purged > 0) {
      console.log(
        `[Security] Purged ${purged} security event(s) older than ${currentSettings.securityEventRetentionDays} days`,
      );
    }
  } catch (err) {
    console.error('[Security] retention purge failed:', err);
  }

  // Purge stale OTEL telemetry (usage_events, tool_events, api_errors,
  // activity_events) per the retention window. Runs once at startup and
  // re-runs every 24h so an always-on daemon doesn't accumulate data
  // indefinitely.
  const runTelemetryPurge = (): void => {
    try {
      const cutoff = Date.now() - currentSettings.telemetryRetentionDays * 24 * 60 * 60 * 1000;
      const purged = purgeTelemetryOlderThan(db, cutoff);
      if (purged > 0) {
        console.log(
          `[Telemetry] Purged ${purged} row(s) older than ${currentSettings.telemetryRetentionDays} days`,
        );
      }
    } catch (err) {
      console.error('[Telemetry] retention purge failed:', err);
    }
  };
  runTelemetryPurge();
  const telemetryPurgeTimer = setInterval(runTelemetryPurge, 24 * 60 * 60 * 1000);

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
    } catch (err) {
      console.error('[RequestLog] retention purge failed:', err);
    }
  };
  runRequestLogPurge();
  const requestLogPurgeTimer = setInterval(runRequestLogPurge, 24 * 60 * 60 * 1000);

  // Build the security scanner. Settings getter is passed as a thunk so the
  // scanner re-reads toggles and enforcement-mode on every request without
  // needing a restart.
  const securityScanner = createSecurityScanner({
    db,
    ipcServer,
    getSettings: () => currentSettings,
  });

  // Build the permission enforcer. Compiled rule cache is invalidated on
  // every IPC rule mutation; all settings are pulled via the thunk.
  const permissionsEnforcer = createPermissionsEnforcer({
    db,
    ipcServer,
    getSettings: () => currentSettings,
  });

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

  // Start IPC server
  ipcServer.start();
  console.log('[Sentinel] IPC server started');

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
      tokenProvider: () => {
        if (currentSettings.switchingMode !== 'round-robin') return null;
        return tokenRotator.pick();
      },
      getPausedAccountIds: () => spendTracker.getPausedIds(),
      getSessionResetAt: (accountId) => {
        const w = rateLimitStore.getAll(accountId).find((x) => x.name === 'unified-5h');
        return w?.reset ?? null;
      },
      securityScanner,
      permissionsEnforcer,
      requestLogStore,
    },
    (req, res) => {
      const url = req.url ?? '/';
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
        `[Sentinel] Port ${DAEMON_PORT} already in use — another daemon is running. Exiting.`,
      );
      process.exit(0);
    }
    console.error('[Sentinel] HTTP server error:', err);
    process.exit(1);
  });
  /* v8 ignore stop */

  httpServer.listen(DAEMON_PORT, '127.0.0.1', () => {
    console.log(`[Sentinel] HTTP proxy listening on http://127.0.0.1:${DAEMON_PORT}`);
    // Probe for fresh rate-limit headers through the proxy now that it is ready.
    // The proxy injects the active OAuth token, so this works even for accounts
    // whose tokens cannot be used to call api.anthropic.com directly.
    if (startupKey) {
      probeRateLimits(startupKey, ipcServer);
    }
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

  // Keep rate-limit / usage state fresh for all non-active accounts so the
  // Usage tab reflects consumption from other Anthropic surfaces (claude.ai,
  // Claude Desktop, direct API) even when Claude Code isn't driving them.
  usageProber = startUsageProber({
    db,
    ipcServer,
    getIntervalSec: () => currentSettings.backgroundProbeIntervalSec,
  });

  // Graceful shutdown
  const shutdown = (server: Server) => {
    console.log('[Sentinel] Shutting down...');
    stopTokenRefresher();
    usageProber?.stop();
    clearInterval(telemetryPurgeTimer);
    clearInterval(requestLogPurgeTimer);
    permissionsEnforcer.shutdown();
    ipcServer.close();
    server.close();
    closeDb();
    closeRequestLogStore();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown(httpServer));
  process.on('SIGINT', () => shutdown(httpServer));
}
