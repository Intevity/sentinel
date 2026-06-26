/**
 * Flow 2 — Switch-account.
 *
 * Seed two accounts (A active, B inactive). Click the "Switch" button on
 * B's card. Verify:
 *   - `account_switched` broadcast fires with B's accountUuid.
 *   - ~/.claude.json (under HOME=workDir) now points at B.
 *   - `get_accounts` IPC reflects B as active.
 *   - The header UI reflects B's email as the active account.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import type { AccountInfo, ClaudeState } from '@sentinel/shared';
import {
  startAppHarness,
  startTestDaemon,
  type AppHarness,
  type TestDaemon,
} from './helpers/test-daemon.js';

const ACCT_A = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  email: 'alice@example.com',
  token: 'tok-alice',
};
const ACCT_B = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  email: 'bob@example.com',
  token: 'tok-bob',
};

let daemon: TestDaemon;
let app: AppHarness;

test.beforeAll(async () => {
  daemon = await startTestDaemon({
    seedAccounts: [ACCT_A, ACCT_B],
    seedActiveId: ACCT_A.id,
  });
  app = await startAppHarness(daemon.bridgeUrl);
});

test.afterAll(async () => {
  await app?.stop();
  await daemon?.stop();
});

test('Switch pill on inactive card flips active account end-to-end', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();
  // Canary — if a future sprint adds a new first-run gate that slips past
  // the settings pre-seed, specs hang on a modal. Fail fast instead.
  await expect(page.getByText(ACCT_A.email).first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(ACCT_B.email).first()).toBeVisible();

  const switched = daemon.waitForBroadcast(
    'account_switched',
    (msg) => msg.to.emailAddress === ACCT_B.email,
  );

  // B is inactive → its card's primary action is the "Switch" button.
  // Alice's card has no "Switch" button (she's already active). Use
  // exact: true so the match doesn't also resolve the "How account
  // switching works" info button — its accessible name contains
  // "switching", which a default (substring) name match would catch,
  // tripping strict mode.
  await page.getByRole('button', { name: 'Switch', exact: true }).click();
  const switchedMsg = await switched;
  expect(switchedMsg.to.accountUuid).toBe(ACCT_B.id);

  // Daemon-side state: ~/.claude.json was rewritten to the new active
  // account. Workdir is under daemon.workDir/HOME.
  const claudeJson = JSON.parse(
    readFileSync(join(daemon.workDir, '.claude.json'), 'utf-8'),
  ) as ClaudeState;
  expect(claudeJson.oauthAccount?.emailAddress).toBe(ACCT_B.email);

  // IPC round-trip: get_accounts now returns B as active.
  const res = await fetch(daemon.bridgeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'get_accounts' }),
  });
  const payload = (await res.json()) as { data?: AccountInfo[] };
  const bob = payload.data?.find((a) => a.email === ACCT_B.email);
  expect(bob?.isActive, 'Bob should be the active account after switch').toBe(true);

  // UI reflects the new active email in the header (the "activeAccount"
  // row in App.tsx pulls this from the daemon broadcast). Give the
  // useDaemon poll a beat to catch up; broadcast is the readiness signal.
  await expect(page.getByText(ACCT_B.email).first()).toBeVisible({ timeout: 5000 });
});
