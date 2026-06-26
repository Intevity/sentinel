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
    tagline: 'Scanning, permission rules, and an OS-level sandbox, all in flight.',
    description:
      'Sentinel scans every prompt and response as it passes through the local proxy. Secrets, PII, prompt-injection payloads, and risky tool calls are flagged the instant they appear, and you choose whether to just watch or block. Add per-tool permission rules that sync into Claude Code, and sandbox risky commands so they reach only the files and network domains you allow.',
    icon: 'shield',
    video: 'security.mp4',
    poster: 'security.svg',
    hasVideo: false,
  },
  {
    slug: 'optimize',
    label: 'Optimize',
    title: 'Spend fewer tokens on the same work',
    tagline: 'Curated subagents, reversible compression, and code execution.',
    description:
      'Sentinel cuts token cost three ways: route routine work to curated subagents pinned to a cheaper model, compress the bloated tool output that fills your context window (reversibly, so nothing is lost), and move MCP tool definitions out of context with code execution. The Optimize page shows realized and potential savings in both tokens and dollars.',
    icon: 'sparkles',
    video: 'optimize.mp4',
    poster: 'optimize.svg',
    hasVideo: false,
  },
  {
    slug: 'accounts',
    label: 'Multi-account',
    title: 'Every Claude account you own, in one place',
    tagline: 'Switch the active account without copying credentials around.',
    description:
      'Add the accounts you own and let Sentinel switch the active one for you. Auto mode favors the account whose limit resets soonest, so you are not switching by hand, and every switch is one click that rewrites the active credential safely.',
    icon: 'rotate',
    video: 'accounts.mp4',
    poster: 'accounts.svg',
    hasVideo: false,
  },
  {
    slug: 'usage',
    label: 'Usage and caps',
    title: 'All your accounts in one usage view, with overage caught early',
    tagline: 'Pooled and per-account limits, plus the overage Claude Code never shows.',
    description:
      'Watch every rate limit in real time, pooled and per account, with live reset countdowns in a single view instead of one account at a time. Claude Code never tells you when you cross into paid overage or how much overage budget is left, and on Team and Enterprise plans it hides your personal budget. Sentinel surfaces both, and a spend cap stops runaway billing before it gets away from you.',
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
    tagline: 'Cost and token metrics straight from an OTEL receiver.',
    description:
      'Sentinel collects OpenTelemetry metrics straight from Claude Code and breaks down cost, token counts, and cache hit rate over time. The stats cache built into Claude Code reports $0 for subscription users, so these are the real numbers your sessions produced.',
    icon: 'chart',
    video: 'metrics.mp4',
    poster: 'metrics.svg',
    hasVideo: false,
  },
];
