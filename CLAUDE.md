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
  auto-switch.ts    — threshold monitor + switch trigger + exhaustion broadcast
  alerts.ts         — user-configured usage-alert evaluator

packages/app/src-tauri/src/
  ipc.rs            — Rust IPC bridge (connects to daemon socket)
  daemon.rs         — daemon sidecar spawn logic (spawns once, no auto-restart)
  tray.rs           — system tray menu
  main.rs           — plugin registration (notification, store, autostart)
                      set_autostart / get_autostart Tauri commands
```

## IPC message reference (shared types)

**App → Daemon** (in addition to the core account/usage ones):
- `get_settings` / `update_settings` — `Settings` is `{ launchAtLogin, switchingMode, autoSwitchThresholdPct }`
- `list_alerts` / `upsert_alert` / `delete_alert` — alerts bound by Sentinel `accountId`
- `get_notifications` — history for the Alerts tab

**Daemon → App** broadcasts (in addition to the core ones):
- `settings_changed` — fires on every `update_settings` write
- `alert_triggered` — a user alert crossed its threshold; UI fires a native notification
- `all_accounts_exhausted` — auto-switch gave up because every account is above threshold

## Manual test helpers (send IPC from shell)

```sh
# Read current settings
node scripts/ipc.mjs '{"type":"get_settings"}'

# Toggle round-robin mode
node scripts/ipc.mjs '{"type":"update_settings","settings":{"switchingMode":"round-robin"}}'

# Create an alert at 1% for a specific account
node scripts/ipc.mjs '{"type":"upsert_alert","accountId":"<uuid>","thresholdPct":1,"enabled":true}'
```
