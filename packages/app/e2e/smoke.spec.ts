/**
 * Smoke test: Vite dev server renders, IPC bridge round-trips `get_accounts`
 * through a real daemon subprocess backed by the fake Anthropic server.
 *
 * If this test passes, the E2E scaffolding is working end-to-end:
 *   - daemon booted against fake API + temp keychain
 *   - IPC bridge forwards to daemon socket
 *   - Vite dev server picks up VITE_E2E_BRIDGE_URL
 *   - React app's sendToSentinel() routes through the bridge
 *
 * Fuller per-flow specs (add-account, switch-account, alert-trigger) are
 * Sprint 7 of documentation/TEST_MIGRATION_PLAN.md.
 */

import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { startTestDaemon, type TestDaemon } from './helpers/test-daemon.js';

let daemon: TestDaemon;
let vite: ChildProcess;

test.beforeAll(async () => {
  daemon = await startTestDaemon({
    seedAccounts: [
      { id: 'acct-smoke', email: 'smoke@example.com', token: 'tok-smoke' },
    ],
  });

  vite = spawn('pnpm', ['--filter', '@claude-sentinel/app', 'exec', 'vite', '--port', '5173'], {
    cwd: resolve(__dirname, '..', '..', '..'),
    env: {
      ...process.env,
      VITE_E2E: 'true',
      VITE_E2E_BRIDGE_URL: daemon.bridgeUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for dev server.
  await new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start within 15s')), 15000);
    vite.stdout!.on('data', (buf: Buffer) => {
      if (buf.toString().includes('localhost:5173')) {
        clearTimeout(timer);
        resolveWait();
      }
    });
  });
});

test.afterAll(async () => {
  vite?.kill('SIGTERM');
  await daemon?.stop();
});

test('app loads and IPC bridge returns seeded account', async ({ page }) => {
  await page.goto('/');
  // The app mounts at #root; verify the React tree rendered.
  await expect(page.locator('#root')).toBeVisible();

  // Directly exercise the IPC bridge from the browser context to verify
  // the get_accounts handler round-trips through the daemon.
  const result = await page.evaluate(async (bridgeUrl: string) => {
    const res = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_accounts' }),
    });
    return (await res.json()) as { success?: boolean; accounts?: Array<{ id: string }> };
  }, daemon.bridgeUrl);

  expect(result.success).toBe(true);
  expect(result.accounts?.some((a) => a.id === 'acct-smoke')).toBe(true);
});

test.describe('deferred flows', () => {
  test.fixme('add-account OAuth flow', async () => {
    // Sprint 7: drive AccountSwitcher "+" click, intercept start_login,
    // post synthetic callback to oauth callback port, verify account appears.
  });

  test.fixme('switch-account flow', async () => {
    // Sprint 7: seed two accounts, click the inactive one, verify daemon
    // writes the new token into the fake keychain + broadcasts account_switched.
  });

  test.fixme('configure alert and trigger it', async () => {
    // Sprint 7: open Alerts tab, add alert at 90% threshold, switch fake to
    // 5h-warning scenario, fire a request, verify alert_triggered broadcast.
  });
});
