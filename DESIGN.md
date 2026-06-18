# Sentinel — Design System & Website Design Guide

This document captures the visual language of the **Sentinel** desktop app and
translates it into a design system for the marketing website (`packages/site`). The app is
the source of truth; the site should feel like a natural extension of it. Where the site
needs more "landing-page energy" than a utility tray window, we borrow conventions from
[trpc.io](https://trpc.io)'s homepage: a dark gradient hero, oversized type, and a clean
feature grid.

All values below are taken verbatim from the app:

- `packages/app/tailwind.config.js`
- `packages/app/src/index.css`

---

## 1. Brand identity

**Name:** Sentinel
**One-liner:** Combine every Claude account you own into one. Rotate tokens automatically,
see every rate limit Claude Code hides, cap overage spend before it runs away, and get
notified the moment you cross a threshold.

**What it is:** an open-source Claude Code companion (tray app + bundled local daemon) for
in-flight security scanning, multi-account routing, real-time overage alerts, honest usage
metrics, and threshold-based notifications.

**Personality:** calm, precise, trustworthy, developer-native. It is a guardian utility, not
a flashy consumer app. The aesthetic is Apple/iOS-inspired: clean surfaces, generous
rounding, one confident accent color, and restraint everywhere else. Motion is subtle and
purposeful (a shield pulse, a focus glow), never decorative.

**Privacy is part of the brand.** "Your data never leaves your machine" is a first-class
message: localhost-only networking, OS-keychain credentials, no telemetry.

---

## 2. Color system

### iOS accent palette (Tailwind `ios.*` tokens)

| Token        | Hex       | Role                                                     |
| ------------ | --------- | -------------------------------------------------------- |
| `ios-blue`   | `#007AFF` | Primary action / accent. CTAs, links, focus rings, glow. |
| `ios-green`  | `#32D74B` | Success, active, healthy state.                          |
| `ios-orange` | `#FF9F0A` | Warning, attention.                                      |
| `ios-red`    | `#FF453A` | Error, blocking, danger.                                 |
| `ios-purple` | `#BF5AF2` | Secondary accent (e.g. Opus model).                      |
| `ios-indigo` | `#5E5CE6` | Tertiary accent (e.g. output tokens, Sonnet).            |
| `ios-gray`   | `#8E8E93` | Muted/secondary text, section labels.                    |

**Rule of one accent:** iOS blue drives everything interactive. Green/orange/red are
reserved for _semantic_ meaning (state, severity, outcome) — never for decoration.

### Surfaces

| Context           | Value     |
| ----------------- | --------- |
| Light page bg     | `#f2f2f7` |
| Dark page bg      | `#111111` |
| Dark card surface | `#1E1E1E` |
| Light card        | `#ffffff` |

### Semantic theme tokens (CSS variables)

Defined as **space-separated RGB triplets** so Tailwind's `<alpha-value>` substitution works
(e.g. `text-foreground/60`). Light defaults in `:root`; `:root.dark` overrides.

| Variable            | Light       | Dark          | Meaning                                                  |
| ------------------- | ----------- | ------------- | -------------------------------------------------------- |
| `--foreground`      | `0 0 0`     | `255 255 255` | Primary text / contrasting-to-surface color.             |
| `--muted`           | `99 99 102` | `142 142 147` | Secondary text (Apple secondary-label; WCAG AA on both). |
| `--border-subtle`   | `0 0 0`     | `255 255 255` | Hairline borders (used at low opacity).                  |
| `--surface-overlay` | `0 0 0`     | `255 255 255` | Overlay scrims (used at low opacity).                    |

Tailwind exposes these as `foreground`, `muted`, `border-subtle`, `surface-overlay`.

**Website default:** dark mode (matches trpc.io's hero and reads as "developer tool"). Offer
a light variant only if cheap; the app itself ships both and persists the choice.

---

## 3. Typography

- **Family:** `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif`
  (system font stack; no web-font download, instant render, native feel).
- **Base size:** `14px`, `-webkit-font-smoothing: antialiased`.
- **Section label:** `11px`, `font-semibold`, `uppercase`, `tracking-widest`, color
  `ios-gray` (the Apple "grouped section header" style — `.section-label`).
- **Extra scale:** `2xs` = `10px` / `14px` line-height.

**Website type scale** (extends the app, since landing pages need big display type): keep the
system stack; introduce a display size (~clamp 40-72px) for the hero headline, ~20-24px for
section intros, 14-16px body. Tight tracking on large headings, normal on body.

---

## 4. Spacing, radius, shadow, blur

**Border radius**

| Token          | Value  | Use                               |
| -------------- | ------ | --------------------------------- |
| `rounded-2xl`  | `16px` | Cards (`.glass-card`).            |
| `rounded-3xl`  | `22px` | Larger panels / hero media frame. |
| `rounded-full` | pill   | Buttons, chips, badges.           |

**Shadows**

| Token         | Value                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| `card`        | `0 1px 4px rgba(0,0,0,0.07), 0 0 0 0.5px rgba(0,0,0,0.05)`                              |
| `card-md`     | `0 4px 20px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.05)`                             |
| `sticky`      | `0 8px 24px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.06)` |
| `sticky-dark` | `0 10px 28px rgba(0,0,0,0.70), 0 2px 8px rgba(0,0,0,0.50)`                              |

Soft black shadows nearly vanish on the `#111` dark background — use the heavier `*-dark`
variants for floating elements in dark mode.

**Blur:** `backdrop-blur-xs` = `4px` (glass effects).

**Scrollbar:** thin (`5px`), transparent track, thumb `rgba(0,0,0,0.12)` light /
`rgba(255,255,255,0.12)` dark, fully rounded.

---

## 5. Component patterns

Ported from `index.css` `@layer components`:

- **`.glass-card`** — `bg-white dark:bg-[#1E1E1E] rounded-2xl shadow-card`. The default
  surface for content blocks; on the site, feature cards and the video frame use this.
- **`.btn-primary`** — iOS-blue pill: `rounded-full bg-ios-blue text-white text-[12px]
font-semibold px-3.5 py-1.5`, `active:scale-95`, `hover:opacity-90`, disabled at 40%
  opacity. Site CTAs scale this up (larger padding/size) but keep the pill + blue + scale.
- **`.btn-ghost`** — `rounded-full text-ios-blue`, `hover:bg-ios-blue/10`, `active:scale-95`.
  Secondary actions ("View on GitHub").
- **`.section-label`** — see Typography.

**Card anatomy:** rounded-2xl surface, hairline 0.5px border (use `border-subtle` at low
opacity), soft shadow, comfortable padding. Status conveyed with the semantic palette
(green/orange/red) as small chips/pills, never large fills.

---

## 6. Motion

Defined in `index.css` (and `packages/app/src/lib/motion.ts`):

- **`sentinel-flash`** — a quick double-pulse of `ios-blue` background (deep-link attention).
- **`security-row-flash`** — a blue glow ring that fades to transparent (notification focus).
- **`sentinel-shield-pulse`** — the shield mascot opacity pulses `0.5 → 1 → 0.5` over `2.2s`.

**Always honor `prefers-reduced-motion: reduce`** — the app disables the shield pulse under
it; the site must do the same for the carousel autoplay and any glow/pulse.

**Website motion budget:** restrained. A gentle hero gradient, blue glow on primary CTA
hover, smooth carousel cross-fades. No parallax circus.

---

## 7. Iconography & assets

- **Icons:** [`lucide-react`](https://lucide.dev) (the app uses `lucide-react`). The site
  uses lucide (via `lucide-react` islands or inline SVG) for feature icons — e.g. Shield
  (security), Users/Repeat (multi-account/rotation), Gauge (usage), Bell (alerts),
  BarChart (metrics), Sparkles/Minimize (optimize), Lock (privacy).
- **Mascot:** `packages/app/src/assets/sentinelMascot.png` — the shield/sentinel character;
  reuse in the hero.
- **Org logo:** `packages/app/src/assets/intevityLogoIcon.png` — footer attribution.
- **App icons:** `packages/app/src-tauri/icons/` (the full DPI ladder + `icon.ico`).

---

## 8. Translating the app → the website

| App convention                       | Website application                                                        |
| ------------------------------------ | -------------------------------------------------------------------------- |
| iOS blue single accent               | All CTAs, links, focus, carousel active state.                             |
| Dark `#111` surface, `#1E1E1E` cards | Default dark theme; glass feature cards.                                   |
| `rounded-2xl`/`3xl`, pill buttons    | Cards and the hero media frame rounded; CTAs are pills.                    |
| System font stack                    | Same stack; add a large display scale for the hero.                        |
| Subtle, purposeful motion            | Gradient hero, hover glow, carousel cross-fade; reduced-motion aware.      |
| Semantic green/orange/red            | Severity/status accents only (e.g. a "HIGH blocked" chip in a demo card).  |
| "Data never leaves your machine"     | A dedicated privacy strip with localhost / keychain / no-telemetry badges. |

**trpc.io references we borrow** (look-and-feel only, not literal copy): a dark, gradient
hero with a big headline and two pill CTAs; a tidy feature grid below the fold; restrained,
confident, developer-first tone.

The site's Tailwind config **mirrors these tokens** (the `ios.*` palette, the font stack, the
radius/shadow scale) so a component dropped from the app reads identically on the web.
