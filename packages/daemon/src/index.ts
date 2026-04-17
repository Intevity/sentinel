import { getDb, closeDb, listAccounts, listRemovedAccounts, upsertAccount, deleteAccount, deleteStaleAccountRows, markAccountRemoved, purgeAccount, reactivateAccount, hasNonPurgedAccount, getUsageByDayModel, acknowledgeNotification, acknowledgeAllNotifications, upsertRateLimit, loadRateLimits, getOverageEvents, listNotifications, listAlerts, upsertAlert, deleteAlert, deleteRateLimitsForAccount } from './db.js';
import { loadSettings, updateSettings as writeSettings } from './settings.js';
import { IpcServer } from './ipc.js';
import { OtelReceiver } from './otel-receiver.js';
import { OverageStateMachine } from './overage.js';
import { createProxyServer, DAEMON_PORT } from './proxy.js';
import type { ActiveToken, ActiveAccountId } from './proxy.js';
import { RateLimitStore } from './rate-limit-store.js';
import { TokenRotator } from './token-rotator.js';
import { startAutoSwitch } from './auto-switch.js';
import { startAlertEvaluator } from './alerts.js';
import type { Settings } from '@claude-sentinel/shared';
import { getActiveAccount, setActiveAccount } from './claude-state.js';
import { readActiveCredentials, captureCurrentCredentials, writeSentinelCredentials, writeClaudeCodeCredentials, deleteSentinelCredentials } from './accounts.js';
import { startOAuthLogin, OAUTH_ABORTED } from './oauth.js';
import type { OAuthAccount, PlanType, ClaudeCodeCredentials } from '@claude-sentinel/shared';
import type { Server } from 'http';
import { request as httpRequest } from 'http';
import { createWriteStream, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ─── File logger ─────────────────────────────────────────────────────────────
// All console output is tee'd to ~/.claude-sentinel/daemon.log so logs are
// visible when running as a native app sidecar (no terminal attached).
(function setupFileLogger() {
  const logDir = join(homedir(), '.claude-sentinel');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'daemon.log');
  const stream = createWriteStream(logPath, { flags: 'a' });

  const write = (level: string, args: unknown[]) => {
    const line = `[${new Date().toISOString()}] ${level} ${args.map(String).join(' ')}\n`;
    stream.write(line);
  };

  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log   = (...a) => { orig.log(...a);   write('LOG  ', a); };
  console.warn  = (...a) => { orig.warn(...a);  write('WARN ', a); };
  console.error = (...a) => { orig.error(...a); write('ERROR', a); };
})();

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
  if (sub === 'max')        return 'max';
  // A Team org where this user has a Max seat: the org type is 'team' but the user's
  // effective access level is Max (hasExtraUsageEnabled comes from account.has_claude_max
  // in the OAuth profile — it is TRUE only for Max seat holders, not the whole team).
  if (sub === 'team' && account.hasExtraUsageEnabled) return 'max';
  if (sub === 'team')  return 'team';
  if (sub === 'pro')   return 'pro';

  // No credential-based type available.
  // NOTE: hasExtraUsageEnabled in ~/.claude.json is only reliable when it comes fresh
  // from the OAuth profile. When read from ~/.claude.json it may reflect a PREVIOUS
  // account's state (written by Sentinel itself), so this fallback must only be used
  // for seeding brand-new accounts that have no existing DB entry.
  if (account.hasExtraUsageEnabled) return 'max';
  if (account.workspaceRole !== null) return 'team';
  return 'pro';
}

// In-memory credential store for inactive accounts (populated via IPC from Tauri app)
const credentialStore = new Map<string, string>();

// Abort controller for the currently-pending OAuth login (if any).
// Replaced each time start_login is received; used by cancel_login.
let loginAbortController: AbortController | null = null;

/**
 * Probe POST /v1/messages/count_tokens through the local proxy to obtain
 * fresh rate-limit headers for the currently active account.
 *
 * Routing through the proxy (rather than calling api.anthropic.com directly)
 * lets the proxy inject the OAuth Bearer token and handle auth — direct calls
 * with OAuth tokens are rejected by Anthropic with "OAuth authentication is
 * currently not supported". The proxy also writes the parsed headers into the
 * RateLimitStore and broadcasts rate_limits_updated to connected clients.
 *
 * Must be called AFTER the proxy server is listening.
 */
function probeRateLimits(accountId: string, ipcServer?: IpcServer): void {
  // Send a minimal inference request (max_tokens: 1) to obtain rate-limit headers.
  // count_tokens rejects OAuth tokens; /v1/messages accepts them as long as the
  // request includes the oauth-2025-04-20 beta flag and matches the shape
  // Claude Code itself sends. Without the beta header the endpoint 401s an
  // OAuth (claudeAiOauth) token even when it's valid. Cost: ~1 output token.
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });

  // Tell the UI a probe is in flight for this account so it can show a
  // loading indicator. Successful completion triggers rate_limits_updated
  // from the proxy; failures fall through to rate_limits_probe_ended below.
  ipcServer?.broadcast({ type: 'rate_limits_probing', accountId });

  const req = httpRequest(
    {
      hostname: '127.0.0.1',
      port: DAEMON_PORT,
      // `?beta=true` mirrors Claude Code's production request. The path-prefix
      // match in the proxy (ANTHROPIC_PATHS.some(p => url.startsWith(p)))
      // tolerates it.
      path: '/v1/messages?beta=true',
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'oauth-2025-04-20',
        'user-agent':        'claude-cli/sentinel-probe',
        'accept':            'application/json',
        // Deliberately no accept-encoding — keeps failure bodies readable
        // in daemon.log instead of printing gzip binary.
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(body),
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[RateLimit] Probe succeeded (HTTP ${res.statusCode}) for ${accountId}`);
          // Non-2xx responses don't emit rate_limits_updated from the proxy,
          // so we signal probe-end here for the UI. Successful probes are
          // already covered by the proxy's rate_limits_updated broadcast.
        } else {
          const bodyStr = Buffer.concat(chunks).toString('utf-8').slice(0, 300);
          console.warn(`[RateLimit] Probe HTTP ${res.statusCode} for ${accountId}: ${bodyStr}`);
          ipcServer?.broadcast({ type: 'rate_limits_probe_ended', accountId });
        }
      });
    },
  );
  req.on('error', (err: Error) => {
    console.warn('[RateLimit] Probe error:', err.message);
    ipcServer?.broadcast({ type: 'rate_limits_probe_ended', accountId });
  });
  req.write(body);
  req.end();
}

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
      planType: existingStartupAcct?.planType ?? inferPlanType(activeAccount, null),
      isActive: true,
      createdAt: Date.now(),
    });

    // Remove the old-style row (id = accountUuid) that may have been created
    // before the sentinelKey migration. Only delete it when the new key differs
    // (i.e. orgUuid is non-empty and therefore the key is the orgUuid, not the
    // accountUuid) to avoid deleting the only row for accounts without an org.
    if (startupKey !== activeAccount.accountUuid) {
      deleteAccount(db, activeAccount.accountUuid);
    }
  }

  // Shared token reference — mutated on account switch, read by the proxy
  const activeToken: ActiveToken = { value: null };
  // Shared account-key reference — mutated on switch/refresh, used by proxy for rate limit storage
  const activeAccountId: ActiveAccountId = { value: startupKey ?? 'default' };

  // Seed the active token from keychain on startup
  if (startupCreds) activeToken.value = startupCreds.accessToken;

  const ipcServer = new IpcServer();
  const overageMachine = new OverageStateMachine();
  const otelReceiver = new OtelReceiver(db, activeAccountId);
  const rateLimitStore = new RateLimitStore();

  // In-memory mirror of settings — read at startup, updated on every
  // update_settings call so proxy/auto-switch paths can consult it without
  // re-reading the JSON file per request.
  let currentSettings: Settings = loadSettings();

  // Round-robin token pool. Only consulted when switchingMode === 'round-robin'.
  const tokenRotator = new TokenRotator(db, rateLimitStore, activeAccountId);

  /**
   * Change the active account: update ~/.claude.json, swap the Claude Code
   * keychain slot, inject the new token into the proxy, probe fresh rate
   * limits, upsert the DB row, refresh the rotator pool, and broadcast.
   *
   * Used by the `switch_account` IPC handler AND by the auto-switch module
   * when a utilization threshold is crossed. Returns a serializable result
   * so callers can decide whether to retry or surface the failure.
   */
  function performSwitch(accountId: string, email: string): { success: true; data: OAuthAccount } | { success: false; error: string } {
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

    const realAccountUuid = existingAccount?.accountUuid || existingAccount?.id || accountId || email;

    const switchPlanType: PlanType = existingAccount?.planType ?? inferPlanType(
      { hasExtraUsageEnabled: false, workspaceRole: null } as OAuthAccount,
      creds,
    );

    const oauthAccount: OAuthAccount = {
      accountUuid:           realAccountUuid,
      emailAddress:          email,
      organizationUuid:      existingAccount?.orgUuid ?? '',
      hasExtraUsageEnabled:  switchPlanType === 'max' || switchPlanType === 'enterprise',
      billingType:           creds.subscriptionType ?? 'unknown',
      accountCreatedAt:      new Date().toISOString(),
      subscriptionCreatedAt: new Date().toISOString(),
      displayName:           existingAccount?.displayName ?? '',
      organizationRole:      'user',
      workspaceRole:         (switchPlanType === 'team' || switchPlanType === 'enterprise') ? 'member' : null,
      organizationName:      existingAccount?.orgName ?? '',
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
      console.warn('[Switch] Could not update Claude Code keychain:', err instanceof Error ? err.message : String(err));
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
    });

    tokenRotator.refresh();
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
          respond({ requestType: 'get_credentials', success: false, error: `No credentials stored for ${msg.email}` });
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
        // Return rate limit windows for the active account
        const activeForRl = getActiveAccount();
        const rlKey = activeForRl
          ? sentinelKey(activeForRl.organizationUuid ?? '', activeForRl.accountUuid)
          : 'default';
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
        const events = getOverageEvents(db, { limit: msg.limit ?? 100 });
        respond({ requestType: 'get_overage_events', success: true, data: events });
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
        const active = listAccounts(db);
        const removed = listRemovedAccounts(db);
        const seen = new Set<string>();
        for (const a of [...active, ...removed]) {
          if (!seen.has(a.id)) {
            deleteSentinelCredentials(a.id);
            seen.add(a.id);
          }
          // Cover the legacy case where the entry was keyed by accountUuid
          // (pre-sentinelKey rows) rather than the sentinel id.
          if (a.accountUuid && !seen.has(a.accountUuid)) {
            deleteSentinelCredentials(a.accountUuid);
            seen.add(a.accountUuid);
          }
        }
        console.log(`[Sentinel] Purged ${seen.size} keychain entries.`);
        respond({ requestType: 'purge_all_data', success: true });
        break;
      }

      case 'get_settings': {
        respond({ requestType: 'get_settings', success: true, data: loadSettings() });
        break;
      }

      case 'update_settings': {
        const next = writeSettings(msg.settings);
        currentSettings = next;
        // Mode flipping to round-robin may need a fresh token pool (e.g. new
        // account was just added). Cheap to refresh unconditionally.
        tokenRotator.refresh();
        ipcServer.broadcast({ type: 'settings_changed', settings: next });
        respond({ requestType: 'update_settings', success: true, data: next });
        break;
      }

      case 'get_notifications': {
        const rows = listNotifications(db, { limit: msg.limit ?? 100 });
        respond({ requestType: 'get_notifications', success: true, data: rows });
        break;
      }

      case 'list_alerts': {
        const rows = listAlerts(db, msg.accountId);
        respond({ requestType: 'list_alerts', success: true, data: rows });
        break;
      }

      case 'upsert_alert': {
        if (msg.thresholdPct < 1 || msg.thresholdPct > 99) {
          respond({ requestType: 'upsert_alert', success: false, error: 'thresholdPct must be between 1 and 99' });
          break;
        }
        const saved = upsertAlert(db, {
          ...(msg.id !== undefined ? { id: msg.id } : {}),
          accountId: msg.accountId,
          thresholdPct: msg.thresholdPct,
          enabled: msg.enabled,
        });
        respond({ requestType: 'upsert_alert', success: true, data: saved });
        break;
      }

      case 'delete_alert': {
        const removed = deleteAlert(db, msg.id);
        respond({ requestType: 'delete_alert', success: removed });
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

        startOAuthLogin(abortController.signal)
          .then(({ credentials, email, displayName, accountUuid, orgUuid, orgName, subscriptionType, organizationRole, workspaceRole, hasExtraUsageEnabled }) => {
            loginAbortController = null;
            // Store under sentinelKey so two subscriptions for the same Anthropic user
            // (same accountUuid, different orgUuid) each get their own keychain entry.
            const credKey = sentinelKey(orgUuid, accountUuid) || email;

            // Detect whether the OAuth flow authorized an org the user already
            // had. This happens when the user clicks "Add Account" while their
            // claude.ai browser is still on an org they already added — the
            // token comes back for that same org, not the new one they wanted.
            // We let the write/upsert proceed (refreshes the token harmlessly)
            // and surface the fact to the UI.
            const wasReauth = hasNonPurgedAccount(db, credKey);

            writeSentinelCredentials(credKey, credentials);

            // Build an OAuthAccount record so Claude Code can use this account
            const newAccount: OAuthAccount = {
              accountUuid:          accountUuid || email,
              emailAddress:         email,
              organizationUuid:     orgUuid,
              hasExtraUsageEnabled,
              billingType:          subscriptionType ?? 'unknown',
              accountCreatedAt:     new Date().toISOString(),
              subscriptionCreatedAt: new Date().toISOString(),
              displayName:          displayName,
              organizationRole:     (organizationRole as OAuthAccount['organizationRole']) || 'user',
              workspaceRole:        workspaceRole,
              organizationName:     orgName,
            };

            // If this account was previously soft-deleted, clear the flag so it
            // shows in the active list again. An explicit re-login is user intent.
            reactivateAccount(db, credKey);

            // Upsert into DB using sentinelKey as id so same-UUID accounts in
            // different orgs get separate rows.
            const planType = inferPlanType(newAccount, credentials);
            upsertAccount(db, {
              id:          credKey,
              accountUuid: newAccount.accountUuid,
              email:       newAccount.emailAddress,
              displayName: newAccount.displayName,
              orgUuid:     newAccount.organizationUuid,
              orgName:     newAccount.organizationName,
              planType,
              isActive:    false, // don't switch automatically — let the user choose
              createdAt:   Date.now(),
            });

            // If no active account exists yet, make this one active
            const current = getActiveAccount();
            if (!current) {
              setActiveAccount(newAccount);
              activeToken.value = credentials.accessToken;
            }

            // Freshly added account means a new token is available to
            // round-robin rotation.
            tokenRotator.refresh();

            console.log(`[OAuth] Login complete for ${email} (org: ${orgName || '?'}, reauth: ${wasReauth}), broadcasting to ${ipcServer.connectedClients} client(s)`);
            ipcServer.broadcast({ type: 'login_complete', email, orgName, reauth: wasReauth });
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
            console.log(`[OAuth] Broadcasting login_complete(failure) to ${ipcServer.connectedClients} client(s)`);
            ipcServer.broadcast({ type: 'login_complete', email: '' });
          });
        break;
      }
    }
  });

  // Wire up auto-switch. Safe to register even when mode=off — the handler
  // early-returns based on currentSettings on every rate-limit update.
  startAutoSwitch({
    db,
    rateLimitStore,
    ipcServer,
    getSettings: () => currentSettings,
    getActiveAccount,
    sentinelKey,
    performSwitch,
  });

  // Evaluate user-created alerts on every rate-limit update.
  startAlertEvaluator({
    db,
    rateLimitStore,
    ipcServer,
    getEmailForAccount: (accountId) => {
      const acct = listAccounts(db).find((a) => a.id === accountId);
      return acct?.email ?? null;
    },
  });

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
    },
    (req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/v1/metrics')) {
        return otelReceiver.handleMetrics(req, res);
      }
      return otelReceiver.handleLogs(req, res);
    },
  );

  httpServer.listen(DAEMON_PORT, '127.0.0.1', () => {
    console.log(`[Sentinel] HTTP proxy listening on http://127.0.0.1:${DAEMON_PORT}`);
    // Probe for fresh rate-limit headers through the proxy now that it is ready.
    // The proxy injects the active OAuth token, so this works even for accounts
    // whose tokens cannot be used to call api.anthropic.com directly.
    if (startupKey) {
      probeRateLimits(startupKey, ipcServer);
    }
  });

  // Graceful shutdown
  const shutdown = (server: Server) => {
    console.log('[Sentinel] Shutting down...');
    ipcServer.close();
    server.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown(httpServer));
  process.on('SIGINT', () => shutdown(httpServer));
}
