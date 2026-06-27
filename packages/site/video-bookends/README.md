# Video bookends

Branded HTML/CSS animations that bookend your Sentinel screen recordings. Everything renders
to a fixed **1920×1080** stage and is on-brand with the marketing site (tokens ported from
`../src/styles/global.css`). Two kinds:

## 1. Per-clip intros + outros (the main set)

One tailored pair for each of the 15 site clips, designed to wrap the screen recording you make
for that feature.

- **Cold-open intro** (`intro-scene.html?slug=<slug>` → `<slug>-intro.mp4`): a feature-specific
  Claude-terminal scene that sets up the problem (a secret leaking, the token counter ballooning,
  a rate-limit hit, `$0.00` cost, etc.) and ends parked on a big **"→ Tab"** handoff frame, so you
  cut straight into your capture of that view. Scenes live in the `SCENES` table in
  `intro-scene.html`; accent shifts per family (blue = Multi-account, indigo = Security,
  green = Optimization, orange = Alerts).
- **Takeaway outro** (`card.html?slug=<slug>` → `<slug>-outro.mp4`): feature icon + a one-line
  takeaway + the Sentinel lockup and site URL. Copy/icons live in the `CARDS` table in `card.html`.

The 15 slugs: `security optimize accounts usage alerts metrics switching pool caps scanning rules
sandbox subagents compression codemode`.

## 2. Full promo (optional, separate)

- **`intro.html` / `outro.html`** → `intro.mp4` / `outro.mp4`: a longer fake-terminal promo intro
  (types `claude`, surfaces a secret, Sentinel wipes in) and a logo/tagline/URL outro, for a
  standalone montage (README hero, social, launch).

Shared styling: `bookend.css` (tokens, ambient bg, terminal chrome, keyframes), `scenes.css`
(intro meter/chip/handoff), `cards.css` (outro card).

## Producing the clips

### Automated (frame-exact, reproducible)

```sh
# one-time, if Chromium for Playwright isn't installed yet
pnpm --filter @sentinel/app exec playwright install chromium

node capture.mjs                       # all 15 intros + all 15 outros
node capture.mjs clips compression     # one clip's intro + outro
node capture.mjs intros                # all 15 cold-open intros only
node capture.mjs outros scanning rules # specific outros
node capture.mjs promo                 # the standalone terminal promo (intro.mp4 + outro.mp4)
```

Drives the Chromium from `@playwright/test` (a devDependency of `@sentinel/app`) at 1920×1080 and
transcodes WebM → H.264 MP4 with `ffmpeg`. If `ffmpeg` lacks `libx264`, the `.webm` is kept and its
path printed so you can transcode elsewhere.

### Or record in a browser (Screen Studio)

Open any page fullscreen at 1920×1080 and record it; reload to replay. Examples:
`intro-scene.html?slug=compression`, `card.html?slug=compression`.

## Assembling a clip in Screen Studio

`<slug>-intro.mp4` → your Screen Studio capture of that tab → `<slug>-outro.mp4`. The intro parks on
its "→ Tab" frame, so cut straight into the recording (or add a Screen Studio wipe/zoom at the
seam) — for `compression`, the intro ends on the ballooning token counter and your capture opens on
the Compression view with the savings climbing.

## Editing

- Intro scripts (terminal lines, meters, chip, handoff label, accent): the `SCENES` table in
  `intro-scene.html`. Per-type beat durations are in the `DUR` map; the page publishes its total as
  `window.SENTINEL_BOOKEND.durationMs` and sets `window.__animDone` when finished (capture waits on
  these).
- Outro copy/icon/accent: the `CARDS` table in `card.html`.
- Copy here is hand-maintained to mirror `../src/data/features.ts` and `../src/data/pillars.ts`
  (no build-time import). If you change a feature's wording on the site, update the matching entry
  here too.

Rendered `*.mp4` / `*.webm` are git-ignored — regenerate with `node capture.mjs`.
