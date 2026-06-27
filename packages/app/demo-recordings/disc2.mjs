#!/usr/bin/env node
// Focused Batch-B discovery: capture the real Security/Alerts tabs, the live
// pending-block banner, the fake macOS notification, and the Settings rules +
// sandbox panels. Read-only; screenshots to scratchpad.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const { chromium } = require('@playwright/test');

const APP_URL = 'http://localhost:5180';
const BRIDGE_URL = 'http://127.0.0.1:47999';
const STAGE_URL = `${BRIDGE_URL}/stage?app=${encodeURIComponent(APP_URL)}`;
const OUT =
  '/private/tmp/claude-501/-Users-jeff-github-sentinel/79d7eb73-b729-4446-b852-aabebe091c9c/scratchpad';
const inject = readFileSync(path.join(here, 'inject.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (body) =>
  fetch(BRIDGE_URL + '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('sentinel.theme.v1', 'dark');
  } catch {}
});
await ctx.addInitScript(inject);
const page = await ctx.newPage();
page.on('pageerror', (e) => {
  if (!/ResizeObserver/.test(e.message)) console.log('[pageerror]', e.message);
});
await post({ type: '__demo_reset' });
await page.goto(STAGE_URL, { waitUntil: 'domcontentloaded' });
const app = page.frameLocator('#app');
await app
  .getByRole('button', { name: 'Optimize', exact: false })
  .first()
  .waitFor({ timeout: 20000 });
await sleep(600);
const TAB_IDS = {
  Accounts: 'accounts',
  Security: 'security',
  Alerts: 'notifications',
  Usage: 'usage',
};
const nav = (name) => app.locator(`[data-tour-id="tab-${TAB_IDS[name]}"]`).first();
const shot = async (n) => {
  await page.screenshot({ path: `${OUT}/d2_${n}.png` });
  console.log('shot', n);
};

// 1. Security tab — events list
await nav('Security')
  .click()
  .catch((e) => console.log('nav Security', e.message));
await sleep(1100);
await shot('security_events');
// live event in flight + pending block banner
await post({
  type: '__demo_security_event',
  severity: 'high',
  kind: 'secret',
  title: 'GitHub token',
  matchMask: 'ghp_…[24 redacted]…9f',
  sourceHint: 'WebFetch(api.github.com)',
  blocked: true,
});
await sleep(900);
await post({
  type: '__demo_security_block',
  severity: 'high',
  title: 'Secret blocked: GitHub token',
  blockReason: 'A GitHub personal access token was about to leave your machine.',
  source: 'scanner',
  matchMask: 'ghp_…[24 redacted]…9f',
  toolInputFields: { url: 'https://api.github.com/user/repos' },
});
await sleep(1100);
await shot('security_block');

// 2. Alerts tab + fake notification
await nav('Alerts')
  .click()
  .catch((e) => console.log('nav Alerts', e.message));
await sleep(1100);
await shot('alerts');
await page.evaluate(
  () =>
    window.__demo &&
    window.__demo.notify({
      title: 'Acme Labs at 80%',
      body: 'Crossed your 80% threshold on the 5-hour window.',
    }),
);
await post({
  type: '__demo_alert',
  accountId: 'org-acme',
  scope: 'account',
  thresholdPct: 80,
  utilization: 0.82,
});
await sleep(900);
await shot('alerts_notify');

// 4. Accounts tab — switching toggle + switch
await nav('Accounts')
  .click()
  .catch((e) => console.log('nav Accounts', e.message));
await sleep(1000);
await shot('accounts');

// 3. Settings -> Security -> Permissions (rules) and Isolation (sandbox), last
await app
  .locator('[data-tour-id="tour-permissions"]')
  .first()
  .click()
  .catch((e) => console.log('open settings', e.message));
await sleep(900);
await shot('settings_open');
await app
  .getByRole('radio', { name: 'Permissions', exact: false })
  .first()
  .click()
  .catch((e) => console.log('perm radio', e.message));
await sleep(900);
await shot('rules');
await app
  .getByRole('radio', { name: 'Isolation', exact: false })
  .first()
  .click()
  .catch((e) => console.log('iso radio', e.message));
await sleep(900);
await shot('sandbox');

// dump control geometry for the views that need precise taps
const geo = await page
  .frames()
  .find((f) => f.url().startsWith(APP_URL))
  .evaluate(() => {
    const pick = (sel) =>
      [...document.querySelectorAll(sel)]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
          return t
            ? `${t} @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`
            : null;
        })
        .filter(Boolean)
        .slice(0, 30);
    return { rolesAndButtons: pick('button,[role=radio],[role=tab]') };
  });
console.log('GEO:', JSON.stringify(geo, null, 1));
await browser.close();
console.log('done');
