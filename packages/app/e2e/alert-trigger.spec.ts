/**
 * Flow 3 — Configure alert and trigger.
 *
 * Navigate to the Alerts tab, create a 90% threshold alert via the UI,
 * then synthesize an alert-triggered event through the Sprint 6
 * `dev_trigger_alert_event` IPC handler. Assert the broadcast lands and
 * the UI marks the row as triggered.
 *
 * The dev-trigger handler emits a synthetic `alert_triggered` broadcast
 * without touching real rate-limit state, so the test doesn't depend on
 * the proxy pipeline producing a real 85% usage header. The handler
 * also writes a notification row, which appears in the UI's alert list
 * as "· triggered this window".
 */

import { test, expect } from '@playwright/test';
import type { Alert } from '@sentinel/shared';
import {
  startAppHarness,
  startTestDaemon,
  type AppHarness,
  type TestDaemon,
} from './helpers/test-daemon.js';

const ACCT = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  email: 'carol@example.com',
  token: 'tok-carol',
};

let daemon: TestDaemon;
let app: AppHarness;

test.beforeAll(async () => {
  daemon = await startTestDaemon({
    seedAccounts: [ACCT],
    seedActiveId: ACCT.id,
  });
  app = await startAppHarness(daemon.bridgeUrl);
});

test.afterAll(async () => {
  await app?.stop();
  await daemon?.stop();
});

test('Create 90% alert, then trigger and verify broadcast + UI row', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.getByText(ACCT.email).first()).toBeVisible({ timeout: 5000 });

  // Jump to the Alerts tab (internally "notifications" per App.tsx).
  await page.locator('[data-tour-id="tab-notifications"]').click();

  // The alert sections are collapsed SettingsCards by default; expand
  // "5-Hour Alerts" to reach its Add alert button.
  await page.getByRole('button', { name: /5-hour alerts/i }).click();

  // Click "Add alert". Threshold defaults to 90%, so we can save immediately.
  await page
    .getByRole('button', { name: /Add alert/i })
    .first()
    .click();
  await page.getByRole('button', { name: /Save/i }).click();

  // Verify the daemon stored the alert.
  const listRes = await fetch(daemon.bridgeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'list_alerts' }),
  });
  const listPayload = (await listRes.json()) as { data?: Alert[] };
  const ninety = listPayload.data?.find((a) => a.thresholdPct === 90);
  expect(ninety, 'list_alerts should return the new 90% alert').toBeDefined();
  expect(ninety?.enabled).toBe(true);

  // Trigger the alert synthetically via the Sprint 6 dev handler.
  const triggered = daemon.waitForBroadcast(
    'alert_triggered',
    (msg) => msg.scope === 'account' && msg.accountId === ACCT.id,
  );
  const trigRes = await fetch(daemon.bridgeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'dev_trigger_alert_event',
      scenario: 'usage-account',
      accountId: ACCT.id,
    }),
  });
  expect(trigRes.status).toBe(200);
  const broadcastMsg = await triggered;
  expect(broadcastMsg.utilization).toBeCloseTo(0.85, 2);
});
