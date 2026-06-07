#!/usr/bin/env node
// Regenerate every committed raster icon asset from the two SVG masters:
//
//   packages/app/src-tauri/icons/icon-source.svg   (512 app icon: #0593D8
//                                                   rounded square + white glyph)
//   packages/app/src-tauri/icons/tray-source.svg   (32 tray silhouette: white
//                                                   glyph + alpha, NO background)
//
// Outputs (all committed; never edit the rasters by hand):
//   - icon.png (512 master) + 32x32 / 64x64 / 128x128 / 128x128@2x PNGs
//   - Square{30,44,71,89,107,142,150,284,310}Logo.png + StoreLogo.png (50)
//   - icon.icns via `iconutil` (macOS hosts only; skipped elsewhere)
//   - tray-icon.png — the Rust tray renderer (tray_icon_render.rs) re-tints
//     non-transparent pixels at runtime, so every opaque pixel must be pure
//     white with shape carried by alpha; this script asserts that contract.
//   - packages/daemon/src/logo.ts — base64 of 128x128.png for the OAuth page
//   - icon.ico — delegated to scripts/generate-ico.mjs (256-PNG-first +
//     uncompressed-BMP DPI ladder; CI verifies that exact shape)
//
// Every size is rasterized straight from the SVG at the target density (no
// chained downscales), except the tray icon which is supersampled 8x and
// downscaled once for smoother 32px edges.
//
//   node scripts/generate-icons.mjs          # regenerate everything
//
// Sharp is a root devDependency shared with generate-ico.mjs; icons change
// rarely and the output is committed.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'packages/app/src-tauri/icons');
const ICON_SVG = join(iconsDir, 'icon-source.svg');
const TRAY_SVG = join(iconsDir, 'tray-source.svg');
const LOGO_TS = join(root, 'packages/daemon/src/logo.ts');

/** Rasterize an SVG master at an exact pixel size. The masters have a
 *  natural size (512 / 32) at the SVG default 72dpi, so scaling density
 *  keeps librsvg rendering vectors at the target resolution instead of
 *  sharp resampling a fixed-size raster. */
async function renderSvg(svgPath, size, naturalSize) {
  return sharp(svgPath, { density: (72 * size) / naturalSize })
    .resize(size, size)
    .png()
    .toBuffer();
}

async function writePng(buffer, name) {
  writeFileSync(join(iconsDir, name), buffer);
  console.log(`wrote ${name}`);
}

async function generateAppIcons() {
  // Tauri bundle PNGs (tauri.conf.json bundle.icon) + the 512 master that
  // generate-ico.mjs consumes. 128x128@2x is 256px by definition.
  const bundle = [
    [512, 'icon.png'],
    [32, '32x32.png'],
    [64, '64x64.png'],
    [128, '128x128.png'],
    [256, '128x128@2x.png'],
  ];
  // Windows Store / MSIX logo set. Square sizes match the committed files.
  const square = [30, 44, 71, 89, 107, 142, 150, 284, 310].map((n) => [
    n,
    `Square${n}x${n}Logo.png`,
  ]);
  for (const [size, name] of [...bundle, ...square, [50, 'StoreLogo.png']]) {
    await writePng(await renderSvg(ICON_SVG, size, 512), name);
  }
}

async function generateIcns() {
  if (process.platform !== 'darwin') {
    console.warn('skipping icon.icns: iconutil requires macOS');
    return;
  }
  // Apple's member names are exact and unforgiving; the @2x entries are
  // rendered from the SVG at full size, never upscaled.
  const members = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  const setDir = mkdtempSync(join(tmpdir(), 'sentinel-iconset-'));
  const iconset = join(setDir, 'icon.iconset');
  spawnSync('mkdir', [iconset]);
  for (const [size, name] of members) {
    writeFileSync(join(iconset, name), await renderSvg(ICON_SVG, size, 512));
  }
  const res = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', join(iconsDir, 'icon.icns')]);
  rmSync(setDir, { recursive: true, force: true });
  if (res.status !== 0) {
    console.error(`iconutil failed: ${res.stderr}`);
    process.exit(1);
  }
  console.log('wrote icon.icns');
}

async function generateTrayIcon() {
  // Supersample 8x then downscale once for smooth 32px alpha edges. One
  // sharp pipeline end to end: a PNG round-trip between rasterize and
  // resize quantizes the premultiplied edges to slightly-off-white RGB,
  // which the contract check below would (rightly) reject.
  const buf = await sharp(TRAY_SVG, { density: (72 * 256) / 32 })
    .resize(32, 32)
    .png()
    .toBuffer();
  // Assert the tint contract before committing the file: tray_icon_render.rs
  // replaces the RGB of every non-transparent pixel and keeps alpha, so any
  // non-white opaque pixel means the source grew a background by mistake.
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let opaque = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] === 0) continue;
    opaque += 1;
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) {
      console.error('tray-icon.png contract violation: non-white opaque pixel');
      process.exit(1);
    }
  }
  if (opaque === 0) {
    console.error('tray-icon.png contract violation: fully transparent render');
    process.exit(1);
  }
  await writePng(buf, 'tray-icon.png');
}

async function generateOauthLogo() {
  const b64 = readFileSync(join(iconsDir, '128x128.png')).toString('base64');
  const ts = `// Auto-generated from packages/app/src-tauri/icons/128x128.png.
// Inlined so the OAuth callback page (served by oauth.ts at
// localhost:47285) can display the Sentinel logo without the daemon
// shipping a static-asset server.
export const SENTINEL_LOGO_DATA_URL =
  'data:image/png;base64,${b64}';
`;
  writeFileSync(LOGO_TS, ts);
  console.log('wrote packages/daemon/src/logo.ts');
}

await generateAppIcons();
await generateIcns();
await generateTrayIcon();
await generateOauthLogo();

// icon.ico last: generate-ico.mjs reads the freshly written 512 master and
// self-verifies the DPI-ladder shape CI enforces.
const ico = spawnSync(process.execPath, [join(root, 'scripts/generate-ico.mjs')], {
  stdio: 'inherit',
});
if (ico.status !== 0) process.exit(ico.status ?? 1);
