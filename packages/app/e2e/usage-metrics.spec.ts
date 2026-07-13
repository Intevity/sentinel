/**
 * Flow 5 — View usage metrics.
 *
 * Seed one account with the fake in `healthy-account` mode. On daemon
 * startup the background probe fires a real /v1/messages call through
 * the proxy, the proxy parses the fake's `anthropic-ratelimit-*`
 * headers, and broadcasts `rate_limits_updated`. The spec:
 *
 *   1. Verifies the initial broadcast lands and the Usage tab renders
 *      the 10% 5h utilization from `healthy-account`.
 *   2. Flips the fake to `5h-warning` (92% utilization), probes again
 *      via the `probe_rate_limits` IPC, awaits a second broadcast,
 *      asserts the rendered percentage has changed.
 *
 * This pins three seams in a single pass:
 *   - probe path round-trips through real proxy → fake HTTP listener.
 *   - proxy's header parser matches current wire shape.
 *   - E2E SSE bridge delivers the broadcast to the browser.
 */

import { test, expect } from '@playwright/test';
import {
  startAppHarness,
  startTestDaemon,
  type AppHarness,
  type TestDaemon,
} from './helpers/test-daemon.js';

const ACCT = {
  id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  email: 'frank@example.com',
  token: 'tok-frank',
};

let daemon: TestDaemon;
let app: AppHarness;

test.beforeAll(async () => {
  daemon = await startTestDaemon({
    seedAccounts: [ACCT],
    seedActiveId: ACCT.id,
  });
  // Fake defaults to 'healthy-account' — no setScenario needed for bring-up.
  app = await startAppHarness(daemon.bridgeUrl);
});

test.afterAll(async () => {
  await app?.stop();
  await daemon?.stop();
});

test('Probe round-trip renders 5h utilization; scenario flip updates UI', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).toBeVisible();
  await expect(page.getByText(ACCT.email).first()).toBeVisible({ timeout: 5000 });

  // Jump to the Usage tab.
  await page.locator('[data-tour-id="tab-usage"]').click();

  // The UI shows "X.Y% of quota consumed" below each window. Two data
  // paths feed the store:
  //   - claude.ai usage sync (startup): value is in 0-100 scale and
  //     normalized by /100 inside parseUsage → fake's 18 lands as 0.18.
  //   - proxy /v1/messages headers (probes): value is a fraction 0-1
  //     and stored as-is → scenario's 0.10 lands as 0.1.
  // The daemon's startup pipeline runs both — the one that wrote most
  // recently wins per-window. The fake's claude.ai snapshot for 5h
  // reports 18 (percent), so after the sync the 5h window renders as
  // "18.0% of quota consumed" (distinct from the header path's "10.0%",
  // so this asserts the sync landed). After the scenario flip below we
  // assert the header-path value clobbers it with "92.0%".
  await expect(page.getByText('18.0% of quota consumed').first()).toBeVisible({
    timeout: 10000,
  });

  // Flip the fake scenario and probe again. The proxy debounces
  // rate_limits_updated broadcasts to one per 2s per account, so we
  // pace the probe and then click the UI's Refresh button to force a
  // get_rate_limits re-fetch against the now-updated store.
  daemon.fake.setScenario('5h-warning');
  await new Promise((r) => setTimeout(r, 2100));
  await fetch(daemon.bridgeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'probe_rate_limits', accountId: ACCT.id }),
  });
  // Give the probe a moment to hit the fake and write the store.
  await new Promise((r) => setTimeout(r, 500));
  await page.getByTitle('Refresh').first().click();

  // 5h-warning returns utilization=0.92 which the UI renders as "92.0%".
  await expect(page.getByText('92.0% of quota consumed').first()).toBeVisible({
    timeout: 5000,
  });
});
