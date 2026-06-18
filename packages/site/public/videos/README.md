# Feature demo videos

The landing page carousel (`src/components/FeatureCarousel.tsx`) shows one short demo per
feature. Until the real recordings exist, each slot falls back to a branded poster SVG in this
folder and shows a "Demo video coming soon" badge.

## How to add a real recording

1. Record the clip (see the shot list below) and export it as an **MP4 (H.264)**.
2. Drop it in this folder using the exact filename from the table.
3. In `packages/site/src/data/features.ts`, set `hasVideo: true` for that feature.
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
| `accounts.mp4` | Multi-account | The Accounts tab: add an account, switch the active account, toggle round-robin on, and pick the balance vs earliest-reset strategy.        |
| `usage.mp4`    | Usage & caps  | Usage view: pool-wide vs per-account, the live reset countdowns, and setting an overage spend cap.                                          |
| `alerts.mp4`   | Alerts        | Alerts tab: set a threshold, trigger the notification, and open the alert history.                                                          |
| `metrics.mp4`  | Metrics       | Metrics tab: the real cost, token counts, and cache hit rate breakdown over a date range.                                                   |
| `optimize.mp4` | Optimize      | Optimize page: before/after token savings on a tool result, and a reversible-retrieval round-trip.                                          |

> Tip: if any single clip is long, you can trim to the key 8-12 seconds. The carousel
> auto-advances every 7 seconds, so a tight loop reads best.
