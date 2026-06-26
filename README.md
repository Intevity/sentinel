# Sentinel

An open-source Claude Code companion: a tray app and bundled local daemon for in-flight security scanning, permission rules, and sandbox isolation; multi-account routing; token-cost optimization; usage metrics; and overage alerts.

**Website:** https://intevity.github.io/sentinel (feature tour, demos, and downloads)

[![CI](https://github.com/Intevity/sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/Intevity/sentinel/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Intevity/sentinel?include_prereleases)](https://github.com/Intevity/sentinel/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Intevity/sentinel/total)](https://github.com/Intevity/sentinel/releases)
[![License: MIT](https://img.shields.io/github/license/Intevity/sentinel)](./LICENSE)
[![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen)](#security)
[![Network: localhost only](https://img.shields.io/badge/network-localhost%20only-blue)](#security)
[![Credentials: OS keychain](https://img.shields.io/badge/credentials-OS%20keychain-blue)](#security)
[![Coverage ≥95%](https://img.shields.io/badge/coverage-%E2%89%A595%25-brightgreen)](./vitest.config.ts)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#download)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%20v2-24C8DB)](https://tauri.app)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6)](https://www.typescriptlang.org)

---

## Download

Grab the latest installer from the **[Releases page](https://github.com/Intevity/sentinel/releases/latest)**, or pick your platform directly:

| Platform                                   | Format        | Download                                                               |
| ------------------------------------------ | ------------- | ---------------------------------------------------------------------- |
| **macOS** — Apple Silicon (M1/M2/M3/M4/M5) | `.dmg`        | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |
| **macOS** — Intel                          | `.dmg`        | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |
| **Windows** 10/11                          | `.msi` / NSIS | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |
| **Linux** (Debian/Ubuntu)                  | `.deb`        | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |
| **Linux** (Fedora/RHEL)                    | `.rpm`        | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |
| **Linux** (portable)                       | `.AppImage`   | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |

> **macOS note:** v0.1.x builds ship unsigned. See the [first-launch Gatekeeper steps](#installation) below — it's a one-time right-click.

---

## What it does

- **Security scanning** — In-flight detectors for secrets (API keys, tokens, private keys), PII, prompt injection, and risky tool use (Bash / Write / WebFetch). Three enforcement modes (observe, block HIGH, block MEDIUM+HIGH), per-tool permission rules with sub-command matching, and an optional approve/deny hold banner. Event history stores redacted fingerprints only — never the original secret text.
- **Permission rules** — Sentinel's rule DB is the source of truth. Allow/deny rules push into `~/.claude/settings.json` so Claude Code enforces them silently. `ask` rules stay in Sentinel only — approvals surface as a pending-block banner in the tray UI, with a single hook point for future Slack / remote-approval integrations (so you're not approving the same command twice in two different places).
- **Sandbox isolation** — Optional OS-level isolation for the commands Claude Code (and Sentinel's code-mode MCP servers) run, limiting which files and network domains they can reach. macOS and Linux get full filesystem and network isolation; Windows is network-only. Off by default; flip it on with one toggle in Settings → Security, then fine-tune the allowed paths and domains. The rules sync into Claude Code's own sandbox configuration.
- **Multi-account routing** — Enroll unlimited Claude accounts (Pro, Max, Team, Enterprise) and choose how they're used:
  - **Off** — manage accounts manually from the Accounts tab; the header shows which account is active.
  - **Auto** — Sentinel moves the active account for you, favoring the one whose 5-hour window resets soonest so you are not switching by hand. Each switch rewrites the active OAuth credential safely, and the header always shows the account currently serving requests.
- **Token optimization** — Cut token cost three ways, each with realized and potential savings shown on the Optimize page:
  - **Curated subagents** — A library of pre-built subagents (most pinned to a cheaper model) that the analyzer recommends installing into `~/.claude/agents/`. Routine work like file reads, log parsing, and test-output triage runs on the cheaper model and returns a digest instead of raw output.
  - **Reversible compression** — Trims the oversized `tool_result` payloads that quietly fill your context window (Conservative, Moderate, or Aggressive). Reversible mode stores the original so Claude can pull it back with the `mcp__sentinel__retrieve` tool, so nothing is lost.
  - **Code execution** — Bridges your MCP servers through a loopback endpoint so their tool definitions stop riding along in every request's context. Loopback-only, with a per-server allowlist.
- **Overage detection** — Intercepts `anthropic-ratelimit-unified-overage-*` response headers and fires a native OS notification the moment your session enters overage budget.
- **Usage visibility** — Every rate-limit window (5-hour, weekly all-models, weekly Sonnet, overage budget) rendered with reset countdowns and color-coded urgency. On Team/Enterprise plans where admins hide per-user budgets from members, Sentinel exposes each member's own budget. Auto mode aggregates every account into a pool view.
- **Spend caps** — Set a per-account or global overage budget cap. Sentinel pauses any account whose spend crosses its cap until the next rolling window reset, and Auto mode skips paused accounts so billing stays bounded.
- **Real metrics** — OTEL telemetry gives you accurate cost, tokens, cache hit rate, and per-model breakdowns over 7/14/30-day windows. Unlike `~/.claude/stats-cache.json` (which reports `$0` for subscription users), these numbers are real.
- **User-configurable alerts** — Set a percentage threshold on the 5-hour window (per-account or pool-wide in Auto mode); pick your own notification sound per alert type; get a native OS notification when it trips. Deduped per window.
- **Notification history** — Every overage transition, account switch, threshold trigger, and security finding captured in one scrollable timeline. Click a security notification to jump straight to the expanded event.

## Architecture

```
Claude Code  ──→  localhost:47284  ──→  api.anthropic.com
                  (sentinel daemon)
                        │
                        │  Unix socket / named pipe
                        ▼
                  Sentinel App
                  (Tauri v2 tray app)
```

- **App** (`packages/app`) — Tauri v2 desktop tray application. Bundles and manages the daemon as a sidecar process and patches `~/.claude/settings.json` on activation so Claude Code routes through the proxy.
- **Daemon** (`packages/daemon`) — Node.js HTTP reverse proxy, OTLP telemetry receiver, MCP server, and SQLite store. Compiled into a self-contained binary and embedded inside the app bundle.

## Installation

### Prerequisites

- macOS 12+, Windows 10+, or Linux (see [Linux notes](#linux-notes) below)
- [Claude Code](https://claude.ai/code) installed
- Node.js 24+ (for Claude Code itself; the Sentinel daemon ships its own runtime)

### First launch

1. **Install** using the [Download](#download) table above. The daemon is bundled inside the app — there is nothing else to install.

   > **macOS:** release builds are signed with a Developer ID certificate and notarized by Apple, so they open with a normal double-click — no "unidentified developer" prompt and no `xattr` workaround needed. (If you build locally from source, your build is only ad-hoc signed; right-click → **Open** once to launch it.)

2. **Launch Sentinel** from your Applications folder. The tray icon appears in the menu bar / system tray, and the daemon starts automatically.

3. **Click "Activate Sentinel"** in the banner that appears on first launch. This writes `ANTHROPIC_BASE_URL=http://localhost:47284` plus OTEL env vars into `~/.claude/settings.json` — the only setup step required.

4. **Restart Claude Code.** From this point on, every Claude Code session routes through the Sentinel proxy.

5. **Enroll accounts** via the tray app → **Add Account**, then follow the OAuth flow. In the browser OAuth consent page, make sure you're signed in to the org you want to add — the token is scoped to whichever org claude.ai is currently showing.

### Linux notes

**Required system libraries:**

| Distro | Command                                              |
| ------ | ---------------------------------------------------- |
| Arch   | `sudo pacman -S webkit2gtk-4.1 libsecret`            |
| Debian | `sudo apt install libwebkit2gtk-4.1-0 libsecret-1-0` |
| Fedora | `sudo dnf install webkit2gtk4.1 libsecret`           |

`webkit2gtk-4.1` powers the app window; `libsecret` is the keychain backend used to store credentials.

**Wayland:** Supported natively — no manual configuration needed. The app detects Wayland at startup and disables WebKit's DMA-BUF renderer, which triggers a protocol error (`EPROTO`) on some compositors.

### Uninstall

Open the tray app → **⋯ menu → Uninstall Sentinel…**. The uninstall dialog lets you choose whether to also delete local data (usage history, rate-limit cache, keychain credentials). Uninstalling:

- Removes the Sentinel env vars from `~/.claude/settings.json` so Claude Code goes back to calling `api.anthropic.com` directly.
- Optionally wipes `~/.sentinel/` and every `Sentinel-credentials` keychain entry.
- Shuts the daemon down and quits the app.

The Sentinel app itself is still in `/Applications` after uninstall — trash it normally if you want to remove the binaries too.

### Check daemon health

```sh
curl http://localhost:47284/health
# {"status":"ok","pid":12345}
```

The in-app ⋯ menu also shows daemon pid and uptime.

## Window behavior

Sentinel is a tray-only app (no Dock icon). Closing the window with the red ⨉ (or ⌘W) hides it — the background daemon keeps running so Claude Code can continue routing through it. To fully stop Sentinel, use the ⋯ menu → **Quit Sentinel**, or the tray menu → **Quit Sentinel**.

## Building from source

### Prerequisites

- pnpm 9+
- Rust stable (install via [rustup](https://rustup.rs))
- Node.js 24+
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `libgtk-3-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
- **Windows**: [Visual Studio Build Tools](https://aka.ms/vs/17/release/vs_buildtools.exe) with the "Desktop development with C++" workload

### Setup

```sh
git clone https://github.com/Intevity/sentinel
cd sentinel
pnpm install
```

`pnpm install` automatically compiles the `better-sqlite3` native addon and `esbuild` for your platform.

### Build the Tauri app (includes the daemon)

The daemon is compiled into a self-contained binary by `beforeBuildCommand` automatically — you do not build it separately.

```sh
# Current platform only
pnpm --filter @sentinel/app run tauri:build

# Cross-compile for a specific macOS target
pnpm --filter @sentinel/app run tauri:build -- --target aarch64-apple-darwin
pnpm --filter @sentinel/app run tauri:build -- --target x86_64-apple-darwin
```

> **`tauri:build` is the full release build.** Because the updater is configured
> (`plugins.updater.pubkey` + `bundle.createUpdaterArtifacts`), it signs the
> updater artifacts and will prompt for the `~/.tauri/*.key` password. For local
> iteration use **`pnpm build:app`** instead (see [Running a local build](#running-a-local-build)) —
> it builds unsigned and runs your changes on any OS.

What `tauri:build` does internally:

1. Compiles the daemon TypeScript (`tsc`)
2. Runs `build:sidecar` — packages the daemon into a self-contained platform binary using [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) and places it in `packages/app/src-tauri/binaries/`
3. Builds the React frontend (`vite build`)
4. Compiles the Rust Tauri backend and bundles everything

Artifacts land in `packages/app/src-tauri/target/release/bundle/`:

| Platform | Output                       |
| -------- | ---------------------------- |
| macOS    | `macos/Sentinel.app`, `.dmg` |
| Linux    | `.deb`, `.rpm`, `.AppImage`  |
| Windows  | `.msi`, NSIS installer       |

### Running a local build

**One command, any OS — `pnpm build:app`.** It detects your platform
([`scripts/build-app.mjs`](./scripts/build-app.mjs)), builds your local changes
**unsigned** (so there's **no `~/.tauri/*.key` password prompt**, via the shared
[`tauri.dev.conf.json`](./packages/app/src-tauri/tauri.dev.conf.json) override),
and launches the result:

```sh
pnpm build:app
```

| OS          | What `pnpm build:app` does                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------ |
| **macOS**   | Builds the `.app`, replaces `/Applications/Sentinel.app`, re-signs ad-hoc, and opens it          |
| **Linux**   | Builds an unsigned `.AppImage` and launches it (`--appimage-extract-and-run`, so no FUSE needed) |
| **Windows** | Builds the unsigned NSIS `-setup.exe` and launches the installer                                 |

> Quit Sentinel before running on macOS — the script refuses to swap a
> running app. Preview the per-OS plan without building via
> `node scripts/build-app.mjs --dry-run` (add `--platform=linux|win32|darwin`).
>
> Why per-OS: only macOS needs the install-and-re-sign dance — it defeats the
> amfid code-signature cache that would otherwise SIGKILL the daemon sidecar.
> Linux/Windows have no such cache, so they just build and run the bundle.

**Inner dev loop (all OSes), with hot-reload:** for fast iteration use
`tauri dev` instead of a full bundle. It does **not** run the sidecar build (its
`beforeDevCommand` is just Vite), so build the daemon binary once first:

```sh
pnpm --filter @sentinel/daemon run build
pnpm --filter @sentinel/daemon run build:sidecar
pnpm --filter @sentinel/app run tauri:dev
```

> **Signed release build:** `pnpm build:app:release` runs the full `tauri build`
> (all bundle targets + signed updater artifacts) and **will** prompt for the
> updater key password. CI does this via tauri-action; you rarely need it locally.

#### macOS: how the install path works (`pnpm build:app` → `install-app.sh`)

On macOS, `pnpm build:app` runs [`scripts/install-app.sh`](./scripts/install-app.sh)
(also runnable directly, or via the `pnpm install:app` alias), which:

1. Builds an **unsigned** `.app` (updater artifacts disabled via
   [`tauri.dev.conf.json`](./packages/app/src-tauri/tauri.dev.conf.json)), so
   there is **no signing-key password prompt** and no Apple Developer ID
   requirement (the bundle is ad-hoc signed).
2. Refuses to run if Sentinel is still open (quit it from the tray first).
3. Removes the existing `/Applications/Sentinel.app`, copies the fresh
   bundle, re-signs it ad-hoc, verifies, and launches it.

> **Do not `cp -R` a build over the existing app yourself.** `cp -R` into an
> existing `/Applications/Sentinel.app` _merges_ into it, and macOS
> protects the installed app's files — so you get `cp: ... Operation not permitted`
> for `Contents/MacOS/...`, `Info.plist`, etc. The script avoids this by removing
> the old app first; the ad-hoc re-sign step is also load-bearing (without it the
> daemon sidecar is SIGKILLed on first launch by a stale code-signature cache).
>
> If `rm -rf` itself reports "Operation not permitted", grant your terminal **App
> Management** under System Settings → Privacy & Security → App Management, then
> re-run.

For a daemon-only change you don't need a full app rebuild — see the fast
iteration loop in [`CLAUDE.md`](./CLAUDE.md) (rebuild the sidecar and swap just
the binary in the installed bundle).

### Build the daemon binary standalone

If you need just the daemon binary (e.g. for testing):

```sh
pnpm --filter @sentinel/daemon run build          # tsc compile
pnpm --filter @sentinel/daemon run build:sidecar  # pkg → platform binary
```

Output: `packages/app/src-tauri/binaries/sentinel-daemon-<triple>[.exe]`

### Release via GitHub Actions

Pushing a `v*` tag triggers the release workflow automatically:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds the Tauri app (with daemon sidecar embedded) for all four platforms in parallel and **signs + notarizes the macOS bundle**. Notarization is **decoupled** from the expensive macOS runner so Apple's notary queue can't burn 10x CI minutes: the macOS build legs sign and submit to Apple _without waiting_, then exit. A short `notarize-wait` job (ubuntu, 1x) catches the common fast case; if Apple's queue is slow, the release **defers without holding a runner** and the scheduled `notarize-poll` workflow finalizes it whenever Apple completes (even hours later, at the cost of a few seconds of polling per check — not a held runner). Finalizing staples the ticket into the `.dmg` + updater tarball (re-signing the tarball), promotes the GitHub release, and — when the auto-update channel is configured — mirrors the updater artifacts for **every platform** to S3: the stapled macOS tarballs, plus the Linux (`.AppImage`/`.deb`/`.rpm`) and Windows (`-setup.exe`/`.msi`) bundles exactly as built. Windows/Linux publication is deliberately gated on the macOS staple so one `latest.json` goes live atomically with the same version everywhere. When the Azure signing variables are set (see [Windows code signing](#windows-code-signing) below), the Windows app, NSIS `-setup.exe`, MSI, and the embedded daemon sidecar are Authenticode-signed via Azure Trusted/Artifact Signing; leave them unset and the Windows leg builds unsigned. Every platform's download is additionally minisign-verified by the updater.

The macOS legs **fail fast** if any Apple secret is missing, so a release can never ship unsigned (an unsigned macOS bundle can't be auto-updated). Set all of these before tagging:

**Required repository secrets** (Settings → Secrets and variables → Actions → Secrets):

| Secret                               | Purpose                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Updater signing key (minisign). **Back this up offline.** |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater key                              |
| `APPLE_CERTIFICATE`                  | Base64 of the Developer ID Application `.p12`             |
| `APPLE_CERTIFICATE_PASSWORD`         | Password for the `.p12`                                   |
| `APPLE_SIGNING_IDENTITY`             | `Developer ID Application: <Name> (<TEAMID>)`             |
| `APPLE_API_ISSUER`                   | App Store Connect API **Issuer ID** (notarization)        |
| `APPLE_API_KEY`                      | App Store Connect API **Key ID** (notarization)           |
| `APPLE_API_KEY_CONTENT`              | Base64 of the `AuthKey_<KeyID>.p8` (notarization)         |

The S3 auto-update channel uses **GitHub OIDC**, so there are **no AWS secrets** — CI assumes an IAM role instead. Provision the bucket + role with the [`terraform/`](./terraform) module, then set the repo **variables** it outputs:

**Required repository variables** (Settings → Secrets and variables → Actions → Variables) — auto-update channel; leave unset to skip S3 publishing entirely (the GitHub release is then the only channel):

| Variable              | Purpose                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S3_BUCKET`           | Bucket that hosts the public update channel                                                                                                                                                                    |
| `AWS_REGION`          | Bucket region                                                                                                                                                                                                  |
| `AWS_ROLE_ARN`        | IAM role CI assumes via OIDC to publish (output by the Terraform module)                                                                                                                                       |
| `UPDATER_PUBLIC_BASE` | Public HTTPS base mapping to the bucket root, e.g. `https://<bucket>.s3.<region>.amazonaws.com` or a CloudFront/custom domain. The updater endpoint baked into the binary becomes `<base>/stable/latest.json`. |

#### Windows code signing

Optional, and **OIDC end to end** — like the updater channel, no client secret is stored. When these variables are set, the release pipeline Authenticode-signs the Windows app exe, NSIS `-setup.exe`, MSI, and the embedded daemon sidecar with **Azure Trusted/Artifact Signing** (via Microsoft's `sign` tool); leave any unset and the Windows leg builds **unsigned** (exactly how a fork behaves). The build job runs in a `release` GitHub Environment whose name the Azure federated credential is scoped to.

Provision the GitHub→Azure identity, federated credential, and signer RBAC with the standalone **`azure-terraform`** module (kept as a sibling directory **outside** this repo, since it provisions a different cloud); it reads your existing signing account and outputs all six values plus a copy-paste `gh variable set` block. The certificate profile (`AZURE_TS_PROFILE`) is created by hand in the portal **after** identity validation completes, so set it last.

| Variable                | Purpose                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `AZURE_CLIENT_ID`       | Entra app registration the release job authenticates as via OIDC (no secret)                       |
| `AZURE_TENANT_ID`       | Entra tenant id                                                                                    |
| `AZURE_SUBSCRIPTION_ID` | Subscription that holds the signing account                                                        |
| `AZURE_TS_ENDPOINT`     | Signing account URI, e.g. `https://eus.codesigning.azure.net/` (region-specific)                   |
| `AZURE_TS_ACCOUNT`      | Trusted/Artifact Signing account name                                                              |
| `AZURE_TS_PROFILE`      | Public Trust certificate profile name (set **last**, after portal identity validation is Complete) |

#### How auto-update works (private source, public binaries)

The source repo can stay private. CI assumes a least-privilege IAM role via GitHub OIDC (no stored AWS
keys) and uploads only the updater bundles (each with its minisign `.sig`) and a `latest.json` manifest
to a **public-read** S3 prefix (`<bucket>/stable/`): macOS `.app.tar.gz` (signed + notarized), Linux
`.AppImage`/`.deb`/`.rpm`, and Windows `-setup.exe`/`.msi`. The in-app updater fetches `latest.json`
anonymously and verifies each download's minisign signature against the public key in
`tauri.conf.json` — so no GitHub token is embedded in the app, and a tampered artifact is rejected. Only
the compiled binaries are exposed, never the source. See [`terraform/`](./terraform) to provision the
bucket and role.

`latest.json` carries one entry per bundle type (`linux-x86_64-deb`, `windows-x86_64-msi`, …) so
package-manager installs update in place, plus the bare `{target}-{arch}` fallback keys the updater
uses when no bundle-specific key matches: `linux-x86_64` points at the AppImage, and `windows-x86_64`
points at the **NSIS** `-setup.exe`. The Windows fallback deliberately diverges from tauri-action's
MSI default — NSIS is Tauri's recommended updater installer (passive in-place reinstall, per-user
installs without elevation) — so don't "fix" it back; the MSI stays reachable under
`windows-x86_64-msi`.

To generate the updater key pair (do this once; **store the private key and its password in a password
manager — losing them means existing installs can no longer accept updates**):

```sh
pnpm --filter @sentinel/app exec tauri signer generate -w ~/.tauri/sentinel.key
# → public key goes in tauri.conf.json (plugins.updater.pubkey)
# → private key file contents → TAURI_SIGNING_PRIVATE_KEY secret
# → chosen password           → TAURI_SIGNING_PRIVATE_KEY_PASSWORD secret
```

## Development

### Run tests

```sh
npx vitest run --coverage
```

All tests must maintain **≥95% coverage** across statements, branches, functions, and lines.

### Run the daemon locally

```sh
pnpm --filter @sentinel/daemon run dev
```

### Run the Tauri app locally

Run the daemon first (above), then in a separate terminal:

```sh
pnpm --filter @sentinel/app run tauri:dev
```

In dev mode the app will log a warning if the sidecar binary hasn't been built yet and skip spawning it — that's expected. The IPC module retries the socket connection automatically once the daemon is running.

### Run the marketing site locally

The website lives in its own workspace, `packages/site` (Astro + React, static build). It is independent of the app and daemon.

```sh
pnpm install                                   # once, from the repo root
pnpm --filter @sentinel/site dev        # dev server with hot reload
pnpm --filter @sentinel/site build      # static build to packages/site/dist
pnpm --filter @sentinel/site preview     # serve the production build locally
pnpm --filter @sentinel/site typecheck   # astro check
```

The dev server serves the site under the `/sentinel` base path (matching the GitHub Pages URL), so open the localhost URL Astro prints rather than bare `/`.

**Demo videos:** the feature carousel ships branded placeholder posters. To add real recordings, follow `packages/site/public/videos/README.md` (filenames, shot list) and flip `hasVideo: true` for that feature in `packages/site/src/data/features.ts`.

**Deploying:** `.github/workflows/deploy-site.yml` publishes the site to GitHub Pages on pushes that touch `packages/site/**`, but only when the repository variable `SITE_DEPLOY_ENABLED` is set to `true` (and Pages source is set to "GitHub Actions"). It stays off until then, so nothing publishes before the repo is public.

### Testing the security feature

The security scanner has four layers that each need exercising:

1. **Outbound detectors** — secrets, injection heuristics — run on the
   JSON body of every `POST /v1/messages` before the proxy forwards it
   upstream.
2. **Tool-use detectors** — risky bash, write, webfetch — run on streamed
   model responses.
3. **Permission rules** — the tool-permission enforcer strips denied tools
   from outbound `tools` arrays and substitutes synthetic block text into
   response-side `tool_use` blocks.
4. **Block-hold flow** — the Approve / Deny banner that holds a blocked
   request open while the user decides.

`pnpm security:test <scenario>` fires synthetic events that exercise
these layers end-to-end without any real malicious content:

```sh
pnpm security:test --list
pnpm security:test <scenario>
```

Two delivery paths are used:

- **Proxy delivery** — `secret-observe`, `secret-block`, `secret-pending`,
  `injection`, `injection-unicode-tag`, `secret-ghp` — POST a crafted body
  to `localhost:47284/v1/messages` with a fake bearer token. The scanner
  runs on the body _before_ any upstream call, so block-mode scenarios
  return 403 without touching Anthropic; observe-mode scenarios may 401
  upstream (expected — fake token) but still fire the full
  persist + broadcast + UI-notification pipeline.
- **IPC delivery** — everything else — goes through the daemon's
  `dev_trigger_security_event` IPC, dispatching into the same
  `persistAndBroadcast` / `createPending` / `recordBlockOutcome` paths the
  real scanner and enforcer use.

Scenarios grouped by category:

**Outbound secrets (proxy):**

| Scenario                | What it fires                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `secret-observe`        | AWS key in prompt; observe-mode finding persists.                                                                             |
| `secret-block`          | AWS key; `block_high` mode, immediate 403. Requires `securityEnforcementMode: block_high`, `securityBlockHoldEnabled: false`. |
| `secret-pending`        | AWS key; block mode + hold ON, pending banner. Requires `securityEnforcementMode: block_*`, `securityBlockHoldEnabled: true`. |
| `secret-ghp`            | ghp\_ token smoke-test for the `github-ghp` detector.                                                                         |
| `injection`             | `<\|im_start\|>` role-impersonation marker. Requires `securityScanInjection: true`.                                           |
| `injection-unicode-tag` | Unicode tag characters (always-on detector).                                                                                  |

**Additional secret types (IPC):**

| Scenario             | What it fires                                  |
| -------------------- | ---------------------------------------------- |
| `secret-anthropic`   | Synthetic `anthropic-key` finding via dev IPC. |
| `secret-openai`      | Synthetic `openai-key` finding.                |
| `secret-github-pat`  | Synthetic `github-pat` (fine-grained) finding. |
| `secret-private-key` | Synthetic `private-key-block` finding.         |

**Tool-use detectors (IPC):**

| Scenario                | What it fires                                 |
| ----------------------- | --------------------------------------------- |
| `risky-bash`            | HIGH-severity `curl\|sh` finding.             |
| `risky-write`           | HIGH-severity `~/.ssh/authorized_keys` write. |
| `risky-write-medium`    | MEDIUM-severity `~/.npmrc` write.             |
| `risky-webfetch`        | MEDIUM-severity `webhook.site` host.          |
| `tool-use-low-severity` | LOW-severity confidence/threshold test.       |
| `pending-block`         | Pending-block banner + OS notification.       |

**Scanner telemetry (IPC):**

The dev-trigger path bypasses the per-kind mute gates in Settings so these
always fire on command.

| Scenario                  | What it fires                                                      |
| ------------------------- | ------------------------------------------------------------------ |
| `scan-truncated`          | `scan_truncated` — response tap budget exceeded.                   |
| `scan-skipped-encoding`   | `scan_skipped_encoding` — non-UTF8 payload.                        |
| `scan-deferred-oversized` | `scan_deferred_oversized` — oversized body deferred to background. |

**Permission-rule blocks (IPC):**

Dispatched to the permissions enforcer, not the scanner. Exercises the
`tool_permission_blocked` persistence + broadcast path identical to a
real deny rule.

| Scenario                       | What it fires                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `permissions-strip`            | Whole-tool deny on a synthetic `Bash` rule (outbound strip).                                       |
| `permissions-tool-use-block`   | Immediate tool_use deny on a synthetic `WebFetch(*.example.com)` rule.                             |
| `permissions-tool-use-pending` | Held permissions pending block (banner + approve/deny). Requires `securityBlockHoldEnabled: true`. |

Examples:

```sh
# Populate the Security tab with a medium-severity tool-use finding.
pnpm security:test risky-webfetch

# Smoke-test the pending-block banner (approve/deny + countdown).
pnpm security:test pending-block

# Verify block-mode actually 403s. Set enforcement to "Block on HIGH"
# and disable "Hold blocked requests for approval" in Settings first.
pnpm security:test secret-block

# Exercise the permission enforcer's tool_use deny path.
pnpm security:test permissions-tool-use-pending
```

After each scenario, check:

- the **Security tab** for the new event,
- the **Alerts tab** for the mirrored notification (severity-tinted
  shield icon),
- the OS **Notification Center** when severity clears the configured
  threshold (Settings → Security → Notify me about).

The synthetic tokens used by the proxy scenarios are valid-shape garbage —
they match the detector prefixes but are not real credentials. The
literals are built by string concatenation inside the script (not stored
as one contiguous string) so your own security scanner doesn't flag them
when an agent reads the script as context. Each test run uses a unique
`match_hash` so the dedup logic doesn't suppress repeated runs.

### Testing alerts

`pnpm alerts:test <scenario>` exercises every user-visible non-security
notification — usage alerts, overage transitions, spend/budget alerts,
and account-lifecycle events. Each scenario dispatches via the
`dev_trigger_alert_event` IPC and synthesizes the same
`insertNotification` + `ipcServer.broadcast` pair the real evaluators
emit, so the Alerts tab and OS notifications render identically.

**Synthetic triggers do NOT mutate real alert state.** No alert row's
`last_triggered_reset_ts` is touched, and the SpendTracker's paused set
stays untouched — safe to run repeatedly.

```sh
pnpm alerts:test --list
pnpm alerts:test <scenario>
```

| Scenario           | What it fires                                                                     |
| ------------------ | --------------------------------------------------------------------------------- |
| `usage-account`    | Per-account 85% usage alert (`alert_triggered` + `usage_alert` notification row). |
| `usage-pool`       | Auto-mode pool-average 75% usage alert.                                           |
| `usage-budget`     | Per-account weekly budget alert at 90% with `spendUsd`/`budgetUsd`.               |
| `overage-entered`  | `overage_entered` broadcast + notification + OS notification.                     |
| `overage-disabled` | `overage_disabled` broadcast + notification + OS notification.                    |
| `account-switched` | `account_switched` broadcast + Alerts-tab row.                                    |
| `account-paused`   | `account_paused` broadcast (SpendTracker-style) + `usage_alert` row.              |
| `account-unpaused` | `account_unpaused` broadcast only (no history row).                               |

**Divergences from live behavior:**

- `account-switched`: the live path is broadcast-only (no Alerts-tab row).
  The synthetic scenario inserts a row so the event is verifiable from
  the Alerts history.
- `account-unpaused`: broadcast-only by design — mirrors live behavior,
  where unpause is a silent state transition.

After each scenario, check:

- the **Alerts tab** for the synthetic notification (titles end with
  `(synthetic)` or `TEST SCENARIO`),
- the **Usage tab** / **Overage tab** for any live-state changes,
- the OS **Notification Center** when the scenario's type is configured
  to fire in Settings → Notifications.

### Project structure

```
sentinel/
├── packages/
│   ├── daemon/src/            # Node.js daemon
│   │   ├── proxy.ts           # HTTP reverse proxy + overage header inspection
│   │   ├── otel-receiver.ts   # OTLP receiver
│   │   ├── ipc.ts             # Unix socket IPC
│   │   ├── db.ts              # SQLite schema + queries
│   │   ├── overage.ts         # Overage state machine
│   │   ├── accounts.ts        # OS credential store
│   │   ├── claude-state.ts    # ~/.claude.json management
│   │   ├── oauth.ts           # PKCE login flow
│   │   ├── settings.ts        # ~/.sentinel/settings.json
│   │   ├── token-rotator.ts   # Auto-mode account/token selector
│   │   ├── auto-switch.ts     # threshold-based auto-switch
│   │   └── alerts.ts          # user-configured alert evaluator
│   ├── app/                   # Tauri desktop app
│   │   ├── src/               # React frontend (Accounts / Usage / Metrics / Overage / Alerts tabs)
│   │   └── src-tauri/         # Rust backend
│   │       └── src/
│   │           ├── main.rs             # Tauri entry + window event handling
│   │           ├── daemon.rs           # sidecar spawn logic
│   │           ├── ipc.rs              # Unix socket bridge to daemon
│   │           ├── settings_patch.rs   # activate / deactivate Sentinel
│   │           └── tray.rs             # system tray menu
│   └── shared/src/            # Shared TypeScript types
```

## Debugging

### Daemon logs

The daemon writes timestamped logs to `~/.sentinel/daemon.log`. This file is the first place to look for any issue — OAuth failures, account switch errors, proxy problems, and IPC events are all logged there.

```sh
# Stream logs in real time
tail -f ~/.sentinel/daemon.log

# Last 100 lines
tail -100 ~/.sentinel/daemon.log

# Filter to OAuth events only
grep '\[OAuth\]' ~/.sentinel/daemon.log

# Filter to errors
grep 'ERROR' ~/.sentinel/daemon.log
```

The file appends across app restarts and is never truncated automatically. Rotate it manually if it grows large:

```sh
> ~/.sentinel/daemon.log
```

### Check daemon health

The daemon exposes a `/health` endpoint on its proxy port:

```sh
curl http://localhost:47284/health
# {"status":"ok","pid":12345}
```

If this returns an error or times out, the daemon is not running. Relaunch the app or check the log for a startup crash. The ⋯ menu inside the app also shows live pid/uptime.

### Check the IPC socket

The app communicates with the daemon over a Unix socket:

```sh
ls -la ~/.sentinel/daemon.sock
```

If the socket file is missing after the app is running, the daemon failed to start. Check the log for details.

### App-side logs (DevTools)

**Click the `dev` version badge in the footer.** The `dev` badge is a toggle — click to open DevTools, click again to close. What you get per-platform:

- **macOS**: Safari Web Inspector (WKWebView's native inspector) docks inside the Sentinel window.
- **Windows**: Edge DevTools (WebView2 = Chromium, so this is the same Chrome DevTools UI you know) docks inside the Sentinel window.
- **Linux**: WebKitGTK Inspector docks inside the Sentinel window.

**How the window behaves when DevTools is open**: the tray window is normally pinned to 540×628 non-resizable (tray-menu ergonomics). When you click `dev` to open DevTools, Tauri's `toggle_devtools` command lifts those constraints and grows the window to 1280×900 with resizing enabled, so the docked inspector has room to work. The frontend's auto-resize hook pauses via a `devtools_state_changed` Tauri event so it doesn't fight the expanded size. Clicking `dev` again closes DevTools, restores the tray size, re-locks resizable, and resumes auto-resizing.

**Why docked in Sentinel rather than a separate Safari window?** Earlier revisions tried driving Safari's Develop menu via AppleScript to get a separate inspector window. It required two one-time macOS permissions (Safari Develop menu + Accessibility grant) and the automation was fragile across macOS locales / Safari versions. The expand-while-open approach uses Tauri's standard [`open_devtools`/`close_devtools`](https://v2.tauri.app/develop/debug/) APIs directly — no extra permissions, cross-platform, zero platform-specific code.

**Feature equivalence**: Safari Web Inspector, Edge DevTools, and WebKitGTK Inspector all provide the same tools — Console, Network, Elements, Sources with breakpoints, Timelines/Performance, Memory, Storage/Application. Safari's layout differs from Chrome's (left sidebar vs. top tabs) but the tools are functionally the same.

**claude.ai login webview** (opened by **Connect claude.ai** in Settings → Overage spend tracking) — right-click anywhere → Inspect. Use this whenever login fails:

- **Network tab** captures every request the auth flow makes. If login errors out, the failing request + response body is visible here.
- **Console tab** surfaces the Sentinel-injected cookie-poll script's logs (`[Sentinel login] init script loaded. UA: …`, `[Sentinel login] sessionKey captured, handing off to Rust`) plus any claude.ai JS errors.

> **Note:** "Continue with Google" doesn't work in embedded webviews — Google actively blocks them. Use email / magic-link / Apple login inside the Connect window instead.

### Common issues

**"No credentials stored for this account"** when switching
The daemon stores credentials per account UUID the first time you sync. Open the app, click **Sync** while each account is active in Claude Code (one at a time) to capture its token. After syncing both accounts, switching works without re-login.

**Add Account completes but Sentinel shows a blue "already added" notice**
The OAuth consent page returned a token for an org you already have. This happens when your claude.ai browser session is signed in to a different org than the one you wanted to add. Open claude.ai in the browser, use the org selector (top-left sidebar) to switch to the org you want to add, then click **Add Account** again.

**Add Account completes in browser but app shows "Login failed or was cancelled"**
Check the daemon log for an `[OAuth]` error after the callback. Common causes:

- `Token exchange failed (400)` — the authorization code expired (took too long to complete the flow); try again
- `security: SecKeychainItemAdd` error — macOS denied keychain write; check System Settings → Privacy & Security → Keychain

**Proxy not intercepting Claude Code requests**
Verify `~/.claude/settings.json` contains `ANTHROPIC_BASE_URL=http://localhost:47284`. If it's missing, click **Activate Sentinel** in the app, then restart Claude Code.

**App icon missing from menu bar**
macOS hides menu bar icons when the bar is full. Drag to reveal, or hold ⌘ and drag the icon to reorder/uncover it.

## How overage detection works

Claude Code routes all API calls through the sentinel daemon (`ANTHROPIC_BASE_URL=http://localhost:47284`). On each response from Anthropic, the daemon inspects:

```
anthropic-ratelimit-unified-overage-status: active
anthropic-ratelimit-unified-overage-reset: 1776700800
```

A state machine tracks `isUsingOverage` per account UUID. When it transitions from `false → true`, the daemon:

1. Writes an overage event to SQLite
2. Sends `{ type: 'overage_entered', accountId, resetsAt }` to the Tauri app via IPC
3. The Tauri app fires a native OS notification

The response is forwarded to Claude Code unmodified — the proxy is transparent.

## Security

- The proxy only listens on `127.0.0.1:47284` — never exposed to the network.
- Inactive account credentials are stored in the OS keychain (Keychain on macOS, Credential Manager on Windows, libsecret on Linux) under the service name `Sentinel-credentials`.
- The daemon never logs credential values — only metadata (email, UUID) is stored in SQLite.
- The IPC socket is created with `0600` permissions (owner read/write only).
- `~/.claude.json` and `~/.claude/settings.json` writes use atomic rename.

## License

MIT © Intevity
