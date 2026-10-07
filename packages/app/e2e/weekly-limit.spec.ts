/**
 * Flow — weekly limit: Auto target window + "Clear limit".
 *
 * 1. Settings → Accounts → Auto → "Target limit" flips to Weekly and the
 *    choice persists (`autoSwitchTargetWindow` via get_settings).
 * 2. A real proxied response reports the weekly window `rejected` (the wire
 *    value Anthropic sends). The Usage view shows it Blocked and the account
 *    is paused for the weekly limit. "Clear limit" resets the window and
 *    lifts the pause without sending a request — the escape hatch for an
 *    early one-time reset Sentinel cannot observe on its own.
 *
 * The proxied response comes from the manual rate-limit probe (enabled for
 * this spec) against the fake, with the weekly headers queued on top of the
 * default scenario.
 */

import { test, expect } from '@playwright/test';
import type { Settings } from '@sentinel/shared';
import {
  startAppHarness,
  startTestDaemon,
  type AppHarness,
  type TestDaemon,
} from './helpers/test-daemon.js';

const ACCT = {
  id: 'abababab-abab-abab-abab-abababababab',
  email: 'wendy@example.com',
  token: 'tok-wendy',
};

let daemon: TestDaemon;
let app: AppHarness;

async function ipc<T>(msg: Record<string, unknown>): Promise<{ success: boolean; data?: T }> {
  const res = await fetch(daemon.bridgeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  });
  return (await res.json()) as { success: boolean; data?: T };
}

test.beforeAll(async () => {
  daemon = await startTestDaemon({
    seedAccounts: [ACCT],
    seedActiveId: ACCT.id,
    settings: { manualRateLimitProbeEnabled: true },
  });
  app = await startAppHarness(daemon.bridgeUrl);
});

test.afterAll(async () => {
  await app?.stop();
  await daemon?.stop();
});

test('Auto target limit switches to Weekly and persists', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(ACCT.email).first()).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Accounts' }).click();
  // The Settings radio rows are named by label + description; a bare "Auto"
  // would also match the main window's switching-mode control.
  await page.getByRole('radio', { name: /^Auto .*targeted limit/ }).click();

  const targetGroup = page.getByRole('radiogroup', { name: 'Auto switching target limit' });
  await expect(targetGroup.getByRole('radio', { name: '5-hour' })).toBeChecked({ timeout: 5000 });

  const changed = daemon.waitForBroadcast(
    'settings_changed',
    (m) => m.settings.autoSwitchTargetWindow === 'weekly',
  );
  await targetGroup.getByRole('radio', { name: 'Weekly' }).click();
  await changed;

  await expect(targetGroup.getByRole('radio', { name: 'Weekly' })).toBeChecked();
  await expect(
    page.getByText('Drains the account whose weekly limit resets soonest'),
  ).toBeVisible();
  const settings = await ipc<Settings>({ type: 'get_settings' });
  expect(settings.data?.autoSwitchTargetWindow).toBe('weekly');

  // Back to manual switching so the next test renders the single-account view.
  await page.getByRole('radio', { name: /^Off No automatic switching/ }).click();
  await expect
    .poll(async () => (await ipc<Settings>({ type: 'get_settings' })).data?.switchingMode)
    .toBe('off');
});

test('Clear limit lifts a rejected weekly window and its pause', async ({ page }) => {
  // Open Usage first: the page's claude.ai refresh writes the fake's
  // snapshot (weekly 10%), and a newer source wins per window. The rejected
  // response below must land after it.
  await page.goto('/');
  await expect(page.getByText(ACCT.email).first()).toBeVisible({ timeout: 5000 });
  await page.locator('[data-tour-id="tab-usage"]').click();
  await expect(page.getByText('10.0% of quota consumed').first()).toBeVisible({
    timeout: 10000,
  });

  const weekAhead = String(Math.floor(Date.now() / 1000) + 3 * 86_400);
  daemon.fake.queueResponse('/v1/messages', {
    extraHeaders: {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-utilization': '1.0',
      'anthropic-ratelimit-unified-7d-reset': weekAhead,
    },
  });
  const paused = daemon.waitForBroadcast(
    'account_paused',
    (m) => m.accountId === ACCT.id && m.reason === 'sentinel_weekly_rate_limit',
  );
  await ipc({ type: 'probe_rate_limits', accountId: ACCT.id });
  await paused;
  await page.getByTitle('Refresh').first().click();

  const clear = page.getByRole('button', { name: 'Clear limit' });
  await expect(clear).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Blocked').first()).toBeVisible();

  const unpaused = daemon.waitForBroadcast('account_unpaused', (m) => m.accountId === ACCT.id);
  await clear.click();
  await unpaused;

  await expect(clear).toBeHidden({ timeout: 5000 });
  const windows = await ipc<Array<{ name: string; status: string; utilization: number }>>({
    type: 'get_rate_limits',
    accountId: ACCT.id,
  });
  expect(windows.data?.find((w) => w.name === 'unified-7d')).toMatchObject({
    status: 'allowed',
    utilization: 0,
  });
});
