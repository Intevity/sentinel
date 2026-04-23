/**
 * Spawns all the infra a Playwright test needs:
 *   - fake Anthropic HTTP server
 *   - IPC HTTP bridge (forwards to daemon Unix socket)
 *   - daemon subprocess, pointed at the fake + a throwaway keychain file
 *
 * Returns the bridge URL (which Vite injects as VITE_E2E_BRIDGE_URL)
 * plus cleanup hooks.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeAnthropic, type FakeAnthropic } from '@claude-sentinel/test-harness';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

export interface TestDaemon {
  bridgeUrl: string;
  fake: FakeAnthropic;
  workDir: string;
  stop(): Promise<void>;
}

export async function startTestDaemon(
  init: { seedAccounts?: Array<{ id: string; email: string; token: string }> } = {},
): Promise<TestDaemon> {
  const workDir = mkdtempSync(join(tmpdir(), 'sentinel-e2e-'));
  const keychainFile = join(workDir, 'keychain.json');
  // Daemon resolves ~/.claude-sentinel via homedir(), which Node reads from HOME.
  // Set HOME=workDir so the daemon places its socket and DB under workDir.
  const sentinelDir = join(workDir, '.claude-sentinel');
  const socketPath = join(sentinelDir, 'daemon.sock');
  writeFileSync(keychainFile, JSON.stringify({ 'Claude Sentinel-credentials': {} }));

  const fake = await startFakeAnthropic();
  for (const a of init.seedAccounts ?? []) {
    fake.registerToken(a.token, { email: a.email, uuid: a.id });
    // Pre-populate keychain so list_accounts sees them.
    const existing = JSON.parse(readFileSync(keychainFile, 'utf-8')) as Record<
      string,
      Record<string, string>
    >;
    if (!existing['Claude Sentinel-credentials']) existing['Claude Sentinel-credentials'] = {};
    existing['Claude Sentinel-credentials']![a.id] = JSON.stringify({
      accessToken: a.token,
      refreshToken: `refresh-${a.id}`,
      expiresAt: Date.now() + 3600_000,
      scopes: ['user:profile', 'user:inference'],
    });
    writeFileSync(keychainFile, JSON.stringify(existing, null, 2));
  }

  const daemonBin = resolve(REPO_ROOT, 'packages/daemon/dist/cli.js');
  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_UPSTREAM_URL: fake.origin,
    OAUTH_TOKEN_URL: fake.tokenUrl,
    OAUTH_AUTH_URL: fake.authUrl,
    CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE: keychainFile,
    HOME: workDir,
  };

  const daemon = spawn('node', [daemonBin], {
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForSocket(socketPath, 5000);

  const bridgeScript = resolve(__dirname, 'ipc-http-bridge.mjs');
  const { port, proc: bridge } = await startBridge(bridgeScript, socketPath);

  return {
    bridgeUrl: `http://127.0.0.1:${port}/`,
    fake,
    workDir,
    async stop() {
      daemon.kill('SIGTERM');
      bridge.kill('SIGTERM');
      await fake.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`daemon socket ${path} did not appear within ${timeoutMs}ms`);
}

async function startBridge(scriptPath: string, socketPath: string): Promise<{ port: number; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
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
        resolve({ port: Number(m[1]), proc });
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
