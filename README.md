# Sentinel

An open-source Claude Code companion: a tray app and bundled local daemon for in-flight security
scanning, permission rules, and sandbox isolation; multi-account routing; token-cost optimization;
usage metrics; and overage alerts.

**Website:** https://intevity.github.io/sentinel · **Documentation:** https://intevity.github.io/sentinel/docs/

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

## Table of contents

- [What it is](#what-it-is)
- [Download](#download)
- [Quick start](#quick-start)
- [Documentation](#documentation)
- [Features](#features)
- [Security](#security)
- [Building from source](#building-from-source)
- [Contributing](#contributing)
- [License](#license)

## What it is

Sentinel sits transparently between [Claude Code](https://claude.com/claude-code) and Anthropic's
API. Activate it once and every Claude request flows through a local daemon that can scan and
sandbox it, enforce permission rules, route across the Claude accounts you own, trim wasted tokens,
and catch overage spend — all on your machine, with **no telemetry** and credentials kept in your
OS keychain.

It covers both surfaces: the **Claude Code CLI** (terminal) and the **Claude Desktop app** (Chat +
Code). Sentinel detects whichever you have installed — including the second one you add later — and
routes each through the proxy with a single click.

```
Claude Code CLI  ─┐
                  ├─→  127.0.0.1:47284  ──→  api.anthropic.com
Claude Desktop   ─┘   (sentinel daemon)
                            │
                            │  Unix socket / named pipe
                            ▼
                      Sentinel App (Tauri v2 tray app)
```

- **App** (`packages/app`) — a Tauri v2 tray app that bundles and supervises the daemon, patches
  `~/.claude/settings.json` for the CLI, and writes the desktop app's `Claude-3p` gateway config on
  activation.
- **Daemon** (`packages/daemon`) — a Node.js reverse proxy, OTLP telemetry receiver, MCP server, and
  SQLite store, compiled into a single binary embedded in the app.

See the [Architecture guide](https://intevity.github.io/sentinel/docs/developers/architecture/) for
the full picture.

## Download

Grab the latest installer from the
**[Releases page](https://github.com/Intevity/sentinel/releases/latest)**, or pick your platform:

| Platform                                   | Format        | Download                                                               |
| ------------------------------------------ | ------------- | ---------------------------------------------------------------------- |
| **macOS** — Apple Silicon (M1/M2/M3/M4/M5) | `.dmg`        | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |
| **macOS** — Intel                          | `.dmg`        | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |
| **Windows** 10/11                          | `.msi` / NSIS | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |
| **Linux** (Debian/Ubuntu)                  | `.deb`        | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |
| **Linux** (Fedora/RHEL)                    | `.rpm`        | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |
| **Linux** (portable)                       | `.AppImage`   | [Latest release](https://github.com/Intevity/sentinel/releases/latest) |

macOS release builds are signed with a Developer ID certificate and notarized by Apple, so they open
with a normal double-click. Full per-OS steps (including Linux system libraries) are in the
**[Installation guide](https://intevity.github.io/sentinel/docs/getting-started/installation/)**.

## Quick start

1. **Install** and **launch** Sentinel — the tray icon appears and the daemon starts automatically.
2. **Click "Activate Sentinel"** to point the Claude Code CLI at the proxy (writes
   `ANTHROPIC_BASE_URL=http://127.0.0.1:47284` into `~/.claude/settings.json`), then **restart
   Claude Code**.
3. _(If you use the Claude Desktop app)_ Click **Enable** on the **Claude Desktop** card to route it
   too, then fully quit and reopen the desktop app. See
   [Connect Claude Desktop](https://intevity.github.io/sentinel/docs/guides/connect-claude-desktop/).
4. **Add Account** and complete the OAuth flow for each Claude subscription you own.
5. _(Optional)_ Turn on **Auto** switching in Settings to route across accounts automatically.

The full walkthrough is in the
**[Quick start guide](https://intevity.github.io/sentinel/docs/getting-started/quick-start/)**.

## Documentation

Complete documentation lives at **https://intevity.github.io/sentinel/docs/** — for end users and
developers alike:

- **[Getting started](https://intevity.github.io/sentinel/docs/getting-started/introduction/)** — install, first launch, quick start.
- **[Features](https://intevity.github.io/sentinel/docs/features/accounts/)** — a page for everything Sentinel does.
- **[Guides](https://intevity.github.io/sentinel/docs/guides/connect-claude-code/)** — task-oriented how-tos.
- **[Reference](https://intevity.github.io/sentinel/docs/reference/settings/)** — settings, troubleshooting, privacy.
- **[Developers](https://intevity.github.io/sentinel/docs/developers/architecture/)** — architecture, building, testing, releases.

The docs are built with [Astro Starlight](https://starlight.astro.build/) and live in
[`packages/site/src/content/docs/`](./packages/site/src/content/docs/).

## Features

- **[Security scanning](https://intevity.github.io/sentinel/docs/features/security-scanning/)** — in-flight detectors for secrets, PII, prompt injection, and risky tool use, with observe/block modes and an approve/deny hold.
- **[Permission rules](https://intevity.github.io/sentinel/docs/features/permission-rules/)** — allow/deny/ask rules kept in lockstep with Claude Code's `settings.json`.
- **[Sandbox isolation](https://intevity.github.io/sentinel/docs/features/sandbox/)** — optional OS-level limits on the files and domains Claude Code's commands can reach.
- **[Multi-account routing](https://intevity.github.io/sentinel/docs/features/accounts/)** — enroll the Claude accounts you own; switch manually or let Auto mode favor the window that resets soonest.
- **[Token optimization](https://intevity.github.io/sentinel/docs/features/optimization/)** — curated cheaper subagents, reversible payload compression, and MCP code execution.
- **[Usage](https://intevity.github.io/sentinel/docs/features/usage/)**, **[metrics](https://intevity.github.io/sentinel/docs/features/metrics/)**, and **[overage alerts](https://intevity.github.io/sentinel/docs/features/alerts/)** — real cost/token telemetry, rate-limit windows, spend caps, and threshold notifications.

## Security

- The proxy listens only on `127.0.0.1:47284` — never exposed to the network.
- Inactive-account credentials are stored in the OS keychain (Keychain on macOS, Credential Manager
  on Windows, libsecret on Linux) under the service name `Sentinel-credentials`.
- The daemon never logs credential values; security findings store redacted fingerprints only.
- The IPC socket is created with `0600` permissions; `~/.claude.json` and `~/.claude/settings.json`
  writes use atomic rename.
- There is **no telemetry**.

Full details: [Privacy & security model](https://intevity.github.io/sentinel/docs/reference/privacy-security/).

## Building from source

```sh
git clone https://github.com/Intevity/sentinel
cd sentinel
pnpm install
pnpm build:app        # build + launch your local changes (unsigned), any OS
```

Prerequisites (pnpm 9+, Rust stable, Node 24+, platform toolchains) and the full dev loop — including
the daemon-only fast path and the signed release build — are documented in
**[Building from source](https://intevity.github.io/sentinel/docs/developers/building/)**.

## Contributing

Contributions are welcome. Run `pnpm typecheck`, `pnpm lint`, and `pnpm test` before opening a PR,
and write commits in the enforced conventional-commit format (release notes are generated from
them). See the
**[Contributing guide](https://intevity.github.io/sentinel/docs/developers/contributing/)** and
[`CLAUDE.md`](./CLAUDE.md) for the development reference.

## License

MIT © Intevity
