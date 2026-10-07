/**
 * Flow — dismissing an optional surface's routing card.
 *
 * opencode is installed but not routed, so the main window offers "Route
 * opencode through Sentinel". A user who does not want that clicks ✕: the card
 * goes away, stays away after a reload, and the same choice is still offered
 * as the toggle in Settings → General.
 */

import { test, expect } from '@playwright/test';
import {
  startAppHarness,
  startTestDaemon,
  type AppHarness,
  type TestDaemon,
} from './helpers/test-daemon.js';

const ACCT = {
  id: 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd',
  email: 'owen@example.com',
  token: 'tok-owen',
};

let daemon: TestDaemon;
let app: AppHarness;

test.beforeAll(async () => {
  daemon = await startTestDaemon({
    seedAccounts: [ACCT],
    seedActiveId: ACCT.id,
    seedOpencode: true,
  });
  app = await startAppHarness(daemon.bridgeUrl);
});

test.afterAll(async () => {
  await app?.stop();
  await daemon?.stop();
});

test('Dismissing the opencode card hides it for good and keeps the Settings toggle', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText(ACCT.email).first()).toBeVisible({ timeout: 5000 });

  const title = page.getByText('Route opencode through Sentinel', { exact: true });
  await expect(title).toBeVisible({ timeout: 10000 });

  await page.getByRole('button', { name: 'Dismiss opencode routing suggestion' }).click();
  await expect(title).toBeHidden();

  // The dismissal persists across a reload.
  await page.reload();
  await expect(page.getByText(ACCT.email).first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Route opencode through Sentinel', { exact: true })).toHaveCount(0);

  // The choice is still available where the dismiss tooltip says it is.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'General' }).click();
  await expect(page.getByText('Route opencode through Sentinel', { exact: true })).toBeVisible();
});
