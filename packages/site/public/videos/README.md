# Feature demo videos

The landing page carousel (`src/components/FeatureCarousel.tsx`) shows one short demo per
feature. Until the real recordings exist, each slot falls back to a branded poster SVG in this
folder and shows a "Demo video coming soon" badge.

## How to add a real recording

1. Record the clip (see the shot list below) and export it as an **MP4 (H.264)**.
2. Drop it in this folder using the exact filename from the table.
3. In `packages/site/src/data/features.ts` (or `packages/site/src/data/pillars.ts` for the
   pillar sub-feature clips below), set `hasVideo: true` for that entry.
4. Rebuild (`pnpm --filter @sentinel/site build`). The carousel now plays the video
   (muted, looping) with the poster as its loading frame.

Optionally replace the poster SVG with a real frame grab of the same name (`<slug>.svg` →
keep the name, or change the `poster` field if you prefer a `.png`/`.jpg`).

## Recommended capture settings

- **Resolution:** 1920x1080 (the frame is displayed 16:9).
- **Length:** 10 to 20 seconds, looping cleanly (end where you began).
- **Audio:** none. The carousel plays muted.
- **Theme:** record in the app's dark theme for consistency with the site.
- **Cursor:** move deliberately and slowly; pause briefly on the moment that matters.
- **Keep it short:** one clear action per clip, no dead time.

## Shot list

| File           | Feature       | What to show                                                                                                                                |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `security.mp4` | Security      | The Security tab: a secret or risky Bash call gets flagged; expand an alert to show severity, category, and provenance; block a HIGH event. |
| `accounts.mp4` | Multi-account | The Accounts tab: add an account, switch the active account, and turn Account Switching to Auto.                                            |
| `usage.mp4`    | Usage & caps  | Usage view: pool-wide vs per-account, the live reset countdowns, and setting an overage spend cap.                                          |
| `alerts.mp4`   | Alerts        | Alerts tab: set a threshold, trigger the notification, and open the alert history.                                                          |
| `metrics.mp4`  | Metrics       | Metrics tab: the real cost, token counts, and cache hit rate breakdown over a date range.                                                   |
| `optimize.mp4` | Optimize      | Optimize page: before/after token savings on a tool result, and a reversible-retrieval round-trip.                                          |

> Tip: if any single clip is long, you can trim to the key 8-12 seconds. The carousel
> auto-advances every 7 seconds, so a tight loop reads best.

## Pillar sub-feature clips

These nine clips feed the pillar deep-dive cards (`src/data/pillars.ts`, one card per
sub-feature). Until recorded, each card shows its branded poster placeholder with a
"Demo video coming soon" badge. Set `hasVideo: true` on the matching entry in
`pillars.ts` (not `features.ts`) once the `.mp4` lands here. Same capture settings as above.

| File              | Pillar        | What to show                                                                                       |
| ----------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `switching.mp4`   | Multi-account | Flip Account Switching to Auto; watch the header reroute to the account resetting soonest.         |
| `pool.mp4`        | Multi-account | The pooled Accounts view: several plans side by side with live utilization and reset timers.       |
| `caps.mp4`        | Multi-account | Set a 7-day spend cap; show an account pausing from rotation when it crosses the cap.              |
| `scanning.mp4`    | Security      | A secret or risky Bash call flagged in flight; expand the finding to show severity and source.     |
| `rules.mp4`       | Security      | Add a per-tool allow/deny rule; show it syncing into Claude Code, and an `ask` rule prompting.     |
| `sandbox.mp4`     | Security      | Toggle sandbox isolation on; show a command confined to the allowed paths and domains.             |
| `subagents.mp4`   | Optimization  | The Subagents tab: install a curated subagent; show realized vs potential savings.                 |
| `compression.mp4` | Optimization  | The Compression tab: before/after tokens on a tool result, plus a reversible-retrieval round-trip. |
| `codemode.mp4`    | Optimization  | The Context tab: bridge an MCP server; show its tool definitions leaving the request context.      |
