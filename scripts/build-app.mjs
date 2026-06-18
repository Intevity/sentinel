#!/usr/bin/env node
/**
 * Cross-platform "build my local changes and run them as the real app".
 * One command on every OS: `pnpm build:app`.
 *
 * Every platform builds UNSIGNED via src-tauri/tauri.dev.conf.json
 * (`bundle.createUpdaterArtifacts: false`), so there is NEVER an updater-key
 * password prompt (a plain `tauri build` would prompt on every OS). Per-OS
 * behavior, chosen by `process.platform`:
 *
 *   - macOS (darwin): delegate to scripts/install-app.sh — build the `.app`,
 *     replace /Applications/Sentinel.app, ad-hoc re-sign, and launch.
 *     The re-sign is load-bearing: it clears the amfid signature cache that
 *     would otherwise SIGKILL the daemon sidecar on first launch.
 *   - Linux: build an unsigned `.AppImage` and launch it.
 *   - Windows (win32): build the unsigned NSIS installer and launch it.
 *
 * Linux/Windows have no code-signature cache to defeat, so there is no
 * install-and-re-sign step — they just build and run the bundle.
 *
 * For the SIGNED release build (what ships; CI does this via tauri-action),
 * use `pnpm build:app:release`.
 *
 * Flags:
 *   --dry-run            print the steps without building/launching
 *   --platform=<name>    override the platform (ONLY honored with --dry-run,
 *                        so you can preview the Linux/Windows plan from macOS)
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = join(repoRoot, 'packages/app/src-tauri/target/release/bundle');

const dryRun = process.argv.includes('--dry-run');
const platformOverride = process.argv.find((a) => a.startsWith('--platform='))?.split('=')[1];
// The override is a preview aid only — never let it change what a real build
// targets (forcing win32 on macOS would just fail confusingly).
const platform = dryRun && platformOverride ? platformOverride : process.platform;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Run a shell command string to completion (used for the pnpm/tauri call so
 *  Windows resolves `pnpm.cmd` via the shell). Aborts on non-zero exit. */
function runShell(cmd) {
  if (dryRun) {
    console.log(`  [run] ${cmd}`);
    return;
  }
  const r = spawnSync(cmd, { stdio: 'inherit', cwd: repoRoot, shell: true });
  if (r.status !== 0) fail(`command failed (${r.status ?? r.signal}): ${cmd}`);
}

/** Run an executable with an argv array (no shell — safe for paths with
 *  spaces, e.g. "Sentinel.app"). Aborts on non-zero exit. */
function runArgv(cmd, args) {
  if (dryRun) {
    console.log(`  [run] ${cmd} ${args.join(' ')}`);
    return;
  }
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot });
  if (r.status !== 0) fail(`command failed (${r.status ?? r.signal}): ${cmd}`);
}

/** Launch the built app detached so it keeps running after this script exits. */
function launchDetached(path, args = []) {
  console.log(`→ Launching ${path}`);
  if (dryRun) {
    console.log(`  [launch] ${path} ${args.join(' ')}`);
    return;
  }
  const child = spawn(path, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

/** Newest file in `dir` matching `re`, or null. */
function newestMatching(dir, re) {
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => join(dir, f));
  if (hits.length === 0) return null;
  return hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** The unsigned dev build invocation for a given bundle target. */
const tauriBuild = (bundles) =>
  `pnpm --filter @sentinel/app exec tauri build --bundles ${bundles} --config src-tauri/tauri.dev.conf.json`;

switch (platform) {
  case 'darwin': {
    // Keep the proven macOS flow (install to /Applications + ad-hoc re-sign +
    // open) as the single source of truth. install-app.sh builds unsigned,
    // guards against a running app, and gives the App-Management hint.
    runArgv('bash', [join(repoRoot, 'scripts/install-app.sh')]);
    break;
  }
  case 'linux': {
    console.log('→ Building unsigned .AppImage (no key prompt)...');
    runShell(tauriBuild('appimage'));
    const appimage = dryRun
      ? join(bundleDir, 'appimage', '<ProductName>_<version>_<arch>.AppImage')
      : newestMatching(join(bundleDir, 'appimage'), /\.AppImage$/i);
    if (!appimage) {
      fail('build produced no .AppImage under target/release/bundle/appimage');
    }
    if (!dryRun) chmodSync(appimage, 0o755);
    // --appimage-extract-and-run avoids a hard FUSE dependency on minimal hosts.
    launchDetached(appimage, ['--appimage-extract-and-run']);
    console.log('✓ Built and launched (unsigned local build).');
    break;
  }
  case 'win32': {
    console.log('→ Building unsigned NSIS installer (no key prompt)...');
    runShell(tauriBuild('nsis'));
    const setup = dryRun
      ? join(bundleDir, 'nsis', '<ProductName>_<version>_x64-setup.exe')
      : newestMatching(join(bundleDir, 'nsis'), /-setup\.exe$/i);
    if (!setup) {
      fail('build produced no -setup.exe under target/release/bundle/nsis');
    }
    launchDetached(setup);
    console.log('✓ Built the installer and launched it; follow its prompts.');
    break;
  }
  default:
    fail(`unsupported platform: ${platform}`);
}
