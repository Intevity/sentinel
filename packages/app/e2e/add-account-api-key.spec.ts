/**
 * Flow — adding an account with an Anthropic API key.
 *
 * Add Account now asks what kind of account to add. Choosing "API key" opens a
 * form; the daemon checks the key against the (fake) API before storing it, so
 * a refused key is explained in the form, and an accepted one becomes an
 * account card marked "API key".
 */

import { test, expect } from '@playwright/test';
import {
  startAppHarness,
  startTestDaemon,
  type AppHarness,
  type TestDaemon,
} from './helpers/test-daemon.js';

const ACCT = {
  id: 'abababab-abab-abab-abab-abababababab',
  email: 'sub@example.com',
  token: 'tok-sub',
};
const GOOD_KEY = `sk-ant-usr01-${'G'.repeat(95)}`;
const DEAD_KEY = `sk-ant-api03-${'D'.repeat(95)}`;
const OLD_KEY = `sk-ant-api03-${'O'.repeat(95)}`;

let daemon: TestDaemon;
let app: AppHarness;

test.beforeAll(async () => {
  daemon = await startTestDaemon({ seedAccounts: [ACCT], seedActiveId: ACCT.id });
  daemon.fake.registerToken(GOOD_KEY);
  daemon.fake.registerToken(OLD_KEY);
  app = await startAppHarness(daemon.bridgeUrl);
});

test.afterAll(async () => {
  await app?.stop();
  await daemon?.stop();
});

test('Add Account offers a subscription or an API key, and adds a checked key', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText(ACCT.email).first()).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Add Account' }).click();
  await expect(page.getByRole('heading', { name: 'Add an account' })).toBeVisible();
  await expect(page.getByTestId('add-account-subscription')).toContainText('Claude subscription');
  await page.getByTestId('add-account-api-key').click();
  await expect(page.getByRole('heading', { name: 'Add an API key' })).toBeVisible();

  // Something that isn't an API key is refused before the daemon is asked.
  await page.getByTestId('api-key-input').fill(`sk-ant-oat01-${'A'.repeat(95)}`);
  await page.getByTestId('api-key-submit').click();
  await expect(page.getByRole('alert')).toHaveText(
    'That is a Claude subscription token, not an API key. Choose "Claude subscription" to add it.',
  );

  // A key Anthropic rejects is explained, and the form keeps what was typed.
  await page.getByTestId('api-key-input').fill(DEAD_KEY);
  await page.getByPlaceholder('Work API key').fill('Personal key');
  await page.getByTestId('api-key-submit').click();
  await expect(page.getByRole('alert')).toHaveText(/^Anthropic rejected this API key\./, {
    timeout: 10_000,
  });
  await expect(page.getByPlaceholder('Work API key')).toHaveValue('Personal key');

  // A working key is added as an API-key account.
  await page.getByTestId('api-key-input').fill(GOOD_KEY);
  await page.getByTestId('api-key-submit').click();
  await expect(page.getByRole('heading', { name: 'Add an API key' })).toBeHidden({
    timeout: 10_000,
  });
  await expect(page.getByText('Personal key added to Sentinel.')).toBeVisible();
  await expect(page.getByText('API key', { exact: true }).first()).toBeVisible();
});

test('A key Anthropic stops accepting asks for a replacement key, not a sign-in', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText(ACCT.email).first()).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: 'Add Account' }).click();
  await page.getByTestId('add-account-api-key').click();
  await page.getByTestId('api-key-input').fill(OLD_KEY);
  await page.getByPlaceholder('Work API key').fill('Old key');
  await page.getByTestId('api-key-submit').click();
  await expect(page.getByText('Old key added to Sentinel.')).toBeVisible({ timeout: 10_000 });

  // Route Claude Code through it after the key was disabled: Anthropic answers
  // 401, and the card asks for a new key rather than a Claude Code sign-in.
  const card = page.locator('div.rounded-2xl', { hasText: 'Old key' }).last();
  await card.getByRole('button', { name: 'Switch' }).click();
  await expect(card.getByText('Active')).toBeVisible({ timeout: 5000 });
  daemon.fake.queueResponse('/v1/messages', {
    status: 401,
    body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
  });
  const res = await fetch(`http://127.0.0.1:${daemon.proxyPort}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'claude-cli/2.1.197 (external, cli)',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-5-20250929', messages: [] }),
  });
  expect(res.status).toBe(401);
  await expect(
    card.getByText('Anthropic rejected this API key. Replace it to restore access.'),
  ).toBeVisible({ timeout: 10_000 });

  await card.getByRole('button', { name: 'Replace key' }).click();
  await expect(
    page.getByRole('heading', { name: 'Replace the API key for Old key' }),
  ).toBeVisible();
  await expect(page.getByPlaceholder('Work API key')).toHaveCount(0);
  await page.getByTestId('api-key-input').fill(GOOD_KEY);
  await page.getByTestId('api-key-submit').click();
  await expect(page.getByText('Replaced the API key for Old key.')).toBeVisible({
    timeout: 10_000,
  });
  await expect(card.getByText('Anthropic rejected this API key.', { exact: false })).toHaveCount(0);
});
