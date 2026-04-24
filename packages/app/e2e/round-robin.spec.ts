/**
 * Flow 4 — Round-robin toggle.
 *
 * Flip the switching-mode segmented control from Manual to Round-robin.
 * Verify:
 *   - `settings_changed` broadcast fires with switchingMode='round-robin'.
 *   - Persisted settings (`get_settings` IPC) reflect the new mode.
 *   - Header pill "Round-Robin · Balance" appears.
 */

import { test, expect } from '@playwright/test';
import type { Settings } from '@claude-sentinel/shared';
import {
  startAppHarness,
  startTestDaemon,
  type AppHarness,
  type TestDaemon,
} from './helpers/test-daemon.js';

const ACCT_A = {
  id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  email: 'dave@example.com',
  token: 'tok-dave',
};
const ACCT_B = {
  id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  email: 'erin@example.com',
  token: 'tok-erin',
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

test('Toggle switching-mode to round-robin end-to-end', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.getByText(ACCT_A.email).first()).toBeVisible({ timeout: 5000 });

  // Baseline: settings start in 'off' via the pre-seeded settings.json.
  // Listen before clicking so there's no race against the broadcast.
  const settingsChanged = daemon.waitForBroadcast(
    'settings_changed',
    (msg) => msg.settings.switchingMode === 'round-robin',
  );

  // QuickSegmented emits a radio role per option. Click the Round-robin one.
  await page.getByRole('radio', { name: 'Round-robin' }).click();
  const broadcast = await settingsChanged;
  expect(broadcast.settings.switchingMode).toBe('round-robin');

  // Persisted state: get_settings round-trip confirms the write.
  const res = await fetch(daemon.bridgeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'get_settings' }),
  });
  const payload = (await res.json()) as { data?: Settings };
  expect(payload.data?.switchingMode).toBe('round-robin');

  // UI reflects the new mode in the header pill.
  await expect(page.getByText(/Round-Robin/i).first()).toBeVisible({ timeout: 5000 });
});
