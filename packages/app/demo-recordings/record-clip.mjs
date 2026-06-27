#!/usr/bin/env node
// Demo-clip recorder. Drives the real Sentinel UI at its true tray size
// (540x628) inside the mock macOS desktop (stage.html, served by the mock
// bridge) with a synthetic cursor, runs a per-slug "recipe" (recipes.mjs),
// records 1920x1080, applies an optional Screen-Studio push-in in post with
// ffmpeg zoompan, then composites the matching bookends
// (<slug>-intro.mp4 -> app -> <slug>-outro.mp4) into the final clip.
//
//   node record-clip.mjs <slug> [--no-bookends]
//   APP_URL=http://localhost:5180 BRIDGE_URL=http://127.0.0.1:47999
//
// Outputs (under demo-recordings/out/):
//   <slug>-app.mp4   the bare app recording (zoomed)
//   <slug>.mp4       the bookended composite (the site clip)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RECIPES } from './recipes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const { chromium } = require('@playwright/test');

const slug = process.argv[2];
const noBookends = process.argv.includes('--no-bookends');
if (!slug || !RECIPES[slug]) {
  console.error(
    `usage: node record-clip.mjs <slug>\nknown slugs: ${Object.keys(RECIPES).join(', ')}`,
  );
  process.exit(2);
}
const recipe = RECIPES[slug];

const APP_URL = process.env.APP_URL || 'http://localhost:5180';
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:47999';
const STAGE_URL = `${BRIDGE_URL}/stage?app=${encodeURIComponent(APP_URL)}`;
const BOOKENDS = path.join(here, '..', '..', 'site', 'video-bookends');
const OUT_DIR = path.join(here, 'out');
const W = 1920;
const H = 1080;
const FPS = 30;
const inject = readFileSync(path.join(here, 'inject.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (type, extra = {}) =>
  fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...extra }),
  });

function run(bin, args) {
  return spawnSync(bin, args, { stdio: ['ignore', 'ignore', 'inherit'] }).status === 0;
}

// Smoothstep S(p) in [0,1], comma-free so it survives the filtergraph parser.
const smooth = (p) => `(3*${p}*${p}-2*${p}*${p}*${p})`;

function zoomFilter({ startF, endF, cx, cy, zmax }) {
  const inDur = 24; // ~0.8s ease in
  const outDur = 22;
  const F1 = Math.max(0, startF - 6);
  const F2 = F1 + inDur;
  const F3 = endF + 6;
  const F4 = F3 + outDur;
  const pIn = `((on-${F1})/(${F2 - F1}))`;
  const pOut = `((on-${F3})/(${F4 - F3}))`;
  const S = `if(lt(on,${F1}),0,if(lt(on,${F2}),${smooth(pIn)},if(lt(on,${F3}),1,if(lt(on,${F4}),(1-${smooth(pOut)}),0))))`;
  const z = `1+${(zmax - 1).toFixed(3)}*(${S})`;
  const x = `clip(${cx}*zoom-${W / 2},0,iw*zoom-${W})`;
  const y = `clip(${cy}*zoom-${H / 2},0,ih*zoom-${H})`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${FPS}`;
}

const browser = await chromium.launch({ headless: true });
const tmp = mkdtempSync(path.join(tmpdir(), 'sentinel-rec-'));
const recordCtx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2, // crisp text in the small (540px) app window
  reducedMotion: 'no-preference',
  colorScheme: 'dark',
  recordVideo: { dir: tmp, size: { width: W, height: H } },
});
await recordCtx.addInitScript(() => {
  try {
    localStorage.setItem('sentinel.theme.v1', 'dark');
  } catch {
    /* storage unavailable */
  }
});
await recordCtx.addInitScript(inject);
const page = await recordCtx.newPage();
const t0 = Date.now();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await post('__demo_reset');
await page.goto(STAGE_URL, { waitUntil: 'domcontentloaded' });

const app = page.frameLocator('#app');
// The Frame object (for scrolling/evaluate inside the cross-origin iframe).
const appFrame = () => page.frames().find((f) => f.url().startsWith(APP_URL));

await app
  .getByRole('button', { name: 'Optimize', exact: false })
  .first()
  .waitFor({ timeout: 20000 });
const dismissers = app.locator('[aria-label="Dismiss"]');
for (let i = await dismissers.count(); i > 0; i--) {
  await dismissers
    .first()
    .click()
    .catch(() => {});
}
await sleep(700);

// ---- shared recipe helpers (ctx) ----
async function moveCursorTo(x, y, ms = 640) {
  await page.evaluate(([ax, ay, ams]) => window.__demo.moveTo(ax, ay, ams), [x, y, ms]);
  await sleep(ms + 40);
}
async function tap(locator, moveMs = 660) {
  const box = await locator.boundingBox();
  if (!box) {
    await locator.click({ timeout: 4000 }).catch(() => {});
    return;
  }
  await moveCursorTo(box.x + box.width / 2, box.y + box.height / 2, moveMs);
  await page.evaluate(() => window.__demo.clickPulse());
  await sleep(110);
  await locator.click().catch(() => {});
}
// Map nav-tab label -> the stable data-tour-id the App renders, so we hit the
// segmented nav tab and never the header's aria-label="Security" shield (which
// shares the "Security" accessible name and opens Settings instead).
const TAB_IDS = {
  Accounts: 'accounts',
  Security: 'security',
  Alerts: 'notifications',
  Usage: 'usage',
  Optimize: 'optimize',
  Metrics: 'metrics',
  Logs: 'logs',
};
async function openTab(name) {
  const id = TAB_IDS[name];
  const loc = id
    ? app.locator(`[data-tour-id="tab-${id}"]`).first()
    : app.getByRole('button', { name, exact: false }).first();
  await tap(loc);
}
async function openSubTab(name) {
  await tap(app.getByRole('tab', { name, exact: false }).first());
}
// Open Settings at the permissions section via the header shield (its onClick
// calls openSettingsAt('tool-permissions-toggle')), then optionally switch the
// Security-settings sub-radio (Scanning / Permissions / Isolation / Sync).
async function openSettings(radio) {
  await tap(app.locator('[data-tour-id="tour-permissions"]').first());
  await sleep(500);
  if (radio) {
    await tap(app.getByRole('radio', { name: radio, exact: false }).first());
    await sleep(300);
  }
}
async function tapSel(selector, moveMs = 620) {
  await tap(app.locator(selector).first(), moveMs);
}
async function waitText(text, timeout = 9000) {
  await app.getByText(text, { exact: false }).first().waitFor({ timeout });
}
async function focalOf(text, dx = 0, dy = 0) {
  const b = await app.getByText(text, { exact: false }).first().boundingBox();
  return b
    ? { cx: Math.round(b.x + b.width / 2 + dx), cy: Math.round(b.y + dy) }
    : { cx: 960, cy: 460 };
}
async function scrollApp(y) {
  const f = appFrame();
  if (f) await f.evaluate((dy) => window.scrollTo({ top: dy, behavior: 'smooth' }), y);
  await sleep(500);
}

const ctx = {
  app,
  page,
  slug,
  sleep,
  post,
  W,
  H,
  now: () => Date.now() - t0,
  moveCursorTo,
  tap,
  openTab,
  openSubTab,
  openSettings,
  tapSel,
  waitText,
  focalOf,
  scrollApp,
  // recipe sets ctx.zoom = { startMs, endMs, cx, cy, zmax }
  zoom: null,
};

await recipe.run(ctx);

const video = page.video();
await recordCtx.close();
await browser.close();
const webm = await video.path();

mkdirSync(OUT_DIR, { recursive: true });

// Pass 1: normalize webm -> 30fps 1920x1080 clean mp4.
const clean = path.join(tmp, 'clean.mp4');
run('ffmpeg', [
  '-y',
  '-i',
  webm,
  '-vf',
  `fps=${FPS},scale=${W}:${H}:flags=lanczos`,
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-crf',
  '18',
  clean,
]);

// Pass 2: optional zoompan push-in.
const appOut = path.join(OUT_DIR, `${slug}-app.mp4`);
let okApp;
if (ctx.zoom) {
  const fudgeMs = 120;
  const startF = Math.round(((ctx.zoom.startMs + fudgeMs) / 1000) * FPS);
  const endF = Math.round(((ctx.zoom.endMs + fudgeMs) / 1000) * FPS);
  const vf = zoomFilter({
    startF,
    endF,
    cx: ctx.zoom.cx,
    cy: ctx.zoom.cy,
    zmax: ctx.zoom.zmax ?? 1.6,
  });
  okApp = run('ffmpeg', [
    '-y',
    '-i',
    clean,
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '18',
    '-movflags',
    '+faststart',
    appOut,
  ]);
  console.log(`zoom: frames ${startF}-${endF}, focus ${ctx.zoom.cx},${ctx.zoom.cy}`);
} else {
  okApp = run('ffmpeg', [
    '-y',
    '-i',
    clean,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '18',
    '-movflags',
    '+faststart',
    appOut,
  ]);
}
if (!okApp) {
  console.error('app encode failed');
  process.exit(1);
}
console.log(`✓ ${appOut}`);

// Composite the bookends -> final site clip.
if (!noBookends) {
  const intro = path.join(BOOKENDS, `${slug}-intro.mp4`);
  const outro = path.join(BOOKENDS, `${slug}-outro.mp4`);
  if (existsSync(intro) && existsSync(outro)) {
    const finalOut = path.join(OUT_DIR, `${slug}.mp4`);
    const norm = (label) => `${label}fps=${FPS},scale=${W}:${H}:flags=lanczos,setsar=1`;
    const ok = run('ffmpeg', [
      '-y',
      '-i',
      intro,
      '-i',
      appOut,
      '-i',
      outro,
      '-filter_complex',
      `[0:v]${norm('')}[a];[1:v]${norm('')}[b];[2:v]${norm('')}[c];[a][b][c]concat=n=3:v=1:a=0[v]`,
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '18',
      '-movflags',
      '+faststart',
      finalOut,
    ]);
    console.log(ok ? `✓ ${finalOut}` : 'composite failed');
  } else {
    console.log(`(no bookends for ${slug}; skipping composite)`);
  }
}

rmSync(tmp, { recursive: true, force: true });
process.exit(0);
