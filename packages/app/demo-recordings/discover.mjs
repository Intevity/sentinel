#!/usr/bin/env node
// Discovery helper: loads the macOS stage, visits each requested tab/sub-tab,
// screenshots the desktop, and dumps the app frame's visible controls + a few
// text lines so recipes can be tuned to real labels/positions. Read-only.
//   node discover.mjs [tab:subtab ...]   e.g. node discover.mjs Metrics Optimize:Context
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const { chromium } = require('@playwright/test');

const APP_URL = process.env.APP_URL || 'http://localhost:5180';
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:47999';
const STAGE_URL = `${BRIDGE_URL}/stage?app=${encodeURIComponent(APP_URL)}`;
const OUT =
  process.env.OUT_DIR ||
  '/private/tmp/claude-501/-Users-jeff-github-sentinel/79d7eb73-b729-4446-b852-aabebe091c9c/scratchpad';
const inject = readFileSync(path.join(here, 'inject.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['Accounts', 'Usage', 'Metrics', 'Optimize:Subagents', 'Optimize:Context'];

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
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(STAGE_URL, { waitUntil: 'domcontentloaded' });
const app = page.frameLocator('#app');
await app
  .getByRole('button', { name: 'Optimize', exact: false })
  .first()
  .waitFor({ timeout: 20000 });
const dz = app.locator('[aria-label="Dismiss"]');
for (let i = await dz.count(); i > 0; i--)
  await dz
    .first()
    .click()
    .catch(() => {});
await sleep(600);

const appFrame = () => page.frames().find((f) => f.url().startsWith(APP_URL));

for (const t of targets) {
  const [tab, sub] = t.split(':');
  await app
    .getByRole('button', { name: tab, exact: false })
    .first()
    .click()
    .catch(() => {});
  await sleep(900);
  if (sub) {
    await app
      .getByRole('tab', { name: sub, exact: false })
      .first()
      .click()
      .catch(() => {});
    await sleep(900);
  }
  const name = t.replace(':', '_');
  await page.screenshot({ path: `${OUT}/disc_${name}.png` });
  const dump = await appFrame().evaluate(() => {
    const ctrls = [];
    for (const el of document.querySelectorAll('button,[role="tab"]')) {
      const tx = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
      if (tx) ctrls.push(`${el.getAttribute('role') || el.tagName}:"${tx}"`);
    }
    const txt = (document.body.innerText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 24);
    return { ctrls: [...new Set(ctrls)].slice(0, 30), txt };
  });
  console.log(`\n=== ${t} ===`);
  console.log('controls:', dump.ctrls.join('  '));
  console.log('text:', dump.txt.join(' | '));
}

await browser.close();
console.log('\ndone');
