#!/usr/bin/env node
// Regenerate packages/app/src-tauri/icons/icon.ico from the 512x512 master
// (icons/icon.png) with the FULL Windows DPI ladder.
//
// Why this exists (instead of `tauri icon`): the Tauri CLI emits only
// 16/24/32/48/64/256, and Windows Explorer requests intermediate sizes at
// fractional DPI scaling (60/72/96 at 125-150%). With the rungs missing,
// the shell UPSCALES the 64px entry rather than downscaling the 256px one,
// which is exactly the "pixelated desktop icon" report this fixes.
//
// Entry order is LARGEST FIRST, deliberately: tauri-codegen builds the
// runtime window icon from entries()[0] only (tauri #14596), so whatever
// sits first is what the Windows taskbar/titlebar renders. 256 first means
// the shell downscales cleanly; the old 32-first ordering shipped a 32px
// taskbar icon upscaled at every modern DPI. Do not "fix" the order back.
//
// Encoding follows the classic shell-compatibility rule: 256 is
// PNG-compressed (required to keep the file small; universally supported at
// that size), every smaller entry is an uncompressed 32bpp BMP (BGRA,
// bottom-up, with an AND mask), which every icon consumer handles.
//
//   node scripts/generate-ico.mjs            # regenerate icon.ico
//   node scripts/generate-ico.mjs --verify   # re-parse + assert the output
//
// Sharp is a root devDependency used only by this script; icons change
// rarely and the output is committed.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = join(root, 'packages/app/src-tauri/icons');
const MASTER = join(iconsDir, 'icon.png');
const OUT = join(iconsDir, 'icon.ico');

// Largest first (see header). 20/40/60/72/96 are the fractional-DPI rungs
// (125/150/200% of 16/32/48); 128 covers Explorer's extra-large grid.
const PNG_SIZES = [256];
const BMP_SIZES = [128, 96, 72, 64, 60, 48, 40, 32, 24, 20, 16];

/** Encode one size as an uncompressed 32bpp BMP ICO image block:
 *  BITMAPINFOHEADER (biHeight doubled for the AND mask) + bottom-up BGRA
 *  rows + an all-zero AND mask (alpha channel supersedes it, but the block
 *  must be present and row-padded to 32 bits). */
function encodeBmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: XOR + AND halves
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  // Remaining fields (sizeImage, resolutions, palette) stay zero.

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x++) {
      const src = (srcRow * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = rgba[src + 2]; // B
      xor[dst + 1] = rgba[src + 1]; // G
      xor[dst + 2] = rgba[src]; // R
      xor[dst + 3] = rgba[src + 3]; // A
    }
  }

  const maskStride = Math.ceil(size / 32) * 4; // 1bpp rows padded to 32 bits
  const and = Buffer.alloc(maskStride * size); // all zero: fully opaque mask
  return Buffer.concat([header, xor, and]);
}

async function generate() {
  // Lazy import: --verify (run in CI) only re-parses the committed binary
  // and must not depend on sharp's native module resolving.
  const { default: sharp } = await import('sharp');
  const master = sharp(readFileSync(MASTER));
  const meta = await master.metadata();
  if ((meta.width ?? 0) < 256 || (meta.height ?? 0) < 256) {
    throw new Error(`master ${MASTER} must be at least 256x256 (got ${meta.width}x${meta.height})`);
  }

  /** @type {{ size: number, data: Buffer }[]} */
  const entries = [];
  for (const size of PNG_SIZES) {
    const data = await sharp(readFileSync(MASTER)).resize(size, size).png().toBuffer();
    entries.push({ size, data });
  }
  for (const size of BMP_SIZES) {
    const { data } = await sharp(readFileSync(MASTER))
      .resize(size, size)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    entries.push({ size, data: encodeBmpEntry(size, data) });
  }

  const dirSize = 6 + entries.length * 16;
  const headerBuf = Buffer.alloc(dirSize);
  headerBuf.writeUInt16LE(0, 0); // reserved
  headerBuf.writeUInt16LE(1, 2); // type 1 = ICO
  headerBuf.writeUInt16LE(entries.length, 4);

  let offset = dirSize;
  entries.forEach((e, i) => {
    const at = 6 + i * 16;
    headerBuf.writeUInt8(e.size === 256 ? 0 : e.size, at); // bWidth (0 = 256)
    headerBuf.writeUInt8(e.size === 256 ? 0 : e.size, at + 1); // bHeight
    headerBuf.writeUInt8(0, at + 2); // colors in palette
    headerBuf.writeUInt8(0, at + 3); // reserved
    headerBuf.writeUInt16LE(1, at + 4); // planes
    headerBuf.writeUInt16LE(32, at + 6); // bit count
    headerBuf.writeUInt32LE(e.data.length, at + 8);
    headerBuf.writeUInt32LE(offset, at + 12);
    offset += e.data.length;
  });

  writeFileSync(OUT, Buffer.concat([headerBuf, ...entries.map((e) => e.data)]));
  console.log(
    `wrote ${OUT}: ${entries.length} entries (${[...PNG_SIZES, ...BMP_SIZES].join(', ')})`,
  );
}

/** Re-parse the written .ico and assert the shape this script promises.
 *  Exits non-zero on any mismatch so CI or a pre-release check can gate. */
function verify() {
  const d = readFileSync(OUT);
  const fail = (msg) => {
    console.error(`icon.ico verify FAILED: ${msg}`);
    process.exit(1);
  };
  if (d.readUInt16LE(0) !== 0 || d.readUInt16LE(2) !== 1) fail('bad ICONDIR header');
  const count = d.readUInt16LE(4);
  const expected = [...PNG_SIZES, ...BMP_SIZES];
  if (count !== expected.length) fail(`expected ${expected.length} entries, found ${count}`);
  const isPng = (off) => d.subarray(off, off + 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const size = d.readUInt8(at) || 256;
    const bytes = d.readUInt32LE(at + 8);
    const off = d.readUInt32LE(at + 12);
    if (size !== expected[i]) fail(`entry ${i} is ${size}px, expected ${expected[i]}px`);
    if (PNG_SIZES.includes(size)) {
      if (!isPng(off)) fail(`entry ${i} (${size}px) should be PNG-compressed`);
    } else {
      if (isPng(off)) fail(`entry ${i} (${size}px) should be an uncompressed BMP`);
      if (d.readUInt32LE(off) !== 40) fail(`entry ${i} (${size}px) has a bad BITMAPINFOHEADER`);
      if (d.readInt32LE(off + 8) !== size * 2)
        fail(`entry ${i} (${size}px) biHeight must be doubled for the AND mask`);
      if (d.readUInt16LE(off + 14) !== 32) fail(`entry ${i} (${size}px) must be 32bpp`);
    }
    if (off + bytes > d.length) fail(`entry ${i} (${size}px) overruns the file`);
  }
  if ((d.readUInt8(6) || 256) !== 256) {
    fail(
      'entry[0] must be the 256px image: tauri-codegen renders the runtime window icon from entries()[0] (tauri #14596)',
    );
  }
  console.log(`icon.ico verified: ${count} entries, 256px PNG first, BMP ladder below`);
}

if (process.argv.includes('--verify')) {
  verify();
} else {
  await generate();
  verify();
}
