/**
 * Update-credentials dialog: renders legibly and submits only edited fields.
 *
 * This spec exists because v0.9.5 shipped this dialog with `bg-background` —
 * a class the theme does not define — so it rendered fully transparent and
 * unreadable. Every unit test, the type-checker, and all of CI passed. The
 * only signal that would have caught it is rendering the thing, so the
 * legibility assertions below are the regression guard: they read the computed
 * background of the card and the computed color of the primary button, and
 * fail on a transparent surface or an invisible label.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  startAppHarness,
  startTestDaemon,
  type AppHarness,
  type TestDaemon,
} from './helpers/test-daemon.js';

const ACCOUNT_ID = '88888888-8888-8888-8888-888888888888';

let daemon: TestDaemon;
let app: AppHarness;

test.beforeAll(async () => {
  daemon = await startTestDaemon({
    seedAccounts: [{ id: ACCOUNT_ID, email: 'cred@example.com', token: 'tok-cred' }],
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
          originalEntry: { command: 'uvx', args: ['mcp-atlassian'] },
          secretRef: 'seeded-ref',
          secretKeys: ['env.JIRA_PERSONAL_TOKEN', 'env.JIRA_URL'],
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
});

/** Open Optimize (seeded to land on its Context sub-tab) and click the bridged
 *  row's Update credentials. */
async function openDialog(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /optimize/i })
    .first()
    .click();
  const open = page.getByRole('button', { name: 'Update credentials' });
  await open.waitFor();
  await open.click();
  await expect(
    page.getByRole('dialog', { name: /Update credentials for mcp-atlassian/ }),
  ).toBeVisible();
}

/** Parse `rgb(a)` / `oklch` etc. into an alpha value; 0 means fully transparent
 *  (including the `rgba(0, 0, 0, 0)` Chromium reports for "no background"). */
function alphaOf(color: string): number {
  if (color === 'transparent') return 0;
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (!m) return 1; // a named/hex colour is opaque
  const parts = m[1]!.split(',').map((p) => parseFloat(p.trim()));
  return parts.length < 4 ? 1 : (parts[3] ?? 1);
}

test('dialog card has an opaque background and a legible primary button', async ({
  page,
}, testInfo) => {
  await openDialog(page);
  const card = page.locator('[role="dialog"] > div').first();

  // The actual v0.9.5 bug: an undefined utility class meant no background was
  // emitted at all, so the card was see-through.
  const cardBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(alphaOf(cardBg), `card background was "${cardBg}" — must be opaque`).toBeGreaterThan(0.9);

  // Heading and the primary action must both have a visible colour distinct
  // from the surface they sit on.
  const heading = page.getByRole('heading', { name: /Update credentials/ });
  const headingColor = await heading.evaluate((el) => getComputedStyle(el).color);
  expect(alphaOf(headingColor)).toBeGreaterThan(0.9);

  const save = page.getByRole('button', { name: 'Verify & save' });
  await expect(save).toBeVisible();
  const saveStyles = await save.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, bg: s.backgroundColor, text: (el as HTMLElement).innerText };
  });
  expect(saveStyles.text.trim()).toBe('Verify & save');
  expect(alphaOf(saveStyles.color), `button label was "${saveStyles.color}"`).toBeGreaterThan(0.9);
  expect(alphaOf(saveStyles.bg), `button fill was "${saveStyles.bg}"`).toBeGreaterThan(0.9);
  expect(saveStyles.color).not.toBe(saveStyles.bg);

  // Land the screenshot in Playwright's own per-test output dir (auto-cleaned,
  // attached to the HTML report) rather than writing a binary into the repo.
  // The assertions above are the gate; this is for a human to eyeball.
  await page.screenshot({ path: testInfo.outputPath('credentials-dialog.png') });
});

test('renders a masked field per credential key and gates save until edited', async ({ page }) => {
  await openDialog(page);
  const token = page.locator('#cred-env\\.JIRA_PERSONAL_TOKEN');
  const url = page.locator('#cred-env\\.JIRA_URL');
  await expect(token).toBeVisible();
  await expect(url).toBeVisible();
  // Values are never sent to the renderer up front — the field is a masked,
  // empty placeholder until the user reveals or edits it.
  await expect(token).toHaveAttribute('type', 'password');
  await expect(token).toHaveValue('');

  const save = page.getByRole('button', { name: 'Verify & save' });
  await expect(save).toBeDisabled();
  await token.fill('rotated-token');
  await expect(save).toBeEnabled();
  // Editing switches the field to visible text so the user can check what they typed.
  await expect(token).toHaveAttribute('type', 'text');
});

test('closes on Escape and on backdrop click', async ({ page }) => {
  await openDialog(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  await openDialog(page);
  // Click the overlay itself, well outside the card.
  await page.locator('[role="dialog"]').click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole('dialog')).toBeHidden();
});
