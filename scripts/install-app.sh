#!/usr/bin/env bash
#
# Build, install, re-sign, and launch /Applications/Claude Sentinel.app.
#
# Why this exists (instead of just `cp -R`): macOS caches a bundle's code-
# signature on its first launch from a given path. When you `cp -R` a freshly
# built bundle over /Applications/Claude\ Sentinel.app, the on-disk signature
# is valid but the kernel's amfid cache is now stale. The first child process
# the app spawns (the daemon sidecar) gets SIGKILLed before it can produce
# any output — which looks identical to "the daemon didn't open". Subsequent
# launches work because the cache is now warm, leaving you guessing why the
# first attempt failed silently.
#
# `codesign --force --deep --sign -` re-signs the bundle ad-hoc in place,
# which invalidates the stale cache entry. The next launch revalidates from
# disk (where the signature really is valid) and proceeds normally.
#
# Usage: ./scripts/install-app.sh
# Or:    pnpm install:app

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="/Applications/Claude Sentinel.app"
BUNDLE_PATH="$REPO_ROOT/packages/app/src-tauri/target/release/bundle/macos/Claude Sentinel.app"

cd "$REPO_ROOT"

echo "→ Building app bundle (this is the long step)..."
pnpm build:app

if [[ ! -d "$BUNDLE_PATH" ]]; then
  echo "✗ Build produced no bundle at:" >&2
  echo "  $BUNDLE_PATH" >&2
  exit 1
fi

# `cp -R` over an existing directory is a MERGE, not a replace — stale
# files from a previous bundle (e.g. a renamed binary, removed Resources)
# would linger. Remove first, then copy fresh. Skips cleanly if the app
# wasn't installed yet.
if [[ -d "$APP_PATH" ]]; then
  echo "→ Removing existing $APP_PATH..."
  rm -rf "$APP_PATH"
fi

echo "→ Copying bundle to $APP_PATH..."
cp -R "$BUNDLE_PATH" "$APP_PATH"

echo "→ Re-signing bundle ad-hoc (clears the amfid/Gatekeeper cache)..."
codesign --force --deep --sign - "$APP_PATH"

echo "→ Verifying signature..."
codesign --verify --verbose=1 "$APP_PATH"

echo "→ Launching..."
open "$APP_PATH"

echo
echo "✓ Installed and launched."
echo "  Tail logs with: tail -f ~/.claude-sentinel/daemon.log"
