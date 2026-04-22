# Claude Sentinel – Development Guide

## Fast iteration loop (daemon changes only)

Most fixes only touch daemon TypeScript. No Rust re-compile needed.

**IMPORTANT: Never run `pkill`/`kill` on the daemon while the user has the Tauri app open.**
The Tauri app spawns the daemon once on startup and does NOT auto-restart it if it exits.
Killing it breaks the user's session with no automatic recovery.

The safe way to deploy new daemon code:

```sh
# 1. Build
pnpm --filter @claude-sentinel/daemon run build          # tsc
pnpm --filter @claude-sentinel/daemon run build:sidecar  # pkg → binary

# 2. Replace the binary in the installed app bundle (safe while the daemon is running —
#    the running process keeps its inode; the new binary takes effect on next launch)
cp "packages/app/src-tauri/binaries/claude-sentinel-daemon-aarch64-apple-darwin" \
   "/Applications/Claude Sentinel.app/Contents/MacOS/claude-sentinel-daemon"
echo "Binary replaced — ask the user to restart Claude Sentinel."

# 3. Tail logs after the user restarts
tail -f ~/.claude-sentinel/daemon.log
```

## Test cycle checklist

Before declaring a fix complete, always:

1. Build daemon (if changed): `pnpm --filter @claude-sentinel/daemon run build && pnpm --filter @claude-sentinel/daemon run build:sidecar`
2. Build full app (if frontend/Rust changed): `pnpm --filter @claude-sentinel/app run tauri:build`
3. Ask the user to quit Claude Sentinel, then install + open
4. **Monitor logs throughout**: `tail -f ~/.claude-sentinel/daemon.log`
5. Confirm expected log lines appear (daemon start, IPC responses, OAuth flow, broadcasts)

## Testing without disturbing the live daemon

Use the IPC script to send messages to the RUNNING daemon:

```sh
# List accounts
node scripts/ipc.mjs '{"type":"refresh_accounts"}'

# Switch account (supply real UUID from the list above)
node scripts/ipc.mjs '{"type":"switch_account","accountId":"<uuid>","email":"<email>"}'
```

Verify a switch by reading the results directly:

```sh
# Active account in ~/.claude.json
node -e "const s=require('fs').readFileSync(require('path').join(require('os').homedir(),'.claude.json'),'utf-8'); const p=JSON.parse(s); console.log(p.oauthAccount?.emailAddress, p.oauthAccount?.accountUuid)"

# Token in Claude Code's keychain (macOS) — confirm it changed
security find-generic-password -s "Claude Code-credentials" -a "$USER" -w 2>/dev/null \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf-8').trim(); const p=JSON.parse(d); console.log('token prefix:', p.claudeAiOauth?.accessToken?.slice(0,30))"

# Daemon health
curl -s http://localhost:47284/health
```

Test the profile API directly with an existing access token:

```sh
AT=$(security find-generic-password -s "Claude Sentinel-credentials" -a "<key>" -w 2>/dev/null \
     | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8').trim()).accessToken||'')")
node -e "
(async () => {
  const r = await fetch('https://api.anthropic.com/api/oauth/profile', {
    headers: { Authorization: 'Bearer ${AT}', 'Content-Type': 'application/json' }
  });
  const d = await r.json();
  console.log(JSON.stringify({ uuid: d.account?.uuid, email: d.account?.email, orgType: d.organization?.organization_type }, null, 2));
})();
"
```

## Full app build (Rust/frontend changes)

```sh
pnpm --filter @claude-sentinel/app run tauri:build
```

Artifacts land in `packages/app/src-tauri/target/release/bundle/macos/`.

To install (only when user has quit the app first):

```sh
cp -R "packages/app/src-tauri/target/release/bundle/macos/Claude Sentinel.app" /Applications/
open "/Applications/Claude Sentinel.app"
```

## Tests

```sh
npx vitest run --coverage
```

The project requires **≥95% coverage** across statements, branches, functions, and lines.

## Logs

```sh
# Stream in real time
tail -f ~/.claude-sentinel/daemon.log

# Filter to a subsystem
grep '\[OAuth\]'    ~/.claude-sentinel/daemon.log
grep '\[Switch\]'   ~/.claude-sentinel/daemon.log
grep 'ERROR'        ~/.claude-sentinel/daemon.log
```

## DevTools for frontend / webview diagnosis

We use the platform's native Web Inspector, in a separate window, on
every OS. No custom debugger UI — Safari / Edge / WebKit already ship
Console + Network + Elements + Sources + breakpoints.

### Main tray window — click the `dev` badge in the footer

Toggles DevTools via the standard Tauri
[`open_devtools`/`close_devtools`](https://v2.tauri.app/develop/debug/)
APIs. The catch: our tray window is pinned to 540×628 non-resizable for
tray-menu ergonomics, so a docked inspector has nowhere to live out of
the box. The `toggle_devtools` command in
`packages/app/src-tauri/src/main.rs` handles both sides:

- **Opening**: clears max_size, enables resizable, grows window to
  1280×900, calls `open_devtools()`, emits `devtools_state_changed`
  with `{ open: true }`.
- **Closing**: `close_devtools()`, sets window to 540×628, restores
  max_size cap, disables resizable, emits `{ open: false }`.

The frontend's `useAutoResizeWindow` hook listens for
`devtools_state_changed` and pauses itself while DevTools is open — if
it didn't, the auto-resize loop would immediately shrink the window
back to content height and the docked inspector would have no room.
When DevTools closes, the hook resets calibration (`calibrated = false`)
so the next frame re-measures chrome overhead against the freshly
restored tray size.

No AppleScript, no platform-specific permissions — cross-platform via
Tauri's standard API. Prior iterations tried AppleScript-driving
Safari's Develop menu for a separate windowed inspector; that path
required Accessibility permission + Develop menu enabled + fragile
menu traversal. The expand-then-restore approach sidesteps all of it.

### claude.ai login webview

Right-click → Inspect (always available thanks to `.devtools(true)` on
the login window's `WebviewWindowBuilder`). Use this when Connect
claude.ai fails — the Network tab surfaces the exact failing request +
response body.

### Build feature requirement

The `devtools` Cargo feature on tauri is enabled in `Cargo.toml` so all
of this works in release builds too. On macOS, this feature sets
`WKWebView.isInspectable = true`, which is what makes our app appear in
Safari's Develop menu — without it, the AppleScript would find nothing
to click.

### Asking users for DevTools output

Ask for screenshots / Console tab contents / Network tab entries when
diagnosing frontend or auth issues. The usual culprits:

- Google OAuth rejecting the embedded webview (UA/fingerprint related)
- claude.ai returning 401/403 on a stored sessionKey (cookie expired)
- Tauri IPC errors between frontend and daemon
- React render errors that don't show up in the daemon log

**Ask the user for DevTools logs when diagnosing frontend / auth issues.**
Console and Network tab contents are usually enough to pinpoint:

- Google OAuth rejecting the embedded webview (stealth patches may need updating)
- claude.ai returning 401/403 on a stored sessionKey (cookie expired)
- Tauri IPC errors between frontend and daemon
- React render errors that don't show up in the daemon log

Typical diagnostic request: "Can you open DevTools on the login webview,
try Connect with Google again, and paste the Console + Network tab
contents (screenshot or copy-paste)?"

## Project structure (key files)

```
packages/daemon/src/
  index.ts          — daemon startup, all IPC handlers, performSwitch()
  accounts.ts       — OS keychain read/write (CC + Sentinel stores)
  claude-state.ts   — ~/.claude.json read/write
  proxy.ts          — HTTP reverse proxy + overage header inspection
                      per-request token selection via tokenProvider option
  oauth.ts          — PKCE login flow (browser + token exchange)
  ipc.ts            — Unix socket IPC server/client
  settings.ts       — ~/.claude-sentinel/settings.json load/save
  token-rotator.ts  — round-robin {accountId, token} selector
                      (strategy: balance | earliest-reset)
  alerts.ts         — user-configured usage-alert evaluator
                      (per-account + pool-wide)
  security/permissions/
    claude-sync.ts  — bi-directional sync with ~/.claude/settings.json
                      (see "Claude Code settings sync" below)

packages/app/src-tauri/src/
  ipc.rs            — Rust IPC bridge (connects to daemon socket)
  daemon.rs         — daemon sidecar spawn logic (spawns once, no auto-restart)
  tray.rs           — system tray menu
  main.rs           — plugin registration (notification, store, autostart)
                      set_autostart / get_autostart Tauri commands
```

## IPC message reference (shared types)

**App → Daemon** (in addition to the core account/usage ones):

- `get_settings` / `update_settings` — `Settings` is `{ launchAtLogin, switchingMode, roundRobinStrategy, poolExcludedIds, … }`
- `list_alerts` / `upsert_alert` / `delete_alert` — alerts carry a `scope`
  (`'account'` bound to a Sentinel key, or `'pool'` for round-robin-wide)
- `get_notifications` — history for the Alerts tab

**Daemon → App** broadcasts (in addition to the core ones):

- `settings_changed` — fires on every `update_settings` write
- `alert_triggered` — a user alert crossed its threshold (per-account or pool); UI fires a native notification

## Claude Code settings sync (permission rules)

Sentinel's `permission_rules` table is the **source of truth**; `~/.claude/settings.json` is a mirror. The sync engine (`packages/daemon/src/security/permissions/claude-sync.ts`) keeps them in lockstep when `claudeCodeSyncEnabled` is on.

- **Canonical key is `raw`.** A rule's raw text (e.g. `"Bash(rm -rf *)"`) uniquely identifies it. Moving a rule across decision buckets (deny → ask, allow → deny, etc.) is an update of the same row, never an insert. DB-level UNIQUE index on `raw` enforces this; `upsertPermissionRule` upserts on `raw` when no `id` is passed.
- **`ask` rules are Sentinel-only.** Push writes only `allow` and `deny` to `settings.json`; `ask` never appears there. Rationale: approval prompts must have a single surface so remote-approval integrations (Slack, etc.) have one place to hook. Claude Code's own `ask` prompt would otherwise double up with Sentinel's pending-block UI on every matching tool_use. Corollary: ask rules are always `source='local'` regardless of pull mode, and orphan cleanup skips them (file-absence isn't a signal — they're never there).
- **Push** fires after every local mutation (UI edit or IPC `upsert_permission_rule` / `delete_permission_rule`). Writes the DB's allow/deny state to `settings.json`, preserving every non-permissions top-level key in the file.
- **Pull** fires on file-watcher events (debounced 500 ms). Collapses duplicate file entries by `raw`. If the same raw appears in multiple buckets, deny > ask > allow (most restrictive wins). Ask rules a user hand-adds to `settings.json` are still imported into the DB; the next push then strips them from the file — the rule "migrates" to Sentinel-only.
- **Merge mode** (default): updates existing rows' decisions from the file, preserves `source` on allow/deny rows — local rules keep their UI-ownership. Orphan cleanup only deletes `source='claude-code'` allow/deny rows whose raw is no longer in the file.
- **Import mode**: same as merge, but flips `source` to `claude-code` on every matched allow/deny row — "file wins". Ask rules stay `local`. Used by the one-time upgrade migration and the "Import from Claude Code settings.json" UI button.
- **Upgrade migration** (`claude_sync_file_wins_v1`): on first sync engine start after upgrade, runs a pull-in-import-mode then a push. Fixes beta users whose file had duplicates or cross-bucket disagreement with the DB, and strips any ask rules out of the file. Marker persisted in the `_migrations` table so it runs once per DB. Does not run when sync is disabled — if the user opted out, Sentinel leaves their file alone.

Hand-editing `settings.json` while the daemon is running still works: the watcher picks up the change, pulls with merge semantics, then pushes back. But the UI is the better path — it's atomic and can't produce ambiguous states.

## Manual test helpers (send IPC from shell)

```sh
# Read current settings
node scripts/ipc.mjs '{"type":"get_settings"}'

# Toggle round-robin mode
node scripts/ipc.mjs '{"type":"update_settings","settings":{"switchingMode":"round-robin"}}'

# Create an alert at 1% for a specific account
node scripts/ipc.mjs '{"type":"upsert_alert","accountId":"<uuid>","thresholdPct":1,"enabled":true}'
```
