import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Sparkles,
  Users,
  Shuffle,
  ShieldCheck,
  BellRing,
  Wallet,
  BarChart3,
  HelpCircle,
  Lock,
} from 'lucide-react';
import {
  WelcomeIllustration,
  AccountsIllustration,
  AutoSwitchIllustration,
  SecurityIllustration,
  AlertsIllustration,
  BudgetIllustration,
  MetricsIllustration,
  OptimizeIllustration,
  ReplayIllustration,
} from './tourIllustrations/index.js';

/** Accent palette resolved by the Tour component into hex values for the
 *  hero gradient and the icon badge tint. Tailwind's content-only theme
 *  doesn't ship the full palette, so we keep colors localized here. */
export type TourAccent =
  | 'indigo'
  | 'blue'
  | 'teal'
  | 'red'
  | 'orange'
  | 'violet'
  | 'green'
  | 'emerald'
  | 'sky'
  | 'gray';

/** A "core" step is shown to every user; "power" steps are shown only when
 *  the user explicitly opts in (via the See more CTA on the last core step
 *  on first run, or by clicking the help icon to replay the full tour). */
export type TourTrack = 'core' | 'power';

export interface TourStep {
  /** `data-tour-id` attribute on the target element, or `null` for a
   *  centered welcome/finale card. */
  targetId: string | null;
  title: string;
  body: string;
  /** Optional tab to switch to before this step renders. The harness only
   *  runs this once per step-enter to avoid bouncing tabs while the user
   *  navigates. */
  tab?: 'accounts' | 'usage' | 'metrics' | 'optimize' | 'notifications' | 'security' | 'logs';
  /** Preferred placement for the coach mark relative to the target. `auto`
   *  flips to the side with more space. Ignored when `targetId` is null. */
  placement: 'auto' | 'top' | 'bottom';
  /** Lucide icon rendered in the small badge that overlaps the hero image. */
  icon: LucideIcon;
  /** Color theme for the hero gradient and icon badge. */
  accent: TourAccent;
  /** SVG illustration component rendered in the card's hero area. */
  illustration: ComponentType<{ className?: string }>;
  /** Which track this step belongs to: 'core' for the default first-run
   *  walkthrough, 'power' for the opt-in deep dive. */
  track: TourTrack;
}

export const TOUR_STEPS: TourStep[] = [
  {
    targetId: null,
    title: 'Welcome to Sentinel',
    body: 'Pool your Claude accounts, watch usage in real time, scan requests for risky content, and get pinged before you hit the wall.',
    placement: 'auto',
    icon: Sparkles,
    accent: 'indigo',
    illustration: WelcomeIllustration,
    track: 'core',
  },
  {
    targetId: 'add-account',
    tab: 'accounts',
    title: 'Add every account you own',
    body: 'Sentinel pools Claude Pro, Max, Team, and Enterprise accounts. Each one gets a card with live 5-hour utilization, plan type, and reset countdown.',
    placement: 'auto',
    icon: Users,
    accent: 'blue',
    illustration: AccountsIllustration,
    track: 'core',
  },
  {
    targetId: 'switching-mode',
    tab: 'accounts',
    title: 'Automatic account switching',
    body: 'Switch Account Switching to Auto and Sentinel routes each request to the enrolled account whose 5-hour limit resets soonest, using up quota that is about to refresh. The header always shows the account currently serving your requests.',
    placement: 'auto',
    icon: Shuffle,
    accent: 'teal',
    illustration: AutoSwitchIllustration,
    track: 'core',
  },
  {
    targetId: 'tab-optimize',
    title: 'Optimize: subagents, compression, context',
    body: 'Sentinel cuts token costs three ways: routing routine work to cheaper-model subagents, compressing tool output in flight, and moving MCP tool definitions out of context. Each shows realized and potential savings, in tokens or dollars.',
    tab: 'optimize',
    placement: 'bottom',
    icon: Sparkles,
    accent: 'emerald',
    illustration: OptimizeIllustration,
    track: 'core',
  },
  {
    targetId: 'tab-security',
    title: 'Security and permission rules',
    body: 'Sentinel inspects outbound requests and responses for secrets, prompt injection, and risky tool calls: observe only, or block on high or medium severity. Mute findings you want to ignore; give a recurring block an Always allow. You can also allow or deny specific Claude Code tools by name and arguments, synced both ways with settings.json. Every block holds the request up to 60 seconds and appears as a pinned row here with Approve (once, for session, or always) and Deny.',
    placement: 'bottom',
    icon: ShieldCheck,
    accent: 'red',
    illustration: SecurityIllustration,
    track: 'core',
  },
  {
    targetId: 'tour-isolation',
    tab: 'security',
    title: 'Sandbox risky commands',
    body: 'Optional OS-level isolation: run commands from Claude Code and Sentinel code-mode MCP servers inside a sandbox that limits which files and network domains they can reach. Off by default - enable it here with one toggle, then fine-tune domains and paths. macOS and Linux get full filesystem and network isolation; Windows is network-only.',
    placement: 'bottom',
    icon: Lock,
    accent: 'violet',
    illustration: SecurityIllustration,
    track: 'core',
  },
  {
    targetId: 'tab-notifications',
    title: 'Alerts before you hit the wall',
    body: 'Set thresholds on the 5-hour or weekly window: per-account or pool-wide. Sentinel fires a native OS notification the moment you cross.',
    placement: 'bottom',
    icon: BellRing,
    accent: 'orange',
    illustration: AlertsIllustration,
    track: 'core',
  },
  {
    targetId: null,
    title: 'Weekly budget caps',
    body: 'Set a rolling 7-day USD cap per account or globally across the pool. Crossed caps auto-pause the account from rotation; spend ages out and the cap clears itself. Configure in Settings: Accounts.',
    placement: 'auto',
    icon: Wallet,
    accent: 'green',
    illustration: BudgetIllustration,
    track: 'power',
  },
  {
    targetId: 'tab-metrics',
    title: 'Metrics from Claude Code',
    body: 'Sentinel auto-receives OpenTelemetry from Claude Code: tokens, cost, cache hit rate and TTL, tool accept rates, and API errors over 7, 14, or 30 day windows.',
    placement: 'bottom',
    icon: BarChart3,
    accent: 'sky',
    illustration: MetricsIllustration,
    track: 'power',
  },
  {
    targetId: 'tour-replay',
    title: 'Replay any time',
    body: 'Click this icon in the header to replay the tour. Open Settings to fine-tune scan severity, retention windows, the overage buffer, and more.',
    placement: 'bottom',
    icon: HelpCircle,
    accent: 'gray',
    illustration: ReplayIllustration,
    track: 'power',
  },
];

/** Number of steps in the core (always-shown) track. The first `CORE_STEP_COUNT`
 *  entries of `TOUR_STEPS` are the core track; the remainder are the power-user
 *  deep dive shown only on opt-in. */
export const CORE_STEP_COUNT = TOUR_STEPS.filter((s) => s.track === 'core').length;
