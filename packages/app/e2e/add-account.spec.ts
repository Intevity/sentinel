/**
 * Flow 1 — Add-account OAuth (happy path).
 *
 * Drives the AccountSwitcher "+ Add Account" button through the full
 * PKCE round-trip against the fake Anthropic server. No real browser.
 *
 * The daemon runs with `CLAUDE_SENTINEL_TEST_OAUTH_ECHO=1`, so
 * `start_login` broadcasts `test_oauth_url_opened` with the authorize
 * URL the production path would hand to a browser launcher. The test
 * extracts the PKCE `state`, POSTs a synthetic callback to the daemon's
 * loopback callback server (port 47285), and asserts the new account
 * row lands in the UI.
 */

import { test, expect } from '@playwright/test';
import {
  startAppHarness,
  startTestDaemon,
  type AppHarness,
  type TestDaemon,
} from './helpers/test-daemon.js';

let daemon: TestDaemon;
let app: AppHarness;

test.beforeAll(async () => {
  daemon = await startTestDaemon({ oauthEcho: true });
  app = await startAppHarness(daemon.bridgeUrl);
});

test.afterAll(async () => {
  await app?.stop();
  await daemon?.stop();
});

test('OAuth happy path: + button drives PKCE and adds the account', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();

  // Subscribe to the URL-echo broadcast BEFORE clicking, so the race
  // between start_login emitting the broadcast and our SSE stream
  // opening is ruled out. waitForBroadcast opens its own stream.
  const urlPromise = daemon.waitForBroadcast('test_oauth_url_opened');

  await page.locator('[data-tour-id="add-account"]').click();
  const urlEvent = await urlPromise;
  const u = new URL(urlEvent.url);
  const state = u.searchParams.get('state');
  expect(state, 'authorize URL should carry a state param').toBeTruthy();

  // Synthesize the browser callback. The daemon's callback server binds
  // port 47285; posting a code+state completes `startOAuthLogin`, which
  // then exchanges for a token against the fake and writes credentials.
  // We also listen for login_complete before firing the callback.
  const loginDone = daemon.waitForBroadcast('login_complete');
  const callbackRes = await fetch(
    `http://127.0.0.1:47285/callback?code=fake-code&state=${encodeURIComponent(state ?? '')}`,
  );
  expect(callbackRes.status, 'callback should 200').toBe(200);
  await loginDone;

  // The UI polls refreshAccounts on login_complete. The fake's token
  // exchange maps the issued access_token to its DEFAULT_PROFILE, whose
  // email is 'test@example.com' — that's the identity the daemon
  // enrolls. Assert the new row appears under that email.
  await expect(page.getByText('test@example.com').first()).toBeVisible({ timeout: 5000 });
});
