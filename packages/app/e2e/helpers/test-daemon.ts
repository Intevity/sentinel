/**
 * Spawns all the infra a Playwright test needs:
 *   - fake Anthropic HTTP server
 *   - IPC HTTP bridge (forwards to daemon Unix socket)
 *   - daemon subprocess, pointed at the fake + a throwaway keychain file
 *   - pre-seeded settings (tour + security wizard suppressed)
 *   - optional pre-seeded ~/.claude.json active account
 *
 * Returns the bridge URL (which Vite injects as VITE_E2E_BRIDGE_URL),
 * the fake for mid-test scenario switching, a `waitForBroadcast` helper
 * for awaiting daemon broadcasts, and cleanup hooks. Also includes
 * `startAppHarness()` to boot the Vite dev server with the bridge URL
 * wired in, so specs get both halves with one call.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { startFakeAnthropic, type FakeAnthropic } from '@sentinel/test-harness';
import type { DaemonToAppMessage, OAuthAccount } from '@sentinel/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

/**
 * Test-daemon-shaped account seed. Supplies keychain credentials plus the
 * bits needed to pre-seed ~/.claude.json as the active account and to
 * register the token with the fake so profile fetches resolve.
 */
export interface SeedAccount {
  id: string;
  email: string;
  token: string;
  /** Optional display name. Defaults to local-part of email. */
  displayName?: string;
  /** Optional org UUID. Defaults to id (Sentinel key convention). */
  orgUuid?: string;
}

export interface TestDaemonInit {
  seedAccounts?: SeedAccount[];
  /**
   * When set, writes ~/.claude.json with the matching seed as the active
   * OAuthAccount. Must reference an id present in `seedAccounts`. Used by
   * the switch-account flow to start in a known state.
   */
  seedActiveId?: string;
  /**
   * Enable the start_login openAuthUrl echo seam. When true, the daemon
   * broadcasts `test_oauth_url_opened` whenever a login begins, so tests
   * can extract the PKCE state and POST a synthetic callback without
   * driving a real browser.
   */
  oauthEcho?: boolean;
}

/**
 * Narrow a discriminated union by its `type` tag. Lets `waitForBroadcast`
 * return the exact variant matching the string passed in, so callers can
 * read type-specific fields without casts.
 */
type BroadcastOf<T extends DaemonToAppMessage['type']> = Extract<DaemonToAppMessage, { type: T }>;

export interface TestDaemon {
  bridgeUrl: string;
  fake: FakeAnthropic;
  workDir: string;
  /**
   * Open an SSE stream to the bridge and resolve with the first broadcast
   * matching `type` (and `predicate`, if supplied). Rejects on timeout.
   * The stream is closed before resolving/rejecting so no subscriber is
   * left dangling after the wait completes.
   */
  waitForBroadcast<T extends DaemonToAppMessage['type']>(
    type: T,
    predicate?: (msg: BroadcastOf<T>) => boolean,
    timeoutMs?: number,
  ): Promise<BroadcastOf<T>>;
  stop(): Promise<void>;
}

export async function startTestDaemon(init: TestDaemonInit = {}): Promise<TestDaemon> {
  const workDir = mkdtempSync(join(tmpdir(), 'sentinel-e2e-'));
  const keychainFile = join(workDir, 'keychain.json');
  const settingsFile = join(workDir, 'settings.json');
  const claudeJsonFile = join(workDir, '.claude.json');
  // Daemon resolves ~/.sentinel via homedir(), which Node reads from HOME.
  // Set HOME=workDir so the daemon places its socket and DB under workDir.
  const sentinelDir = join(workDir, '.sentinel');
  const socketPath = join(sentinelDir, 'daemon.sock');

  // Pre-seed: full DEFAULT_SETTINGS shape with tour + wizard flipped off
  // so the first-run modals never mount. Mirrors the coerce() expectations
  // in settings.ts — partial writes would work too, but the full shape
  // is the more durable contract against sprint drift.
  //
  // The actual write happens below, AFTER the keychain is seeded: since the
  // settings-integrity sprint, settings.json must be mode 0o600 and carry a
  // valid HMAC sidecar (.sig) or loadSettings falls back to defaults — which
  // re-enables the tour and its overlay swallows every click in the specs.
  // Signing needs the HMAC key in the same test keychain the daemon reads.
  const seedSettings = JSON.stringify(
    {
      launchAtLogin: false,
      switchingMode: 'off',
      alertSoundName: 'Glass',
      overageOsNotify: false,
      autoUpdate: false,
      poolExcludedIds: [],
      overageEnabledIds: [],
      budgetWeeklyUsdByAccount: {},
      budgetWeeklyUsdGlobal: null,
      overageBufferPct: 5,
      roundRobinStrategy: 'balance',
      backgroundProbeIntervalSec: 300,
      telemetryRetentionDays: 30,
      securityScanEnabled: true,
      securityEnforcementMode: null,
      securityScanSecrets: true,
      securityScanInjection: false,
      securityScanToolUse: true,
      securityOsNotifyThreshold: 'off',
      securityPersistSnippet: true,
      securityEventRetentionDays: 30,
      securityApproveHoldSec: 60,
      toolPermissionsEnabled: false,
      toolPermissionDefaultAction: 'allow',
      toolPermissionSkipInAutoMode: true,
      toolPermissionAutoModeActive: false,
      securityOversizedThresholdMb: 4,
      securityScanOversizedSync: false,
      securityMuteScanDeferred: false,
      securityMuteScanTruncated: false,
      securityMuteScanSkipped: false,
      lastScanBenchmark: null,
      claudeCodeSyncEnabled: false,
      logLevel: 'info',
      requestLoggingEnabled: false,
      requestLogRetentionDays: 7,
      requestLogMaxBodyKb: 256,
      requestLogCaptureResponse: true,
      requestLogRedactAuthHeaders: true,
      cacheTtlForceOneHour: false,
      securitySetupCompleted: true,
      tourCompleted: true,
    },
    null,
    2,
  );

  writeFileSync(keychainFile, JSON.stringify({ 'Sentinel-credentials': {} }));

  const fake = await startFakeAnthropic();
  const seeds = init.seedAccounts ?? [];
  for (const a of seeds) {
    // Always stamp org_uuid on the registered profile — the daemon's
    // startup-drift-realign path compares the token's profile org_uuid
    // against the ~/.claude.json oauthAccount.organizationUuid and
    // "soft-removes" any mismatch. Default to the seed id so callers
    // don't have to think about it.
    const resolvedOrgUuid = a.orgUuid ?? a.id;
    fake.registerToken(a.token, {
      email: a.email,
      uuid: a.id,
      org_uuid: resolvedOrgUuid,
      ...(a.displayName ? { display_name: a.displayName } : {}),
    });
    // Pre-populate keychain so list_accounts sees them.
    const existing = JSON.parse(readFileSync(keychainFile, 'utf-8')) as Record<
      string,
      Record<string, string>
    >;
    if (!existing['Sentinel-credentials']) existing['Sentinel-credentials'] = {};
    existing['Sentinel-credentials']![a.id] = JSON.stringify({
      accessToken: a.token,
      refreshToken: `refresh-${a.id}`,
      expiresAt: Date.now() + 3600_000,
      scopes: ['user:profile', 'user:inference'],
    });
    writeFileSync(keychainFile, JSON.stringify(existing, null, 2));
  }

  // Pre-seed ~/.claude.json's oauthAccount when the caller names an active seed.
  // Required for the switch-account flow to start in a known state, and for
  // any spec that asserts the daemon recognizes the right account on boot.
  if (init.seedActiveId) {
    const active = seeds.find((s) => s.id === init.seedActiveId);
    if (!active) {
      throw new Error(`seedActiveId=${init.seedActiveId} does not match any entry in seedAccounts`);
    }
    const oauthAccount: OAuthAccount = {
      accountUuid: active.id,
      emailAddress: active.email,
      organizationUuid: active.orgUuid ?? active.id,
      hasExtraUsageEnabled: false,
      billingType: 'claude_max',
      accountCreatedAt: new Date().toISOString(),
      subscriptionCreatedAt: new Date().toISOString(),
      displayName: active.displayName ?? active.email.split('@')[0] ?? active.email,
      organizationRole: 'owner',
      workspaceRole: null,
      organizationName: active.displayName ?? active.email,
    };
    writeFileSync(claudeJsonFile, JSON.stringify({ oauthAccount }, null, 2));
  }

  // Write + sign the settings seed (see comment at `seedSettings`). The
  // daemon's own settings-integrity module does the signing so the HMAC
  // format can never drift from what loadSettings verifies. Imported by
  // path (like daemonBin below) — the app package doesn't depend on the
  // daemon package. The env var must point at this run's keychain BEFORE
  // signing so getOrCreateSettingsHmacKey writes the key where the daemon
  // subprocess will read it; the cache reset drops any key cached from a
  // previous startTestDaemon call in this worker.
  process.env.SENTINEL_TEST_KEYCHAIN_FILE = keychainFile;
  const { resetSettingsHmacKeyCache, signSettings } = (await import(
    pathToFileURL(resolve(REPO_ROOT, 'packages/daemon/dist/settings-integrity.js')).href
  )) as {
    resetSettingsHmacKeyCache: () => void;
    signSettings: (bytes: string) => string;
  };
  resetSettingsHmacKeyCache();
  writeFileSync(settingsFile, seedSettings);
  writeFileSync(`${settingsFile}.sig`, signSettings(seedSettings));
  chmodSync(settingsFile, 0o600);
  chmodSync(`${settingsFile}.sig`, 0o600);

  // Ephemeral daemon port so the test daemon doesn't collide with the
  // user's live desktop app (which binds 47284). Sprint 6's getDaemonPort
  // honors this env var and production leaves it unset.
  const daemonPort = await pickFreePort();

  const daemonBin = resolve(REPO_ROOT, 'packages/daemon/dist/cli.js');
  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_UPSTREAM_URL: fake.origin,
    OAUTH_TOKEN_URL: fake.tokenUrl,
    OAUTH_AUTH_URL: fake.authUrl,
    SENTINEL_TEST_KEYCHAIN_FILE: keychainFile,
    SENTINEL_TEST_SETTINGS_FILE: settingsFile,
    SENTINEL_TEST_DAEMON_PORT: String(daemonPort),
    HOME: workDir,
    ...(init.oauthEcho ? { SENTINEL_TEST_OAUTH_ECHO: '1' } : {}),
  };

  const daemon = spawn('node', [daemonBin], {
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Tee daemon output so test failures can inspect what happened. E2E
  // daemon logs are otherwise invisible (the daemon runs as a child
  // process and its stdout is piped nowhere).
  if (process.env.E2E_DAEMON_DEBUG) {
    daemon.stdout!.on('data', (b) => process.stderr.write(`[daemon] ${b}`));
    daemon.stderr!.on('data', (b) => process.stderr.write(`[daemon err] ${b}`));
  }

  await waitForSocket(socketPath, 5000);

  // Seed non-active accounts directly into SQLite. The daemon only upserts
  // the active account (from ~/.claude.json) at startup; additional seeds
  // that live only in the keychain wouldn't otherwise show up in the UI.
  // Better-sqlite3 + WAL mode lets us write while the daemon has the DB
  // open. The daemon's own INSERT on the active account races us, which
  // is fine — we use the `id` conflict clause it uses.
  if (seeds.length > 1 || (seeds.length === 1 && !init.seedActiveId)) {
    const dbPath = join(sentinelDir, 'sentinel.db');
    // Wait briefly for the daemon to create the DB file and tables.
    await waitForFile(dbPath, 5000);
    const now = Date.now();
    const db = new Database(dbPath);
    try {
      db.pragma('journal_mode = WAL');
      const stmt = db.prepare(
        `INSERT INTO accounts (id, account_uuid, email, display_name, org_uuid, org_name, plan_type, created_at)
         VALUES (@id, @accountUuid, @email, @displayName, @orgUuid, @orgName, @planType, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           account_uuid = excluded.account_uuid,
           email        = excluded.email,
           display_name = excluded.display_name,
           org_uuid     = excluded.org_uuid,
           org_name     = excluded.org_name,
           plan_type    = excluded.plan_type`,
      );
      for (const a of seeds) {
        stmt.run({
          id: a.id,
          accountUuid: a.id,
          email: a.email,
          displayName: a.displayName ?? a.email.split('@')[0] ?? a.email,
          orgUuid: a.orgUuid ?? a.id,
          orgName: a.displayName ?? a.email,
          planType: 'max',
          createdAt: now,
        });
      }
    } finally {
      db.close();
    }
  }

  const bridgeScript = resolve(__dirname, 'ipc-http-bridge.mjs');
  const { port, proc: bridge } = await startBridge(bridgeScript, socketPath);
  const bridgeUrl = `http://127.0.0.1:${port}/`;

  const td: TestDaemon = {
    bridgeUrl,
    fake,
    workDir,
    waitForBroadcast(type, predicate, timeoutMs = 5000) {
      return waitForBroadcast(bridgeUrl, type, predicate, timeoutMs);
    },
    async stop() {
      daemon.kill('SIGTERM');
      bridge.kill('SIGTERM');
      // Wait briefly for daemon exit so port 47285 (OAuth callback) is
      // released before the next spec file starts its own daemon. Without
      // this, consecutive spec files race each other for the fixed port.
      await Promise.race([
        new Promise<void>((r) => daemon.once('exit', () => r())),
        new Promise<void>((r) => setTimeout(r, 3000)),
      ]);
      await fake.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
  return td;
}

/**
 * Grab an OS-chosen free TCP port. Racing against something that binds in
 * the window between close and the daemon's own listen is a theoretical
 * flake; practically it never happens on a test host.
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolveP(port));
      } else {
        srv.close();
        reject(new Error('could not read ephemeral port address'));
      }
    });
  });
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`daemon socket ${path} did not appear within ${timeoutMs}ms`);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`file ${path} did not appear within ${timeoutMs}ms`);
}

async function startBridge(
  scriptPath: string,
  socketPath: string,
): Promise<{ port: number; proc: ChildProcess }> {
  return new Promise((resolveP, reject) => {
    const proc = spawn('node', [scriptPath], {
      env: { ...process.env, DAEMON_SOCKET: socketPath, BRIDGE_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    proc.stdout!.on('data', (buf: Buffer) => {
      const line = buf.toString();
      const m = line.match(/bridge-listening port=(\d+)/);
      if (m && !settled) {
        settled = true;
        resolveP({ port: Number(m[1]), proc });
      }
    });
    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('bridge did not announce port within 5s'));
      }
    }, 5000);
  });
}

/**
 * Open the bridge's SSE endpoint, scan incoming frames, resolve with the
 * first one whose `type` matches. The stream is closed on resolve/reject.
 * Used by every flow spec that asserts on a daemon broadcast.
 */
async function waitForBroadcast<T extends DaemonToAppMessage['type']>(
  bridgeUrl: string,
  type: T,
  predicate: ((msg: BroadcastOf<T>) => boolean) | undefined,
  timeoutMs: number,
): Promise<BroadcastOf<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL('events', bridgeUrl).toString(), {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.body) {
      throw new Error('bridge /events returned no body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error(`SSE stream closed before broadcast ${type} arrived`);
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines.
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(line.slice(6)) as DaemonToAppMessage;
            if (parsed.type === type) {
              const narrowed = parsed as BroadcastOf<T>;
              if (!predicate || predicate(narrowed)) {
                controller.abort();
                return narrowed;
              }
            }
          } catch {
            // Malformed — skip.
          }
        }
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// ─── App harness ─────────────────────────────────────────────────────────────

export interface AppHarness {
  viteUrl: string;
  stop(): Promise<void>;
}

/**
 * Boot the Vite dev server wired to the given bridge URL. Returns the live
 * URL and a stop function. Specs call this in beforeAll after the daemon is
 * up. Factored out of smoke.spec.ts so each flow spec is a one-liner.
 *
 * We invoke `node_modules/.bin/vite` directly instead of via `pnpm exec`
 * — pnpm's intermediate process does not forward SIGTERM reliably, so
 * killing the returned ChildProcess leaves orphaned Vite servers on
 * port 5173 between runs.
 */
export async function startAppHarness(bridgeUrl: string): Promise<AppHarness> {
  const appDir = resolve(REPO_ROOT, 'packages/app');
  const viteBin = resolve(appDir, 'node_modules/.bin/vite');
  const vite = spawn(viteBin, ['--port', '5173', '--strictPort', '--host', '127.0.0.1'], {
    cwd: appDir,
    env: {
      ...process.env,
      VITE_E2E: 'true',
      VITE_E2E_BRIDGE_URL: bridgeUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    await new Promise<void>((resolveWait, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `vite did not start within 15s. stdout: ${stdoutBuf.join('')} | stderr: ${stderrBuf.join('')}`,
            ),
          ),
        15000,
      );
      const onData = (buf: Buffer): void => {
        const s = buf.toString();
        stdoutBuf.push(s);
        // Vite colorizes its ready banner with ANSI escapes that split
        // "localhost:5173" into fragments. Strip the escapes before
        // matching so the phrase survives pipe redirection.
        // eslint-disable-next-line no-control-regex
        const stripped = stdoutBuf.join('').replace(/\[[0-9;]*m/g, '');
        if (stripped.includes('ready in') || stripped.includes('localhost:5173')) {
          clearTimeout(timer);
          vite.stdout!.off('data', onData);
          resolveWait();
        }
      };
      vite.stdout!.on('data', onData);
      vite.stderr!.on('data', (buf: Buffer) => {
        const s = buf.toString();
        stderrBuf.push(s);
        if (s.includes('already in use')) {
          clearTimeout(timer);
          reject(new Error(`vite refused to bind 5173: ${s.trim()}`));
        }
      });
      vite.once('exit', (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `vite exited with code ${code}. stdout: ${stdoutBuf.join('')} | stderr: ${stderrBuf.join('')}`,
          ),
        );
      });
    });
  } catch (err) {
    // Don't leak the child on failure — otherwise the next spec file will
    // hit "port 5173 already in use" and waste 15s timing out.
    vite.kill('SIGTERM');
    throw err;
  }

  return {
    viteUrl: 'http://127.0.0.1:5173',
    async stop() {
      vite.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((r) => vite.once('exit', () => r())),
        new Promise<void>((r) => setTimeout(r, 3000)),
      ]);
    },
  };
}
