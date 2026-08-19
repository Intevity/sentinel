/**
 * Restart affordance on a bridged server row.
 *
 * The reason this surface exists is that a bridged MCP server could go bad —
 * a wedged child, a stale build behind an unpinned `uvx` — with no way for the
 * user to see it and no recovery short of unbridge/re-bridge. The button and
 * the runtime line are therefore only useful if they actually RENDER: the same
 * class of bug that shipped an unreadable credentials dialog in v0.9.5 (a
 * Tailwind colour the theme never defined) would be invisible to unit tests,
 * the type-checker, and coverage alike. Hence the legibility assertion.
 */

import { test, expect, type Page } from '@playwright/test';
import { writeFakeMcpStdioScript } from '@sentinel/test-harness';
import {
  startAppHarness,
  startTestDaemon,
  type AppHarness,
  type TestDaemon,
} from './helpers/test-daemon.js';

const ACCOUNT_ID = '77777777-7777-7777-7777-777777777777';

let daemon: TestDaemon;
let app: AppHarness;
/** A real, working stdio MCP server, so one row can restart SUCCESSFULLY and
 *  prove the runtime line renders with live values. */
let script: { path: string; cleanup: () => void };

test.beforeAll(async () => {
  script = writeFakeMcpStdioScript();
  daemon = await startTestDaemon({
    seedAccounts: [{ id: ACCOUNT_ID, email: 'restart@example.com', token: 'tok-restart' }],
    seedActiveId: ACCOUNT_ID,
    settings: {
      optimizeSubTab: 'context',
      codeModeEnabled: true,
      codeModeSkillInstalled: true,
      codeModeMigrations: [
        {
          server: 'mcp-atlassian',
          scope: 'user',
          directory: null,
          // Deliberately a command that cannot exist: the restart must fail
          // fast and predictably. Naming a real launcher here would spawn an
          // actual MCP server on the machine running the suite.
          originalEntry: { command: 'sentinel-e2e-nonexistent-server', args: [] },
          secretRef: 'seeded-ref',
          secretKeys: ['env.JIRA_PERSONAL_TOKEN'],
          migratedAt: 1,
        },
        {
          server: 'fake-working',
          scope: 'user',
          directory: null,
          originalEntry: { command: process.execPath, args: [script.path] },
          secretKeys: [],
          migratedAt: 1,
        },
      ],
    },
  });
  app = await startAppHarness(daemon.bridgeUrl);
});

test.afterAll(async () => {
  await app?.stop();
  await daemon?.stop();
  script?.cleanup();
});

/** The <li> row for one server, so the per-row buttons are unambiguous. */
function row(page: Page, server: string) {
  return page.locator('li').filter({ hasText: server });
}

async function openContextTab(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /optimize/i })
    .first()
    .click();
}

/** Alpha of a computed colour; 0 is fully transparent, including the
 *  `rgba(0, 0, 0, 0)` Chromium reports for "no colour". */
function alphaOf(color: string): number {
  if (color === 'transparent') return 0;
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (!m) return 1;
  const parts = m[1]!.split(',').map((p) => Number(p.trim()));
  return parts.length < 4 ? 1 : (parts[3] ?? 1);
}

test('a bridged row offers a legible Restart action', async ({ page }) => {
  await openContextTab(page);

  const atlassian = row(page, 'mcp-atlassian');
  const restart = atlassian.getByRole('button', { name: 'Restart', exact: true });
  await restart.waitFor();
  await expect(restart).toBeEnabled();

  // The label must actually be readable — an undefined Tailwind colour would
  // leave it visible to the DOM but invisible to a human.
  const color = await restart.evaluate((el) => getComputedStyle(el).color);
  expect(alphaOf(color)).toBeGreaterThan(0.5);

  // Sits alongside the other bridged-row actions rather than replacing them.
  await expect(atlassian.getByRole('button', { name: 'Update credentials' })).toBeVisible();
  await expect(atlassian.getByRole('button', { name: 'Switch back to native MCP' })).toBeVisible();
});

test('restarting reports the failure inline when the server cannot come back', async ({ page }) => {
  await openContextTab(page);

  // The seeded migration names a command that cannot resolve, so the restart
  // genuinely fails — the path that must not leave the UI stuck on a spinner.
  const atlassian = row(page, 'mcp-atlassian');
  await atlassian.getByRole('button', { name: 'Restart', exact: true }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).not.toBeEmpty();
  // Buttons are re-enabled afterwards; a stuck busy lock would strand the row.
  await expect(atlassian.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled();
});

test('restarting a healthy server reports its live process state', async ({ page }) => {
  await openContextTab(page);
  const working = row(page, 'fake-working');
  await working.getByRole('button', { name: 'Restart', exact: true }).click();

  // Success notice names the tool count the reconnected server reported.
  await expect(page.getByText(/fake-working restarted \(\d+ tools\)/)).toBeVisible({
    timeout: 30_000,
  });

  // And the runtime line now describes the real child: an uptime, the pid to
  // match against `ps`, and the tools it listed. This is the whole point of
  // the feature — before it, a bridged server's process was invisible.
  const runtimeLine = working.locator('p.font-mono').first();
  await expect(runtimeLine).toBeVisible();
  await expect(runtimeLine).toHaveText(/up \d+s · pid \d+ · \d+ tools/);

  // Legible, not just present.
  const color = await runtimeLine.evaluate((el) => getComputedStyle(el).color);
  expect(alphaOf(color)).toBeGreaterThan(0.3);
});
