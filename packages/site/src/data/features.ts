// Single source of truth for the feature list, shared by the React carousel
// island (FeatureCarousel.tsx) and the static FeatureGrid.astro. Copy is written
// fresh from the current app behaviour (the README was out of date). Keep it free
// of em dashes per the project's UI-copy rule.

export type IconName = 'shield' | 'rotate' | 'gauge' | 'bell' | 'chart' | 'sparkles';

export interface Feature {
  slug: string;
  /** Short tab label used in the carousel rail. */
  label: string;
  /** Card / panel heading. */
  title: string;
  /** One-line hook. */
  tagline: string;
  /** Two to three sentences for the carousel panel and the grid card. */
  description: string;
  icon: IconName;
  /** File in public/videos/. Set hasVideo true once recorded. */
  video: string;
  poster: string;
  /** Flip to true after dropping the real recording into public/videos/. */
  hasVideo: boolean;
}

export const features: Feature[] = [
  {
    slug: 'security',
    label: 'Security',
    title: 'Catch secrets and risky tool calls before they leave your machine',
    tagline: 'In-flight scanning for secrets, PII, prompt injection, and dangerous commands.',
    description:
      'Sentinel scans every prompt and response as it passes through the local proxy. Secrets, tokens, PII, prompt-injection payloads, and risky tool calls are flagged the instant they appear. Choose to observe, block HIGH severity, or block MEDIUM and HIGH, and add per-tool permission rules that sync into Claude Code.',
    icon: 'shield',
    video: 'security.mp4',
    poster: 'security.svg',
    hasVideo: false,
  },
  {
    slug: 'accounts',
    label: 'Multi-account',
    title: 'Combine every Claude account you own into one',
    tagline: 'Automatic token rotation across all your subscriptions.',
    description:
      'Add every Claude account and let Sentinel switch between them automatically. Auto mode routes each request to the account whose limit resets soonest, using up quota that is about to refresh. Switching is one click and rewrites the active credential safely.',
    icon: 'rotate',
    video: 'accounts.mp4',
    poster: 'accounts.svg',
    hasVideo: false,
  },
  {
    slug: 'usage',
    label: 'Usage and caps',
    title: 'See every limit Claude Code hides, and cap overage spend',
    tagline: 'Pool-wide and per-account usage with reset countdowns.',
    description:
      'Watch every rate limit in real time, pool-wide and per account, with live reset countdowns. When an account tips into paid overage, Sentinel knows the moment the response header flips, and a spend cap stops runaway billing before it gets away from you.',
    icon: 'gauge',
    video: 'usage.mp4',
    poster: 'usage.svg',
    hasVideo: false,
  },
  {
    slug: 'alerts',
    label: 'Alerts',
    title: 'Know the moment you cross a threshold',
    tagline: 'Threshold notifications, per account and pool-wide.',
    description:
      'Set usage thresholds per account or across the whole pool and get a native OS notification the instant you cross one. Every alert is recorded in a history you can review, so a limit never surprises you mid-session.',
    icon: 'bell',
    video: 'alerts.mp4',
    poster: 'alerts.svg',
    hasVideo: false,
  },
  {
    slug: 'metrics',
    label: 'Metrics',
    title: 'Real cost. Real tokens. Real cache hit rate.',
    tagline: 'Honest usage metrics from an OTEL receiver.',
    description:
      'Sentinel collects OpenTelemetry metrics from Claude Code and turns them into an honest breakdown of cost, token counts, and cache hit rate over time. No estimates and no guesswork, just the numbers your sessions actually produced.',
    icon: 'chart',
    video: 'metrics.mp4',
    poster: 'metrics.svg',
    hasVideo: false,
  },
  {
    slug: 'optimize',
    label: 'Optimize',
    title: 'Fewer tokens on the output that bloats your context',
    tagline: 'Reversible compression of oversized tool results.',
    description:
      'The proxy can compress the heavy tool-call output that quietly fills your context window, trimming a large share of the tokens on the payloads that bloat the most. Reversible mode keeps a retrievable copy so nothing is lost, and the Optimize page shows exactly what was saved.',
    icon: 'sparkles',
    video: 'optimize.mp4',
    poster: 'optimize.svg',
    hasVideo: false,
  },
];
