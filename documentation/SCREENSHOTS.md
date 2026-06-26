# Documentation screenshots

The docs site ([`packages/site`](../packages/site), served at
`https://intevity.github.io/sentinel/docs/`) references the screenshots listed below. Each one
currently ships as a **labeled placeholder PNG** so the pages render correctly; replace each file
with a real capture using the **exact same filename**, and the docs pick it up automatically.

## Where the files live

```
packages/site/public/screenshots/<name>.png
```

They're served at `/sentinel/screenshots/<name>.png` and referenced from the MDX pages under
`packages/site/src/content/docs/docs/`. Don't rename them — the references are hard-coded.

## How to capture

- **App window shots** — the Sentinel tray window is 540×628 points. Capture at **2× (Retina)** so
  the file is ~**1080×1256 px**. On macOS, `⇧⌘4` then press <kbd>Space</kbd> and click the window
  captures just the window with a clean shadow; crop the shadow out if you want a tight frame.
- **Use the dark theme** (Settings → Theme → Dark) so screenshots match the docs site, which is
  dark by default.
- **Populate realistic state** before capturing. Enroll two or three accounts. To fill the Security
  and Alerts tabs without waiting for real events, use the synthetic triggers:
  - `pnpm security:test risky-webfetch` — adds a medium-severity finding to the Security tab.
  - `pnpm security:test pending-block` — shows the approve/deny hold banner.
  - `pnpm alerts:test usage-account` — adds a usage alert to the Alerts tab + history.
  - `pnpm alerts:test --list` — see all alert scenarios.
- **Redact** any real email addresses / org names if you don't want them public (the color-tagged
  account cards still read well with placeholder names).
- Export as **PNG**. Keep files reasonably small (these are docs assets, not print).

## The shots

| Filename                    | Recommended size | Capture                                                                                    | Used on                          |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------ | -------------------------------- |
| `first-launch.png`          | 1080×1256        | The window right after first launch, before activation.                                    | Getting Started → Installation   |
| `activation-banner.png`     | 1080×1256        | The **Activate Sentinel** banner visible at the top of the window.                         | Getting Started → Quick start    |
| `accounts-tab.png`          | 1080×1256        | **Accounts** tab with 2–3 enrolled accounts; header shows the active account + plan.       | Quick start; Features → Accounts |
| `account-switcher.png`      | 1080×700         | The account switcher / header area mid-switch (the active-account control).                | Features → Accounts              |
| `security-tab.png`          | 1080×1256        | **Security** tab with at least one live finding (run `pnpm security:test risky-webfetch`). | Features → Security scanning     |
| `security-setup-wizard.png` | 1080×1256        | The first-run security setup wizard (enforcement mode + hold choice).                      | Features → Security scanning     |
| `permission-rules.png`      | 1080×1256        | The **Permission Rules** panel with a few allow/deny/ask rules.                            | Features → Permission rules      |
| `sandbox-isolation.png`     | 1080×1256        | The sandbox isolation panel with allowed paths/domains configured.                         | Features → Sandbox isolation     |
| `usage-tab.png`             | 1080×1256        | **Usage** tab showing the rate-limit windows with reset countdowns.                        | Features → Usage & rate limits   |
| `metrics-dashboard.png`     | 1080×1256        | **Metrics** tab with cost / tokens / cache and a per-model breakdown.                      | Features → Metrics               |
| `optimize-dashboard.png`    | 1080×1256        | **Optimize** tab showing realized vs potential savings.                                    | Features → Token optimization    |
| `compression-panel.png`     | 1080×1256        | The compression panel within Optimize, showing trimmed payloads.                           | Features → Token optimization    |
| `alerts-tab.png`            | 1080×1256        | **Alerts** tab with a configured threshold (run `pnpm alerts:test usage-account`).         | Features → Alerts                |
| `notification-history.png`  | 1080×1256        | The notification-history timeline with a few entries.                                      | Features → Alerts                |
| `settings-panel.png`        | 1080×1256        | The **Settings** panel (top section is fine).                                              | Reference → Settings             |
| `tray-menu.png`             | 760×900          | The system tray / menu-bar dropdown menu open.                                             | Reference → Tray & window        |

## Regenerating placeholders

If you add a new screenshot reference in the docs, add a row above and either capture it or
regenerate placeholders. The placeholders were produced by a small `sharp` script (gray card +
label); re-run it (or hand-author a PNG) so the new reference resolves while you wait for the real
capture.
