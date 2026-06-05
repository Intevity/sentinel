#!/usr/bin/env bash
#
# Build, install, re-sign, and launch /Applications/Claude Sentinel.app — the
# macOS implementation behind `pnpm build:app` (the cross-platform dispatcher
# scripts/build-app.mjs calls this on Darwin). Also runnable directly. This is
# the ONLY supported way to push a locally-built bundle into /Applications; do
# NOT `cp -R` over the existing app yourself (see "Why rm -rf first", below).
#
# Local dev builds are UNSIGNED by design:
#   - The build below bundles only the `.app` and disables updater-artifact
#     creation (via src-tauri/tauri.dev.conf.json), so Tauri never asks for
#     the updater signing key password (the `~/.tauri/*.key` prompt you get
#     from a full `pnpm build:app:release`).
#   - No Apple Developer ID signing happens unless APPLE_SIGNING_IDENTITY is
#     exported; the bundle is ad-hoc signed instead. That's fine for running
#     on your own machine. Release builds (signed + notarized) go through CI.
#
# Why rm -rf first (instead of just `cp -R`):
#   1. `cp -R src.app /Applications/` when the destination ALREADY exists is a
#      MERGE, not a replace. macOS protects an installed app's existing files,
#      so copying over them fails with "cp: ... Operation not permitted" for
#      every file in the bundle. Removing the old app first means cp writes a
#      fresh tree with nothing to overwrite.
#   2. A merge also leaves stale files from the previous bundle (a renamed
#      binary, a removed Resource) lingering inside the app.
#
# Why re-sign ad-hoc after copying:
#   macOS caches a bundle's code signature on its first launch from a given
#   path. A freshly copied bundle has a valid on-disk signature but a stale
#   amfid cache entry, and the first child the app spawns (the daemon sidecar)
#   gets SIGKILLed before producing any output — indistinguishable from "the
#   daemon didn't open". `codesign --force --deep --sign -` re-signs in place
#   and invalidates the stale cache so the next launch revalidates from disk.
#
# This script is macOS-ONLY. The copy-to-/Applications + ad-hoc re-sign dance
# exists solely to defeat macOS's code-signature cache (amfid SIGKILLs the
# daemon sidecar otherwise). Linux and Windows have no equivalent problem, so
# they don't need an "install" step at all — build and run the bundle directly.
# See README → "Running a local build" for the per-OS dev loop.
#
# Usage: pnpm build:app   (cross-platform; runs this on macOS)
#    or: ./scripts/install-app.sh   (macOS only, direct)

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✗ scripts/install-app.sh is macOS-only (it uses /Applications, codesign, open)." >&2
  echo "  Use the cross-platform entrypoint instead — it builds + runs per OS:" >&2
  echo "      pnpm build:app" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="/Applications/Claude Sentinel.app"
BUNDLE_PATH="$REPO_ROOT/packages/app/src-tauri/target/release/bundle/macos/Claude Sentinel.app"

cd "$REPO_ROOT"

# The running app holds its files open and macOS App Management will block the
# rm -rf below. Quit it first so the swap is clean.
if pgrep -f "Claude Sentinel.app/Contents/MacOS/Claude Sentinel" >/dev/null 2>&1; then
  echo "✗ Claude Sentinel is still running." >&2
  echo "  Quit it from the tray (or run: osascript -e 'quit app \"Claude Sentinel\"')" >&2
  echo "  then re-run this script." >&2
  exit 1
fi

echo "→ Building app bundle, unsigned (this is the long step)..."
# Only the `.app`, updater artifacts disabled → no `~/.tauri/*.key` prompt.
pnpm --filter @claude-sentinel/app exec tauri build \
  --bundles app --config src-tauri/tauri.dev.conf.json

if [[ ! -d "$BUNDLE_PATH" ]]; then
  echo "✗ Build produced no bundle at:" >&2
  echo "  $BUNDLE_PATH" >&2
  exit 1
fi

# Remove first, then copy fresh (see "Why rm -rf first" in the header).
if [[ -d "$APP_PATH" ]]; then
  echo "→ Removing existing $APP_PATH..."
  if ! rm -rf "$APP_PATH" 2>/dev/null; then
    echo "✗ Could not remove $APP_PATH (Operation not permitted)." >&2
    echo "  macOS is protecting the installed app. Either:" >&2
    echo "    - Confirm Claude Sentinel is fully quit (tray + Activity Monitor), or" >&2
    echo "    - Grant your terminal 'App Management' under System Settings →" >&2
    echo "      Privacy & Security → App Management, then re-run." >&2
    exit 1
  fi
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
echo "✓ Installed and launched (unsigned local build)."
echo "  Tail logs with: tail -f ~/.claude-sentinel/daemon.log"
