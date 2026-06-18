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
 * Output: packages/app/src-tauri/binaries/sentinel-daemon-<triple>[.exe]
 */
import { execSync, spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DAEMON_ROOT = join(__dirname, '..');
const BINARIES_DIR = join(__dirname, '../../app/src-tauri/binaries');
const DIST_DIR = join(DAEMON_ROOT, 'dist');
const BUNDLE_PATH = join(DIST_DIR, 'bundle.cjs');
const SHIM_PATH = join(DIST_DIR, 'bindings-shim.cjs');

// Rust target triple → @yao-pkg/pkg target string
const TRIPLE_TO_PKG = {
  'aarch64-apple-darwin': 'node24-macos-arm64',
  'x86_64-apple-darwin': 'node24-macos-x64',
  'x86_64-unknown-linux-gnu': 'node24-linux-x64',
  'aarch64-unknown-linux-gnu': 'node24-linux-arm64',
  'x86_64-pc-windows-msvc': 'node24-win-x64',
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

// Precedence:
//   1. CARGO_BUILD_TARGET    — explicit override (local cross-compile)
//   2. TAURI_ENV_TARGET_TRIPLE — set by `tauri build --target <triple>` for
//      beforeBuildCommand; required in CI where the host arch (arm64 runner)
//      differs from the target arch (e.g. x86_64-apple-darwin release).
//   3. rustc host triple     — default for local same-arch builds.
const triple =
  process.env.CARGO_BUILD_TARGET ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? getRustTriple();
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

const ext = triple.includes('windows') ? '.exe' : '';
const output = join(BINARIES_DIR, `sentinel-daemon-${triple}${ext}`);

console.log(`[build-sidecar] Rust triple : ${triple}`);
console.log(`[build-sidecar] pkg target  : ${pkgTarget}`);
console.log(`[build-sidecar] Output      : ${output}`);

// ── Resolve the native .node file (follows pnpm symlinks) ───────────────────
const req = createRequire(pathToFileURL(join(DAEMON_ROOT, 'package.json')));
const nativeAddonSrc = req.resolve('better-sqlite3/build/Release/better_sqlite3.node');
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
writeFileSync(
  SHIM_PATH,
  `\
'use strict';
module.exports = function bindings(_file) {
  return require('./better_sqlite3.node');
};
`,
);

// ── Step 1: bundle all source into a single CJS file ────────────────────────
console.log('[build-sidecar] Bundling with esbuild…');
execSync(
  [
    'esbuild dist/cli.js',
    '--bundle',
    '--platform=node',
    '--target=node24',
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
execSync(`pkg "${BUNDLE_PATH}" --target ${pkgTarget} --output "${output}" --compress GZip`, {
  cwd: DAEMON_ROOT,
  stdio: 'inherit',
});

// ── Step 3 (macOS release only): sign the sidecar with the hardened runtime +
// JIT entitlements BEFORE `tauri build` seals it into the .app.
//
// Tauri's bundler does NOT sign externalBin sidecars (tauri-apps/tauri#11992), so
// the app-level bundle.macOS.entitlements never reach this binary. Without these
// entitlements the notarized app's daemon is SIGKILL'd the instant it launches
// (V8 can't allocate executable memory under the hardened runtime; the embedded
// better_sqlite3.node fails library validation) — which looks identical to "the
// daemon didn't open". We must sign bottom-up: sign the sidecar here, then let
// `tauri build` sign the enclosing .app, sealing this signature into CodeResources.
//
// Skipped for local/ad-hoc dev builds (no APPLE_SIGNING_IDENTITY) and non-macOS
// targets; those keep the existing unsigned/ad-hoc behavior.
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
if (process.platform === 'darwin' && triple.includes('apple-darwin') && signingIdentity) {
  const entitlements = join(BINARIES_DIR, '..', 'entitlements.plist');
  console.log('[build-sidecar] Codesigning sidecar (hardened runtime + entitlements)…');
  execSync(
    'codesign --force --options runtime --timestamp ' +
      `--entitlements "${entitlements}" --sign "${signingIdentity}" "${output}"`,
    { stdio: 'inherit' },
  );
  // Fail loudly if the signature or the JIT/library-validation entitlements did
  // not actually attach — a silent miss here only surfaces as a runtime SIGKILL
  // after a full (expensive) notarized release.
  execSync(`codesign --verify --strict --verbose=2 "${output}"`, { stdio: 'inherit' });
  const ents = execSync(`codesign -d --entitlements - "${output}" 2>&1`, { encoding: 'utf8' });
  for (const key of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.disable-library-validation',
  ]) {
    if (!ents.includes(key)) {
      console.error(`[build-sidecar] Expected entitlement missing after signing: ${key}`);
      console.error(ents);
      process.exit(1);
    }
  }
  console.log('[build-sidecar] Sidecar signed; JIT + library-validation entitlements verified.');
} else if (triple.includes('apple-darwin')) {
  console.log(
    '[build-sidecar] APPLE_SIGNING_IDENTITY unset — sidecar left unsigned (local/ad-hoc dev build).',
  );
}

// ── Step 3 (Windows release only): Authenticode-sign the sidecar with Azure
// Trusted/Artifact Signing BEFORE `tauri build` packs it into the NSIS/MSI installers.
//
// Same rationale as the macOS branch above: Tauri's bundler does NOT sign externalBin
// sidecars (tauri-apps/tauri#11992), and bundle.windows.signCommand only reaches the app
// exe + installers — so without this the daemon .exe would ship UNSIGNED inside a signed
// installer. The release workflow's "Prepare Windows signing" step installs Microsoft's
// `sign` tool (dotnet/sign), resolves SIGN_TOOL_PATH + SIGN_SUBCOMMAND, and leaves an
// OIDC `az` session that the tool's DefaultAzureCredential consumes — so there is no
// client secret anywhere. We sign via a spawnSync argv array (no shell) so the spaced
// description and the file path need no quoting.
//
// Skipped when the AZURE_TS_* env is absent (local/dev Windows builds keep the unsigned
// behavior), exactly like the macOS branch skips without APPLE_SIGNING_IDENTITY.
if (process.platform === 'win32' && triple.includes('windows')) {
  const endpoint = process.env.AZURE_TS_ENDPOINT;
  const account = process.env.AZURE_TS_ACCOUNT;
  const profile = process.env.AZURE_TS_PROFILE;
  const signTool = process.env.SIGN_TOOL_PATH || 'sign';
  // The trusted->artifact rename is mid-flight; the workflow detects the installed
  // subcommand and the long flags track its name (--<sub>-endpoint, etc.).
  const subcommand = process.env.SIGN_SUBCOMMAND || 'trusted-signing';
  if (endpoint && account && profile) {
    console.log(`[build-sidecar] Authenticode-signing sidecar via Azure ${subcommand}…`);
    const res = spawnSync(
      signTool,
      [
        'code',
        subcommand,
        `--${subcommand}-endpoint`,
        endpoint,
        `--${subcommand}-account`,
        account,
        `--${subcommand}-certificate-profile`,
        profile,
        '-d',
        'Sentinel',
        output,
      ],
      { stdio: 'inherit' },
    );
    // Fail loudly: a silent miss only surfaces as a SmartScreen/AV warning on a shipped
    // installer, long after this (expensive) release build.
    if (res.status !== 0) {
      console.error(
        `[build-sidecar] Authenticode signing of the sidecar failed (exit ${res.status ?? res.signal}).`,
      );
      process.exit(1);
    }
    console.log('[build-sidecar] Sidecar Authenticode-signed.');
  } else {
    console.log(
      '[build-sidecar] AZURE_TS_* unset — Windows sidecar left unsigned (local/dev build).',
    );
  }
}

console.log('[build-sidecar] Done.');
