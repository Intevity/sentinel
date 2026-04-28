/**
 * Shared infrastructure for proxy integration tests. Replaces the
 * `vi.mock('https')` pattern by wiring a real `createProxyServer` to the
 * fake Anthropic listener from `@claude-sentinel/test-harness`.
 *
 * The helpers intentionally stop short of being a single do-everything
 * factory: tests vary in how much of the dep graph they need. Instead,
 * this module exposes a layered toolkit:
 *
 *   1. `makeTestDbPath()` / `listenEphemeral()` — tiny primitives.
 *   2. `makeCapturingIpc()` — real `IpcServer`-shaped object that records
 *      every broadcast for assertions without spinning up the real
 *      Unix-socket listener.
 *   3. `buildRealOtelHandler(db)` — the production `OtelReceiver` wired
 *      to a test db, exposed as the callback `createProxyServer` expects.
 *   4. `buildRealSecurityScanner(...)` — production `createSecurityScanner`
 *      with a test-scoped settings file so detector rules are real.
 *   5. `startProxyWithFake(opts)` — convenience that composes all of the
 *      above and returns a handle suitable for most request-path tests.
 *
 * All of these functions default `process.env.ANTHROPIC_UPSTREAM_URL` to
 * the fake's origin and set `CLAUDE_SENTINEL_TEST_SETTINGS_FILE` to an
 * isolated tmp file so tests don't read the running user's real settings.
 */

import type { IncomingMessage, Server, ServerResponse } from 'http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import type {
  DaemonToAppMessage,
  Settings,
  AppToDaemonMessage,
  IpcResponse,
} from '@claude-sentinel/shared';
import type { Database } from 'better-sqlite3';
import {
  startFakeAnthropic,
  type FakeAnthropic,
  type ScenarioName,
} from '@claude-sentinel/test-harness';
import {
  createProxyServer,
  type ActiveAccountId,
  type ActiveToken,
  type TokenSelection,
} from './proxy.js';
import { getDb, closeDb, upsertAccount } from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import { RequestAccountMap } from './request-account-map.js';
import { OtelReceiver } from './otel-receiver.js';
import { createSecurityScanner, type SecurityScanner } from './security/scanner.js';
import {
  createPermissionsEnforcer,
  type PermissionsEnforcer,
} from './security/permissions/enforcer.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings.js';
import type { IpcServer } from './ipc.js';
import { OverageStateMachine } from './overage.js';
import type { PauseReason } from '@claude-sentinel/shared';

/** Per-test capture of every `ipcServer.broadcast()` call. */
export interface CapturingIpcServer extends IpcServer {
  broadcasts: DaemonToAppMessage[];
}

export function makeCapturingIpc(): CapturingIpcServer {
  const broadcasts: DaemonToAppMessage[] = [];
  const ipc: CapturingIpcServer = {
    broadcasts,
    broadcast(message: DaemonToAppMessage) {
      broadcasts.push(message);
    },
    onMessage(_handler: (msg: AppToDaemonMessage, respond: (r: IpcResponse) => void) => void) {
      /* not used by proxy tests */
    },
    start() {
      /* no-op: tests never connect real clients */
    },
    close() {
      /* no-op */
    },
    get connectedClients(): number {
      return 0;
    },
  } as unknown as CapturingIpcServer;
  return ipc;
}

/** Build a unique on-disk DB path under the system temp dir. */
export function makeTestDbPath(prefix = 'proxy-test'): string {
  return join(tmpdir(), `sentinel-${prefix}-${randomUUID()}.db`);
}

/** Listen on an ephemeral port; resolve with the assigned port. */
export function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
    });
  });
}

/** Wire the production OtelReceiver up to the caller's test db and return
 *  the function shape `createProxyServer` wants. */
export function buildRealOtelHandler(
  db: Database,
  opts?: {
    activeAccountId?: ActiveAccountId;
    ipcServer?: IpcServer;
    requestAccountMap?: RequestAccountMap;
  },
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const receiver = new OtelReceiver(
    db,
    opts?.activeAccountId,
    opts?.ipcServer,
    opts?.requestAccountMap,
  );
  return async (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/v1/metrics')) {
      await receiver.handleMetrics(req, res);
      return;
    }
    if (url.startsWith('/v1/logs')) {
      await receiver.handleLogs(req, res);
      return;
    }
    /* v8 ignore next 2 */
    res.writeHead(404);
    res.end();
  };
}

/** Write a settings file to an isolated tmp path and point the settings
 *  module at it for the lifetime of the test. Returns the settings path
 *  and a cleanup that restores the previous env. */
export function seedTestSettings(overrides: Partial<Settings> = {}): {
  settingsPath: string;
  cleanup: () => void;
} {
  const settingsPath = join(tmpdir(), `sentinel-settings-${randomUUID()}.json`);
  saveSettings({ ...DEFAULT_SETTINGS, ...overrides }, settingsPath);
  const previous = process.env.CLAUDE_SENTINEL_TEST_SETTINGS_FILE;
  process.env.CLAUDE_SENTINEL_TEST_SETTINGS_FILE = settingsPath;
  return {
    settingsPath,
    cleanup: () => {
      if (previous === undefined) delete process.env.CLAUDE_SENTINEL_TEST_SETTINGS_FILE;
      else process.env.CLAUDE_SENTINEL_TEST_SETTINGS_FILE = previous;
      if (existsSync(settingsPath)) unlinkSync(settingsPath);
    },
  };
}

/** Write the given settings to the active test settings file. Useful for
 *  toggling mid-test when `seedTestSettings` is already set up. */
export function patchTestSettings(overrides: Partial<Settings>): void {
  const path = process.env.CLAUDE_SENTINEL_TEST_SETTINGS_FILE;
  if (!path) throw new Error('patchTestSettings called before seedTestSettings');
  saveSettings({ ...DEFAULT_SETTINGS, ...overrides }, path);
}

/** Instantiate the real `SecurityScanner` against a test db + settings
 *  function. Callers pass `getSettings` so tests can flip enforcement mode
 *  without hitting disk. */
export function buildRealSecurityScanner(
  db: Database,
  ipcServer: IpcServer,
  getSettings: () => Settings,
): SecurityScanner {
  return createSecurityScanner({ db, ipcServer, getSettings });
}

export interface StartProxyOpts {
  /** Seeded scenario on the fake's `/v1/messages` responses. */
  scenario?: ScenarioName;
  /** Register one or more Bearer tokens on the fake. Defaults to a single
   *  token `integration-token` the helper also wires into `activeToken`. */
  tokens?: string[];
  /** Upsert these accounts into the test db and seed the active-account
   *  ref with the first one. Defaults to a single account `acct-int`. */
  accounts?: Array<{ id: string; email: string; token?: string }>;
  /** Partial settings — merged with DEFAULT_SETTINGS before writing the
   *  isolated test settings file. */
  settings?: Partial<Settings>;
  /** When true, wires a real SecurityScanner and includes it in proxy opts.
   *  Set this per-test when the test needs scanner behavior. */
  enableSecurityScanner?: boolean;
  /** When true, wires a real PermissionsEnforcer and includes it in proxy
   *  opts. Tests that need to assert on tool-permission outbound stripping
   *  or response-side tool_use interception should set this. The enforcer
   *  is exposed on the returned `StartedProxy` so tests can call
   *  `enforcer.invalidate()` after seeding rules into the db. */
  enablePermissionsEnforcer?: boolean;
  /** When set, overrides the default tokenProvider (round-robin). The
   *  helper's default tokenProvider returns null (fallback to activeToken). */
  tokenProvider?: (ctx?: { isSonnet: boolean }) => TokenSelection | null;
  /** Live accessors — wired straight into `createProxyServer`. */
  getPausedAccountIds?: () => ReadonlySet<string>;
  getPauseReason?: (accountId: string) => PauseReason | null;
  getSessionResetAt?: (accountId: string) => number | null;
  getWeeklyResetAt?: (accountId: string) => number | null;
  getOverageAllowedIds?: () => ReadonlySet<string>;
  getOverageBufferPct?: () => number;
  /** When set, overrides the default `overageMachine`. Tests that want to
   *  inspect transition events directly pass their own. */
  overageMachine?: OverageStateMachine;
  /** Callback fired when upstream returns 401 for an identified account.
   *  Wired into ProxyOptions.onUpstreamAuthFailure. */
  onUpstreamAuthFailure?: (accountId: string) => void;
}

export interface StartedProxy {
  fake: FakeAnthropic;
  proxy: Server;
  proxyPort: number;
  db: Database;
  dbPath: string;
  ipcServer: CapturingIpcServer;
  rateLimitStore: RateLimitStore;
  requestAccountMap: RequestAccountMap;
  activeToken: ActiveToken;
  activeAccountId: ActiveAccountId;
  settingsPath: string;
  /** Present when `enableSecurityScanner: true` was passed. Tests that need
   *  to resolve pending held-blocks (approve/deny) reach for this. */
  scanner?: SecurityScanner;
  /** Present when `enablePermissionsEnforcer: true` was passed. Tests
   *  insert/upsert permission rules directly into `db` and then call
   *  `enforcer.invalidate()` to refresh the compiled cache. */
  enforcer?: PermissionsEnforcer;
  cleanup: () => Promise<void>;
}

const DEFAULT_TOKEN = 'integration-token';
const DEFAULT_ACCOUNT_ID = 'acct-int';

/** High-level convenience: starts a fake, seeds a db, builds the proxy,
 *  and listens on an ephemeral port. Returns everything a test needs to
 *  exercise the proxy end-to-end. Call `cleanup()` in `afterEach`. */
export async function startProxyWithFake(opts: StartProxyOpts = {}): Promise<StartedProxy> {
  const fake = await startFakeAnthropic(opts.scenario ? { scenario: opts.scenario } : {});
  const tokens = opts.tokens ?? [DEFAULT_TOKEN];
  for (const t of tokens) fake.registerToken(t);

  const previousUpstream = process.env.ANTHROPIC_UPSTREAM_URL;
  process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;

  const { settingsPath, cleanup: cleanupSettings } = seedTestSettings(opts.settings);

  const dbPath = makeTestDbPath();
  const db = getDb(dbPath);

  const accounts =
    opts.accounts ??
    ([{ id: DEFAULT_ACCOUNT_ID, email: 'int@example.com', token: DEFAULT_TOKEN }] as Array<{
      id: string;
      email: string;
      token?: string;
    }>);
  for (const acct of accounts) {
    upsertAccount(db, {
      id: acct.id,
      accountUuid: acct.id,
      email: acct.email,
      displayName: acct.email.split('@')[0] ?? acct.email,
      orgUuid: '',
      orgName: '',
      planType: 'max',
      isActive: true,
      createdAt: Date.now(),
      color: null,
    });
  }

  const ipcServer = makeCapturingIpc();
  const rateLimitStore = new RateLimitStore();
  const requestAccountMap = new RequestAccountMap();

  const firstAcct = accounts[0];
  if (!firstAcct) {
    throw new Error('startProxyWithFake: at least one account required');
  }
  const activeToken: ActiveToken = { value: firstAcct.token ?? tokens[0] ?? DEFAULT_TOKEN };
  const activeAccountId: ActiveAccountId = { value: firstAcct.id };

  // Read fresh each call so `patchTestSettings` takes effect without
  // rebuilding the scanner. loadSettings honors CLAUDE_SENTINEL_TEST_SETTINGS_FILE.
  const getSettings = (): Settings => loadSettings();

  const securityScanner: SecurityScanner | undefined = opts.enableSecurityScanner
    ? buildRealSecurityScanner(db, ipcServer, getSettings)
    : undefined;

  const permissionsEnforcer: PermissionsEnforcer | undefined = opts.enablePermissionsEnforcer
    ? createPermissionsEnforcer({ db, ipcServer, getSettings })
    : undefined;

  const otelHandler = buildRealOtelHandler(db, {
    activeAccountId,
    ipcServer,
    requestAccountMap,
  });

  // exactOptionalPropertyTypes forbids passing `field: undefined` where the
  // target declares `field?: T`; build the options object and omit unset keys.
  const proxyOpts: Parameters<typeof createProxyServer>[0] = {
    db,
    ipcServer,
    activeToken,
    activeAccountId,
    rateLimitStore,
    requestAccountMap,
  };
  if (opts.tokenProvider) proxyOpts.tokenProvider = opts.tokenProvider;
  if (opts.getPausedAccountIds) proxyOpts.getPausedAccountIds = opts.getPausedAccountIds;
  if (opts.getPauseReason) proxyOpts.getPauseReason = opts.getPauseReason;
  if (opts.getSessionResetAt) proxyOpts.getSessionResetAt = opts.getSessionResetAt;
  if (opts.getWeeklyResetAt) proxyOpts.getWeeklyResetAt = opts.getWeeklyResetAt;
  if (opts.getOverageAllowedIds) proxyOpts.getOverageAllowedIds = opts.getOverageAllowedIds;
  if (opts.getOverageBufferPct) proxyOpts.getOverageBufferPct = opts.getOverageBufferPct;
  if (opts.overageMachine) proxyOpts.overageMachine = opts.overageMachine;
  if (opts.onUpstreamAuthFailure) proxyOpts.onUpstreamAuthFailure = opts.onUpstreamAuthFailure;
  if (securityScanner) proxyOpts.securityScanner = securityScanner;
  if (permissionsEnforcer) proxyOpts.permissionsEnforcer = permissionsEnforcer;

  const proxy = createProxyServer(proxyOpts, otelHandler);
  const proxyPort = await listenEphemeral(proxy);

  const cleanup = async (): Promise<void> => {
    // Idempotent: tests that intentionally close the fake or proxy early
    // (e.g. to simulate ECONNREFUSED) must still be able to call cleanup.
    await new Promise<void>((resolve) => {
      try {
        proxy.close(() => resolve());
      } catch {
        resolve();
      }
    });
    try {
      await fake.close();
    } catch {
      /* already closed */
    }
    // Stop any timers the enforcer started (process-poll, auto-mode
    // freshness deactivation) so the test runner exits cleanly.
    permissionsEnforcer?.shutdown();
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    cleanupSettings();
    if (previousUpstream === undefined) delete process.env.ANTHROPIC_UPSTREAM_URL;
    else process.env.ANTHROPIC_UPSTREAM_URL = previousUpstream;
  };

  const started: StartedProxy = {
    fake,
    proxy,
    proxyPort,
    db,
    dbPath,
    ipcServer,
    rateLimitStore,
    requestAccountMap,
    activeToken,
    activeAccountId,
    settingsPath,
    cleanup,
  };
  if (securityScanner) started.scanner = securityScanner;
  if (permissionsEnforcer) started.enforcer = permissionsEnforcer;
  return started;
}

/** Convenience: issue a POST against the started proxy. */
export async function postThroughProxy(
  port: number,
  path: string,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer client-supplied',
      ...(init.headers ?? {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Convenience: GET against the started proxy. */
export async function getThroughProxy(
  port: number,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'GET', ...init });
}

/** Write a JSON file to an arbitrary tmp path (used by tests that need to
 *  seed something outside the settings file). Returns a cleanup fn. */
export function writeTmpJson(obj: unknown): { path: string; cleanup: () => void } {
  const path = join(tmpdir(), `sentinel-tmp-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(obj), 'utf-8');
  return {
    path,
    cleanup: () => {
      if (existsSync(path)) unlinkSync(path);
    },
  };
}
