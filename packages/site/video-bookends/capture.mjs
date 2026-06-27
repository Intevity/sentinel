#!/usr/bin/env node
// Headless, frame-exact render of the bookend pages to 1920x1080 MP4.
//
//   node capture.mjs                  # everything: 15 scene intros + promo
//   node capture.mjs scenes           # all 15 contextual cold-open intros
//   node capture.mjs scenes compression scanning   # just those slugs
//   node capture.mjs promo            # the terminal promo intro + outro
//
// Scene intros come from intro-scene.html?slug=<slug> and are written as
// <slug>-intro.mp4. Drives the Chromium that @playwright/test installs (a
// devDependency of @sentinel/app) and transcodes WebM to H.264 MP4 with ffmpeg.
// Alternative: open any .html fullscreen and screen-record it (see README.md).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// The 15 clip slugs, in carousel-then-pillar order.
const SLUGS = [
  'security',
  'optimize',
  'accounts',
  'usage',
  'alerts',
  'metrics',
  'switching',
  'pool',
  'caps',
  'scanning',
  'rules',
  'sandbox',
  'subagents',
  'compression',
  'codemode',
];

// Resolve Playwright from packages/app, where it is declared.
const appPkg = fileURLToPath(new URL('../../app/package.json', import.meta.url));
let chromium;
try {
  ({ chromium } = createRequire(appPkg)('@playwright/test'));
} catch (err) {
  console.error(
    'Could not load @playwright/test from packages/app.\n' +
      'Install it first:  pnpm --filter @sentinel/app exec playwright install chromium\n' +
      String(err),
  );
  process.exit(1);
}

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

function transcode(webm, outMp4) {
  const ff = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      webm,
      '-vf',
      `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '18',
      '-movflags',
      '+faststart',
      outMp4,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (ff.status !== 0) {
    console.error(`\nffmpeg failed (exit ${ff.status}). WebM kept at:\n  ${webm}`);
    return false;
  }
  return true;
}

// Render one page (file URL) to <outName>.mp4.
async function renderPage(pageUrl, outName) {
  const tmp = mkdtempSync(path.join(tmpdir(), `sentinel-${outName}-`));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
    recordVideo: { dir: tmp, size: { width: WIDTH, height: HEIGHT } },
  });
  const page = await context.newPage();
  await page.goto(pageUrl, { waitUntil: 'load' });

  const durationMs = await page.evaluate(
    () => (window.SENTINEL_BOOKEND && window.SENTINEL_BOOKEND.durationMs) || 8000,
  );
  try {
    await page.waitForFunction('window.__animDone === true', { timeout: durationMs + 5000 });
  } catch {
    await page.waitForTimeout(durationMs);
  }
  await page.waitForTimeout(400);

  const video = page.video();
  await context.close();
  await browser.close();

  const webm = await video.path();
  const outMp4 = path.join(here, `${outName}.mp4`);
  const ok = transcode(webm, outMp4);
  if (ok) {
    console.log(`✓ ${outName}.mp4`);
    rmSync(tmp, { recursive: true, force: true });
  }
  return ok;
}

const fileUrl = (name, qs) => `file://${path.join(here, name)}${qs ? `?${qs}` : ''}`;

async function renderScenes(slugs) {
  let ok = true;
  for (const slug of slugs) {
    if (!SLUGS.includes(slug)) {
      console.error(`Unknown slug: ${slug} (known: ${SLUGS.join(', ')})`);
      ok = false;
      continue;
    }
    console.log(`Rendering ${slug} intro…`);
    // eslint-disable-next-line no-await-in-loop
    ok =
      (await renderPage(fileUrl('intro-scene.html', `slug=${slug}&capture`), `${slug}-intro`)) &&
      ok;
  }
  return ok;
}

async function renderOutros(slugs) {
  let ok = true;
  for (const slug of slugs) {
    if (!SLUGS.includes(slug)) {
      console.error(`Unknown slug: ${slug} (known: ${SLUGS.join(', ')})`);
      ok = false;
      continue;
    }
    console.log(`Rendering ${slug} outro…`);
    // eslint-disable-next-line no-await-in-loop
    ok =
      (await renderPage(
        fileUrl('card.html', `slug=${slug}&kind=outro&capture`),
        `${slug}-outro`,
      )) && ok;
  }
  return ok;
}

async function renderPromo() {
  let ok = true;
  for (const name of ['intro', 'outro']) {
    console.log(`Rendering promo ${name}…`);
    // eslint-disable-next-line no-await-in-loop
    ok = (await renderPage(fileUrl(`${name}.html`, 'capture'), name)) && ok;
  }
  return ok;
}

async function renderClips(slugs) {
  return (await renderScenes(slugs)) && (await renderOutros(slugs));
}

const [cmd, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let ok = true;
if (!cmd) {
  // Everything for the 15 clips: a cold-open intro and a takeaway outro each.
  ok = await renderClips(SLUGS);
} else if (cmd === 'clips') {
  ok = await renderClips(rest.length ? rest : SLUGS);
} else if (cmd === 'scenes' || cmd === 'scene' || cmd === 'intros') {
  ok = await renderScenes(rest.length ? rest : SLUGS);
} else if (cmd === 'outros') {
  ok = await renderOutros(rest.length ? rest : SLUGS);
} else if (cmd === 'promo') {
  ok = await renderPromo();
} else if (SLUGS.includes(cmd)) {
  ok = await renderClips([cmd, ...rest]);
} else if (cmd === 'intro' || cmd === 'outro') {
  ok = await renderPage(fileUrl(`${cmd}.html`, 'capture'), cmd); // back-compat: terminal promo
} else {
  console.error(`Unknown command: ${cmd}`);
  ok = false;
}
process.exit(ok ? 0 : 1);
