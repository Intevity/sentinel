---
name: record-demo-clip
description: >-
  Record, re-record, or add a Sentinel marketing demo clip. Use when asked to
  (re)record any of the 15 carousel/pillar videos on the marketing site, fix a
  clip that shows wrong/"No data", add a clip for a new tab, or change the
  bookends. Drives the real Sentinel React UI against a mock IPC bridge on a
  fake macOS desktop, records with Playwright, and composites bookends with
  ffmpeg.
---

# Recording Sentinel demo clips

The marketing site (`packages/site`) shows 15 short demo clips: 6 in the
homepage carousel (`src/data/features.ts`) and 9 in the pillar lightboxes
(`src/data/pillars.ts`). Each clip is a **bookended composite**:
`<slug>-intro.mp4` → app screen recording → `<slug>-outro.mp4`.

The 15 slugs:
`security optimize accounts usage alerts metrics switching pool caps scanning
rules sandbox subagents compression codemode`.

## How it works

The real Sentinel React app runs against a **mock IPC bridge** instead of the
daemon, inside a **fake macOS desktop** so the window looks installed:

- `packages/app/demo-recordings/mock-bridge.mjs` — HTTP server on **:47999**. Speaks
  the daemon IPC protocol: `POST /` returns `{requestType,success,data}`, `GET
/events` is an SSE broadcast stream. Also serves `stage.html` at `/stage?app=<url>`
  and the brand assets. Holds all the sanitized fixtures (accounts, rate limits,
  metrics, security events, rules, alerts, …) and `__demo_*` control messages
  that push broadcasts at a scripted beat.
- The app runs under Vite in E2E mode on **:5180** (`VITE_E2E=true`), which makes
  `packages/app/src/lib/ipc.ts` talk to the bridge over HTTP instead of Tauri.
- `stage.html` renders a 540×628 `<iframe id="app">` (the real tray size) centered
  on a macOS desktop with a working menu bar + dock + a live tray usage %.
- `record-clip.mjs <slug>` launches Playwright (Chromium from `@playwright/test`),
  drives the app via `frameLocator('#app')` with a synthetic cursor, runs the
  per-slug **recipe** from `recipes.mjs`, records 1920×1080, applies an optional
  ffmpeg `zoompan` push-in, then composites the bookends → `out/<slug>.mp4`.

Bookends are generated separately from branded HTML by
`packages/site/video-bookends/capture.mjs`.

## Prerequisites (once)

```sh
# ffmpeg with libx264 (macOS: /usr/local/bin/ffmpeg)
# Playwright's Chromium:
pnpm --filter @sentinel/app exec playwright install chromium
```

## Recording / re-recording an existing clip

From `packages/app/demo-recordings/`:

```sh
# 1. Start the mock bridge (:47999). Run from THIS dir (relative path matters).
node mock-bridge.mjs &

# 2. Start the app in E2E mode (:5180), from the repo root.
VITE_E2E=true pnpm --filter @sentinel/app exec vite --port 5180 &

# 3. Record one clip → out/<slug>.mp4 (and out/<slug>-app.mp4, the bare app part).
node record-clip.mjs usage

# 4. Deploy to the site + regenerate the poster frame.
cp out/usage.mp4 ../../site/public/videos/usage.mp4
ffmpeg -y -ss 1.2 -i ../../site/public/videos/usage.mp4 -vframes 1 \
  -vf scale=1280:720 -q:v 4 ../../site/public/videos/usage.jpg

# 5. Rebuild the site and confirm.
pnpm --filter @sentinel/site build
```

`hasVideo: true` and the `.jpg` poster ref are already set for all 15 in
`features.ts` / `pillars.ts`; only flip them when adding a brand-new clip.

## Verifying a clip before shipping

Don't trust that it ran — look at it. Sample frames from the **app portion**
(after the intro bookend, ~10–16s into a 22–28s composite):

```sh
ffmpeg -y -ss 13 -i ../../site/public/videos/usage.mp4 -vframes 1 -q:v 3 /tmp/frame.jpg
```

Then Read the frame. Confirm: correct tab, real formatted data (not "No data"),
the 540×628 window on the desktop, the tray % top-right, and the scripted beat
(switch / event / climb / notification). Or drive the live app with Playwright
against `:47999/stage?app=http://localhost:5180` and assert on text.

## Adding a clip for a NEW tab

1. **Fixtures**: make sure `mock-bridge.mjs` answers _every_ IPC message that tab's
   view calls (see the gotcha below — this is the usual cause of "No data"). Use
   `discover.mjs` / `disc2.mjs` to screenshot the tab and find `data-tour-id`s and
   on-screen text.
2. **Recipe**: add a `<slug>: { run: async (c) => { … } }` entry to `recipes.mjs`
   using the `ctx` helpers: `openTab`, `openSubTab`, `openSettings`, `tap`,
   `tapSel`, `moveCursorTo`, `waitText`, `focalOf`, `scrollApp`, `sleep`, `post`,
   and set `c.zoom = { startMs, endMs, cx, cy, zmax }` for a push-in.
3. **Broadcast a beat** (interaction clips): `await c.post('__demo_route', {…})`
   etc., or `c.page.evaluate(() => window.__demo.notify({…}))` for a macOS banner.
4. **Bookends**: add the slug's copy to the `SCENES` table in
   `video-bookends/intro-scene.html` and `CARDS` in `card.html`, then
   `node video-bookends/capture.mjs clips <slug>`.
5. **Wire the site**: add the entry to `features.ts` or `pillars.ts` with
   `hasVideo: true` and `.jpg` poster.

## Gotchas (each one cost a debugging session)

- **Never `pkill`/`kill` the daemon.** The Tauri app spawns it once and never
  restarts it. Only ever kill the **mock bridge**, and only by its port:
  `lsof -ti :47999 | xargs kill`. Confirm it's `node mock-bridge.mjs` first.
  `pkill -f mock-bridge.mjs` misses it when it was started by relative path.
- **Every IPC message a view sends needs a fixture.** A view that calls an
  unhandled message gets `null` and renders its empty state ("No data yet"). The
  Usage tab fetches `get_rate_limits` (singular, per-account), _not just_
  `get_all_rate_limits` — both must be handled. When a clip shows "No data",
  grep the view component for `sendToSentinel`/message `type`s and add the
  missing case.
- **Reset/pause timestamps are UNIX _seconds_, not ms.** `AccountCard` expects
  `epochSec`; sending `Date.now()` (ms) renders garbage like "resumes in
  206102930 14h". Use `SEC() + Math.round(hours * HOUR)`.
- **CSS transforms aren't captured** by Playwright `recordVideo`. Do the
  push-in in post via the recipe's `c.zoom` (ffmpeg `zoompan`), not CSS.
- **The carousel must be `client:load`** (`src/pages/index.astro`). `client:visible`
  loses the first click to a hydration race.
- **`format:check` is `prettier --check .` repo-wide** and `.prettierignore` does
  NOT exclude `demo-recordings/` or `video-bookends/`. New `.mjs`/`.html`/`.css`
  there must be Prettier-clean or CI's format check fails.
- **zsh doesn't word-split** `for s in $SLUGS`. Use a literal list or run loops
  under `bash`.
- **Rendered `*.mp4`/`*.webm` are git-ignored** in both dirs (build artifacts).
  The committed clips live only in `packages/site/public/videos/`.
