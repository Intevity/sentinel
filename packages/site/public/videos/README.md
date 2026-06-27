# Feature demo videos

The landing page shows 15 short demo clips: 6 in the homepage carousel
(`src/components/FeatureCarousel.tsx`, driven by `src/data/features.ts`) and 9 in
the pillar lightboxes (`src/components/Pillars.astro`, driven by
`src/data/pillars.ts`). Each `<slug>.mp4` here has a matching `<slug>.jpg` poster
(its loading frame).

All 15 are recorded. Each clip is a bookended composite —
`<slug>-intro.mp4` → an app screen recording → `<slug>-outro.mp4` — produced by
the recording pipeline in `packages/app/demo-recordings/` (real React UI + mock
IPC bridge + fake macOS desktop) with branded bookends from
`packages/site/video-bookends/`.

## How to (re)record a clip

See the `record-demo-clip` skill (`.claude/skills/record-demo-clip/`) for the
full procedure and gotchas. In short, from `packages/app/demo-recordings/`:

```sh
node mock-bridge.mjs &                                            # bridge :47999
VITE_E2E=true pnpm --filter @sentinel/app exec vite --port 5180 & # app :5180
node record-clip.mjs <slug>                                       # → out/<slug>.mp4
cp out/<slug>.mp4 ../../site/public/videos/<slug>.mp4
ffmpeg -y -ss 1.2 -i ../../site/public/videos/<slug>.mp4 -vframes 1 \
  -vf scale=1280:720 -q:v 4 ../../site/public/videos/<slug>.jpg
pnpm --filter @sentinel/site build
```

`hasVideo: true` and the `.jpg` poster ref are set for all 15 entries already;
only touch them when adding a brand-new clip.

## The 15 clips

| File              | Surface  | What it shows                                                       |
| ----------------- | -------- | ------------------------------------------------------------------- |
| `security.mp4`    | Carousel | Risky tool call flagged in flight; deny a HIGH event.               |
| `optimize.mp4`    | Carousel | Realized vs potential token savings, climbing.                      |
| `accounts.mp4`    | Carousel | Switch the active account; flip switching to Auto.                  |
| `usage.mp4`       | Carousel | Pooled + per-account rate-limit windows with live reset countdowns. |
| `alerts.mp4`      | Carousel | Set a threshold; native notification fires; open history.           |
| `metrics.mp4`     | Carousel | Cost / token / cache breakdown over time from the OTEL receiver.    |
| `switching.mp4`   | Pillar   | Auto switching reroutes to the account resetting soonest.           |
| `pool.mp4`        | Pillar   | Pooled account cards with live utilization + timers.                |
| `caps.mp4`        | Pillar   | A 7-day spend cap pauses an account from rotation.                  |
| `scanning.mp4`    | Pillar   | A secret/risky call flagged in flight; expand severity + source.    |
| `rules.mp4`       | Pillar   | Add an allow/deny rule; an `ask` rule prompts.                      |
| `sandbox.mp4`     | Pillar   | Toggle isolation on; allowed paths + domains + status.              |
| `subagents.mp4`   | Pillar   | Curated subagents with realized vs potential savings.               |
| `compression.mp4` | Pillar   | Reversible tool-output compression; ~75% content reduced.           |
| `codemode.mp4`    | Pillar   | Bridge an MCP server; its tool defs leave the request context.      |
