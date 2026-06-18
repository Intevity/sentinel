#!/usr/bin/env bash
# Staple the notarization ticket into the already-notarized macOS artifacts, then
# re-sign the regenerated updater tarball. Runs on a short macOS job AFTER Apple has
# Accepted the submissions (xcrun stapler is macOS-only), so the bundles ship
# offline-resilient instead of relying on an online Gatekeeper check.
#
# For each arch the build leg produced a .dmg and a .app.tar.gz (+ .sig). We submitted
# the .dmg to notary, which also notarizes the nested app's code identity, so stapler can
# fetch a ticket for both the dmg and the app by cdhash.
#
#   1. Staple the .dmg in place.
#   2. Extract the .app from the updater tarball, staple it, re-tar to the SAME filename,
#      and re-sign with the Tauri (minisign) updater key.
#   3. Re-upload the stapled dmg + regenerated tarball + new .sig to the draft release.
#
# Usage: notary-staple.sh <dir-with-dmg-and-tarballs> <release-tag>
# Requires env: GH_TOKEN, GITHUB_REPOSITORY,
#               TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
set -euo pipefail
shopt -s nullglob

DIR="${1:?usage: notary-staple.sh <dir-with-dmg-and-tarballs> <release-tag>}"
# Tag is passed explicitly ($2). Do NOT rely on a GITHUB_REF_NAME env override: GitHub
# ignores attempts to set GITHUB_* vars, so a reusable/workflow_dispatch caller cannot
# alias it (it would stay as the branch, e.g. "main"). Fall back to GITHUB_REF_NAME only
# for a direct tag-push context where it is naturally the tag.
TAG="${2:-${GITHUB_REF_NAME:-}}"
: "${TAG:?release tag required (pass as \$2, or set GITHUB_REF_NAME on a tag push)}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"

cd "$DIR"
DIR_ABS="$(pwd)"
uploads=()

# 1) Staple every .dmg (offline Gatekeeper for the human-download path).
for dmg in *.dmg; do
  echo "==> Stapling $dmg"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  uploads+=("$dmg")
done

# 2) Each updater tarball: staple the inner .app, re-tar (same name), re-sign.
for tgz in *.app.tar.gz; do
  echo "==> Stapling app inside $tgz"
  work="$(mktemp -d)"
  tar -xzf "$tgz" -C "$work"
  app="$(find "$work" -maxdepth 1 -name '*.app' -print -quit)"
  if [[ -z "$app" ]]; then
    echo "::error::no .app found inside $tgz" >&2
    exit 1
  fi
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  # Re-tar with the SAME filename. COPYFILE_DISABLE keeps macOS tar from injecting
  # AppleDouble (._*) sidecars that would poison the bundle the updater unpacks.
  (cd "$work" && COPYFILE_DISABLE=1 tar -czf "$DIR_ABS/$tgz" "$(basename "$app")")
  rm -rf "$work"
  # Re-sign the regenerated tarball with the Tauri updater key (reads
  # TAURI_SIGNING_PRIVATE_KEY[_PASSWORD] from env). Overwrites the stale .sig.
  rm -f "$DIR_ABS/$tgz.sig"
  pnpm --filter @sentinel/app exec tauri signer sign "$DIR_ABS/$tgz"
  if [[ ! -f "$DIR_ABS/$tgz.sig" ]]; then
    echo "::error::tauri signer did not produce $tgz.sig" >&2
    exit 1
  fi
  uploads+=("$tgz" "$tgz.sig")
done

if [[ ${#uploads[@]} -eq 0 ]]; then
  echo "::error::no .dmg or .app.tar.gz artifacts found in $DIR to staple" >&2
  exit 1
fi

echo "==> Uploading stapled artifacts to release $TAG: ${uploads[*]}"
gh release upload "$TAG" --repo "$REPO" --clobber "${uploads[@]}"
echo "Done."
