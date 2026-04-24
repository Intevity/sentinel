/**
 * Integration-test harness for `index.ts`. Boots the real daemon in-process
 * against a fake Anthropic upstream, a tmp SQLite database, a tmp keychain
 * file, a tmp settings file, and a tmp Unix socket. Connects an `IpcClient`
 * to the daemon's socket so tests drive the full IPC dispatch path — same
 * code the production Tauri app uses.
 *
 * Mirrors the shape of `proxy.test-helpers.ts::startProxyWithFake`; primary
 * difference is that this harness starts the entire daemon (not just the
 * proxy) and connects a real IPC client instead of stubbing it.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { startFakeAnthropic, type FakeAnthropic } from '@claude-sentinel/test-harness';
import type {
  AppToDaemonMessage,
  ClaudeCodeCredentials,
  ClaudeState,
  DaemonToAppMessage,
  IpcResponse,
  Settings,
} from '@claude-sentinel/shared';
import { startDaemon, type DaemonHandle } from './index.js';
import { IpcClient } from './ipc.js';

/** Shape of the test keychain JSON file read/written by accounts.ts in
 *  test mode. Top level keys are service names ('Claude Sentinel-credentials',
 *  'Claude Code-credentials'); inner keys are account identifiers. */
export interface TestKeychain {
  [service: string]: { [account: string]: string };
}

export interface StartTestDaemonOptions {
  /** Pre-seeded ~/.claude.json. Useful for giving the daemon a preselected
   *  active account at boot. */
  claudeState?: ClaudeState;
  /** Pre-seeded ~/.claude-sentinel/settings.json (merged onto DEFAULT_SETTINGS
   *  by the loader). */
  settings?: Partial<Settings>;
  /** Pre-seeded Sentinel credentials, keyed by sentinel key (orgUuid || accountUuid).
   *  Written into the tmp keychain file under the 'Claude Sentinel-credentials'
   *  service so `readSentinelCredentials(key)` resolves. */
  sentinelCredentials?: Record<string, ClaudeCodeCredentials>;
  /** Pre-seeded Claude Code credentials, keyed by OS username. Written under
   *  'Claude Code-credentials' so `readActiveCredentials()` finds them on the
   *  active-account fallback path. */
  claudeCodeCredentials?: Record<string, ClaudeCodeCredentials>;
  /** Scenario to arm the fake Anthropic server with. Default: no scenario
   *  override (healthy upstream). */
  scenario?: Parameters<typeof startFakeAnthropic>[0] extends { scenario?: infer S } ? S : never;
  /** Access tokens to pre-register with the fake so `/v1/messages` and
   *  `/api/oauth/profile` return 200 instead of 401 for them. */
  registerTokens?: string[];
}

export interface TestDaemon {
  fake: FakeAnthropic;
  handle: DaemonHandle;
  ipcClient: IpcClient;
  /** Broadcasts pushed from daemon → clients, in arrival order. */
  broadcasts: DaemonToAppMessage[];
  /** Send an `AppToDaemonMessage` and await the matching `IpcResponse`. Uses
   *  FIFO-by-requestType correlation; tests should not issue two in-flight
   *  requests of the same type against a single test daemon. */
  request: <T = unknown>(msg: AppToDaemonMessage) => Promise<IpcResponse<T>>;
  /** Wait up to `timeoutMs` for at least one broadcast matching `predicate`.
   *  Returns the matched broadcast, or rejects on timeout. */
  waitForBroadcast: <T extends DaemonToAppMessage = DaemonToAppMessage>(
    predicate: (msg: DaemonToAppMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<T>;
  dbPath: string;
  requestLogDbPath: string;
  socketPath: string;
  keychainPath: string;
  settingsPath: string;
  claudeJsonPath: string;
  daemonPort: number;
  workdir: string;
  cleanup: () => Promise<void>;
}

/** Find a free TCP port on 127.0.0.1 by asking the OS to assign one. */
async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no port assigned')));
      }
    });
  });
}

/** Keys written to process.env by startTestDaemon. Deleted on cleanup. */
const TEST_ENV_KEYS = [
  'CLAUDE_SENTINEL_TEST_DB_FILE',
  'CLAUDE_SENTINEL_TEST_REQUEST_LOG_DB_FILE',
  'CLAUDE_SENTINEL_TEST_CLAUDE_JSON',
  'CLAUDE_SENTINEL_TEST_SETTINGS_FILE',
  'CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE',
  'CLAUDE_SENTINEL_TEST_IPC_SOCKET',
  'CLAUDE_SENTINEL_TEST_DAEMON_PORT',
  'ANTHROPIC_UPSTREAM_URL',
  'OAUTH_TOKEN_URL',
  'OAUTH_AUTH_URL',
];

export async function startTestDaemon(opts: StartTestDaemonOptions = {}): Promise<TestDaemon> {
  const workdir = mkdtempSync(join(tmpdir(), `sentinel-it-${randomUUID().slice(0, 8)}-`));
  const dbPath = join(workdir, 'sentinel.db');
  const requestLogDbPath = join(workdir, 'request-logs.db');
  const claudeJsonPath = join(workdir, 'claude.json');
  const settingsPath = join(workdir, 'settings.json');
  const keychainPath = join(workdir, 'keychain.json');
  // Short socket name — macOS caps AF_UNIX paths at ~104 chars, and tmpdir()
  // plus a UUID prefix leave limited room.
  const socketPath = join(workdir, 'd.sock');

  // Seed files BEFORE the daemon reads them.
  writeFileSync(claudeJsonPath, JSON.stringify(opts.claudeState ?? {}, null, 2));
  writeFileSync(settingsPath, JSON.stringify(opts.settings ?? {}, null, 2));
  const keychain: TestKeychain = {};
  if (opts.sentinelCredentials) {
    keychain['Claude Sentinel-credentials'] = {};
    for (const [key, creds] of Object.entries(opts.sentinelCredentials)) {
      keychain['Claude Sentinel-credentials'][key] = JSON.stringify(creds);
    }
  }
  if (opts.claudeCodeCredentials) {
    keychain['Claude Code-credentials'] = {};
    for (const [user, creds] of Object.entries(opts.claudeCodeCredentials)) {
      keychain['Claude Code-credentials'][user] = JSON.stringify({ claudeAiOauth: creds });
    }
  }
  writeFileSync(keychainPath, JSON.stringify(keychain, null, 2));

  const daemonPort = await pickFreePort();

  // Fake Anthropic must be up before startDaemon's startup probe runs.
  const fake = await startFakeAnthropic(opts.scenario ? { scenario: opts.scenario } : {});
  for (const t of opts.registerTokens ?? []) fake.registerToken(t);

  // Set env seams. These must be in place before startDaemon() imports
  // resolve call-time defaults in db.ts / request-log-db.ts / claude-state.ts /
  // ipc.ts / proxy.ts.
  process.env.CLAUDE_SENTINEL_TEST_DB_FILE = dbPath;
  process.env.CLAUDE_SENTINEL_TEST_REQUEST_LOG_DB_FILE = requestLogDbPath;
  process.env.CLAUDE_SENTINEL_TEST_CLAUDE_JSON = claudeJsonPath;
  process.env.CLAUDE_SENTINEL_TEST_SETTINGS_FILE = settingsPath;
  process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = keychainPath;
  process.env.CLAUDE_SENTINEL_TEST_IPC_SOCKET = socketPath;
  process.env.CLAUDE_SENTINEL_TEST_DAEMON_PORT = String(daemonPort);
  process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;
  process.env.OAUTH_TOKEN_URL = fake.tokenUrl;
  process.env.OAUTH_AUTH_URL = fake.authUrl;

  const handle = await startDaemon();

  // Connect an IPC client over the real Unix socket. Response correlation:
  // each handler in index.ts emits `{ requestType: <same as message type> }`
  // in its response envelope. We maintain a per-type FIFO queue of resolvers;
  // on each response we shift the oldest matching resolver.
  const ipcClient = new IpcClient();
  const broadcasts: DaemonToAppMessage[] = [];
  const pending = new Map<string, Array<(resp: IpcResponse) => void>>();

  ipcClient.onMessage((msg) => {
    // IpcResponse has { requestType, success }; broadcasts carry { type }.
    if (
      typeof msg === 'object' &&
      msg !== null &&
      'requestType' in msg &&
      'success' in msg
    ) {
      const resp = msg as unknown as IpcResponse;
      const queue = pending.get(resp.requestType);
      if (queue && queue.length > 0) {
        const resolver = queue.shift()!;
        if (queue.length === 0) pending.delete(resp.requestType);
        resolver(resp);
      }
      return;
    }
    broadcasts.push(msg);
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`IPC connect timeout on ${socketPath}`));
      }
    }, 5000);
    ipcClient.onConnect(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    ipcClient.onError((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    ipcClient.connect(socketPath);
  });

  const request = <T = unknown>(msg: AppToDaemonMessage): Promise<IpcResponse<T>> =>
    new Promise((resolve, reject) => {
      const type = (msg as { type: string }).type;
      const queue = pending.get(type) ?? [];
      let timer: NodeJS.Timeout;
      const wrapped = (resp: IpcResponse) => {
        clearTimeout(timer);
        resolve(resp as IpcResponse<T>);
      };
      queue.push(wrapped);
      pending.set(type, queue);
      timer = setTimeout(() => {
        const q = pending.get(type);
        if (q) {
          const idx = q.indexOf(wrapped);
          if (idx >= 0) q.splice(idx, 1);
          if (q.length === 0) pending.delete(type);
        }
        reject(new Error(`IPC request timeout: ${type}`));
      }, 5000);
      ipcClient.send(msg);
    });

  const waitForBroadcast = <T extends DaemonToAppMessage = DaemonToAppMessage>(
    predicate: (msg: DaemonToAppMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      // Scan already-received first.
      const hit = broadcasts.find(predicate);
      if (hit) {
        resolve(hit as T);
        return;
      }
      const startLen = broadcasts.length;
      const interval = setInterval(() => {
        for (let i = startLen; i < broadcasts.length; i++) {
          const candidate = broadcasts[i];
          if (candidate && predicate(candidate)) {
            clearInterval(interval);
            clearTimeout(timer);
            resolve(candidate as T);
            return;
          }
        }
      }, 20);
      const timer = setTimeout(() => {
        clearInterval(interval);
        reject(new Error(`waitForBroadcast timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

  const cleanup = async (): Promise<void> => {
    try {
      ipcClient.close();
    } catch {
      // Already disconnected — ignore.
    }
    await handle.shutdown();
    await fake.close();
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      // tmpdir cleanup best-effort.
    }
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
  };

  return {
    fake,
    handle,
    ipcClient,
    broadcasts,
    request,
    waitForBroadcast,
    dbPath,
    requestLogDbPath,
    socketPath,
    keychainPath,
    settingsPath,
    claudeJsonPath,
    daemonPort,
    workdir,
    cleanup,
  };
}

/** Build a minimally-valid ClaudeCodeCredentials blob. Defaults yield a
 *  non-expired access token valid 24h from now. */
export function makeCreds(partial: Partial<ClaudeCodeCredentials> = {}): ClaudeCodeCredentials {
  const creds: ClaudeCodeCredentials = {
    accessToken: partial.accessToken ?? `test-token-${randomUUID()}`,
    refreshToken: partial.refreshToken ?? `test-refresh-${randomUUID()}`,
    expiresAt: partial.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
    scopes: partial.scopes ?? ['user:profile', 'user:inference'],
  };
  if (partial.subscriptionType !== undefined) creds.subscriptionType = partial.subscriptionType;
  if (partial.rateLimitTier !== undefined) creds.rateLimitTier = partial.rateLimitTier;
  return creds;
}
