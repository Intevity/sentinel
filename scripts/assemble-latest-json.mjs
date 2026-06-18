#!/usr/bin/env node
// Assemble the Tauri updater manifest (latest.json) from a directory of
// downloaded release artifacts. Runs in notarize-finalize.yml's
// publish-updates job after the macOS tarballs have been stapled +
// re-signed, so the signatures read here are the final ones.
//
// Usage:
//   UPDATER_PUBLIC_BASE=https://host S3_PREFIX=stable \
//     node scripts/assemble-latest-json.mjs <dir> <version>
//
// <dir> holds the updater artifacts + their minisign .sig companions
// (downloaded from the draft release); <version> is the bare semver
// (tag minus the leading v). Writes <dir>/latest.json and prints it.
//
// Env:
//   UPDATER_PUBLIC_BASE  public HTTPS base mapping to the S3 bucket root
//   S3_PREFIX            channel prefix under the bucket (e.g. stable)
//
// Exit codes:
//   0  manifest written, all expected platforms present
//   1  unmapped artifact, missing .sig, duplicate key, or missing platform
//
// Platform keys: tauri-plugin-updater looks up {target}-{arch}-{bundle}
// first, then falls back to {target}-{arch}. We emit both, mirroring
// tauri-action's scheme — with one deliberate divergence: our bare
// windows-x86_64 points at the NSIS -setup.exe (tauri-action's points at
// the MSI). NSIS is Tauri's recommended updater installer (passive
// in-place reinstall, per-user installs without elevation); the MSI stays
// reachable under windows-x86_64-msi. Do not "fix" this back to MSI.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

// Map an artifact filename to its updater platform keys: the
// bundle-suffixed key plus (for the bundle that bare lookups should get)
// the bare {target}-{arch} fallback. Every leg in the release matrix is
// x86_64 except macos-arm64, so the bundle extension pins the OS and only
// the macOS tarballs need an arch sniff.
function platformKeys(name) {
  if (name.endsWith('.app.tar.gz')) {
    // Tauri names the macOS updater tarballs <product>_aarch64.app.tar.gz
    // and <product>_x64.app.tar.gz (x64, NOT x86_64), so match both.
    if (name.includes('aarch64')) return ['darwin-aarch64-app', 'darwin-aarch64'];
    if (name.includes('x64') || name.includes('x86_64'))
      return ['darwin-x86_64-app', 'darwin-x86_64'];
    fail(`cannot determine macOS arch from ${name}`);
  }
  if (name.endsWith('.AppImage')) return ['linux-x86_64-appimage', 'linux-x86_64'];
  if (name.endsWith('.deb')) return ['linux-x86_64-deb'];
  if (name.endsWith('.rpm')) return ['linux-x86_64-rpm'];
  if (name.endsWith('-setup.exe')) return ['windows-x86_64-nsis', 'windows-x86_64'];
  if (name.endsWith('.msi')) return ['windows-x86_64-msi'];
  return null;
}

// Every release builds every bundle type (bundle.targets "all" on each
// matrix leg), so a missing key here means a build or upload failure that
// must surface — never publish a manifest silently missing a platform.
const REQUIRED_KEYS = [
  'darwin-aarch64-app',
  'darwin-x86_64-app',
  'linux-x86_64-appimage',
  'linux-x86_64-deb',
  'linux-x86_64-rpm',
  'windows-x86_64-nsis',
  'windows-x86_64-msi',
];

const [dir, version] = process.argv.slice(2);
if (!dir || !version) fail('usage: assemble-latest-json.mjs <dir> <version>');

const base = (process.env.UPDATER_PUBLIC_BASE || '').replace(/\/+$/, '');
const prefix = process.env.S3_PREFIX;
if (!base) fail('UPDATER_PUBLIC_BASE is not set');
if (!prefix) fail('S3_PREFIX is not set');

const platforms = {};
for (const f of readdirSync(dir).sort()) {
  // .sig files are consumed as companions of the artifact they sign; a
  // pre-existing latest.json just means this dir has been assembled before.
  if (f.endsWith('.sig') || f === 'latest.json') continue;
  const keys = platformKeys(f);
  if (!keys) fail(`unmapped artifact ${f} — extend platformKeys() or fix the download globs`);
  let signature;
  try {
    signature = readFileSync(join(dir, `${f}.sig`), 'utf8').trim();
  } catch {
    fail(`missing signature companion ${f}.sig`);
  }
  const entry = { signature, url: `${base}/${prefix}/${version}/${encodeURIComponent(f)}` };
  for (const key of keys) {
    if (platforms[key]) fail(`both ${platforms[key].url} and ${f} map to ${key}`);
    platforms[key] = entry;
  }
}

const missing = REQUIRED_KEYS.filter((k) => !platforms[k]);
if (missing.length) fail(`release is missing updater artifacts for: ${missing.join(', ')}`);

const manifest = {
  version,
  notes: `Sentinel ${version}`,
  pub_date: new Date().toISOString(),
  platforms: Object.fromEntries(Object.entries(platforms).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
