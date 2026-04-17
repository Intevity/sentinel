#!/usr/bin/env node
/**
 * Build the daemon CLI into a self-contained, platform-specific binary for
 * use as a Tauri sidecar.
 *
 * Two-step process:
 *   1. esbuild bundles all ESM/TS source into a single CJS file.
 *      better-sqlite3 is bundled alongside its JS source, but its native
 *      'bindings' module is replaced with a shim that loads the .node file
 *      from the same directory as the bundle. This relative require is what
 *      pkg can statically detect and embed as an asset.
 *   2. @yao-pkg/pkg wraps a Node.js runtime around the CJS bundle, producing
 *      a standalone executable. The .node file is embedded as an asset.
 *
 * The target triple is derived from `rustc -vV` so it always matches whatever
 * `tauri build` will compile for, regardless of Node.js architecture.
 *
 * Output: packages/app/src-tauri/binaries/claude-sentinel-daemon-<triple>[.exe]
 */
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DAEMON_ROOT  = join(__dirname, '..');
const BINARIES_DIR = join(__dirname, '../../app/src-tauri/binaries');
const DIST_DIR     = join(DAEMON_ROOT, 'dist');
const BUNDLE_PATH  = join(DIST_DIR, 'bundle.cjs');
const SHIM_PATH    = join(DIST_DIR, 'bindings-shim.cjs');

// Rust target triple → @yao-pkg/pkg target string
const TRIPLE_TO_PKG = {
  'aarch64-apple-darwin':       'node22-macos-arm64',
  'x86_64-apple-darwin':        'node22-macos-x64',
  'x86_64-unknown-linux-gnu':   'node22-linux-x64',
  'aarch64-unknown-linux-gnu':  'node22-linux-arm64',
  'x86_64-pc-windows-msvc':     'node22-win-x64',
};

function getRustTriple() {
  try {
    const out = execSync('rustc -vV', { encoding: 'utf8' });
    const match = /^host:\s+(\S+)/m.exec(out);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

const triple = process.env.CARGO_BUILD_TARGET ?? getRustTriple();
if (!triple) {
  console.error('[build-sidecar] Could not determine Rust target triple.');
  process.exit(1);
}

const pkgTarget = TRIPLE_TO_PKG[triple];
if (!pkgTarget) {
  console.error(`[build-sidecar] No pkg target mapped for: ${triple}`);
  console.error(`  Supported: ${Object.keys(TRIPLE_TO_PKG).join(', ')}`);
  process.exit(1);
}

mkdirSync(BINARIES_DIR, { recursive: true });
mkdirSync(DIST_DIR, { recursive: true });

const ext    = triple.includes('windows') ? '.exe' : '';
const output = join(BINARIES_DIR, `claude-sentinel-daemon-${triple}${ext}`);

console.log(`[build-sidecar] Rust triple : ${triple}`);
console.log(`[build-sidecar] pkg target  : ${pkgTarget}`);
console.log(`[build-sidecar] Output      : ${output}`);

// ── Resolve the native .node file (follows pnpm symlinks) ───────────────────
const req = createRequire(pathToFileURL(join(DAEMON_ROOT, 'package.json')));
const nativeAddonSrc = req.resolve(
  'better-sqlite3/build/Release/better_sqlite3.node',
);
console.log(`[build-sidecar] Native addon: ${nativeAddonSrc}`);

// Copy the .node file into dist/ so it sits beside the bundle.
// pkg detects require('./better_sqlite3.node') in the bundle and embeds it.
const nativeAddonDst = join(DIST_DIR, 'better_sqlite3.node');
copyFileSync(nativeAddonSrc, nativeAddonDst);

// ── Write the 'bindings' shim ────────────────────────────────────────────────
// better-sqlite3 loads its native module via require('bindings')('better_sqlite3.node').
// This shim replaces the bindings package with one that loads the .node file
// from the same directory as the bundle — a static, relative require that pkg
// can detect at build time and embed as an asset.
// Static require so esbuild can trace the dependency at build time
// (the dynamic './' + name form causes esbuild to scan all files in dist/).
// We only use bindings for better_sqlite3.node, so hardcoding is safe.
writeFileSync(SHIM_PATH, `\
'use strict';
module.exports = function bindings(_file) {
  return require('./better_sqlite3.node');
};
`);

// ── Step 1: bundle all source into a single CJS file ────────────────────────
console.log('[build-sidecar] Bundling with esbuild…');
execSync(
  [
    'esbuild dist/cli.js',
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=cjs',
    `--outfile="${BUNDLE_PATH}"`,
    // Replace 'bindings' with our shim; mark .node files as external so
    // esbuild emits require('./better_sqlite3.node') in the bundle output.
    `--alias:bindings=${SHIM_PATH}`,
    '--external:*.node',
  ].join(' '),
  { cwd: DAEMON_ROOT, stdio: 'inherit' },
);

// ── Step 2: wrap the bundle + .node asset in a Node.js runtime via pkg ───────
console.log('[build-sidecar] Packaging with pkg…');
execSync(
  `pkg "${BUNDLE_PATH}" --target ${pkgTarget} --output "${output}" --compress GZip`,
  { cwd: DAEMON_ROOT, stdio: 'inherit' },
);

console.log('[build-sidecar] Done.');
