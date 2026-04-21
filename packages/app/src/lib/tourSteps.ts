export interface TourStep {
  /** `data-tour-id` attribute on the target element, or `null` for a
   *  centered welcome/finale card. */
  targetId: string | null;
  title: string;
  body: string;
  /** Optional tab to switch to before this step renders. The harness only
   *  runs this once per step-enter to avoid bouncing tabs while the user
   *  navigates. */
  tab?: 'accounts' | 'usage' | 'metrics' | 'overage' | 'notifications' | 'security' | 'logs';
  /** Preferred placement for the coach mark relative to the target. `auto`
   *  flips to the side with more space. Ignored when `targetId` is null. */
  placement: 'auto' | 'top' | 'bottom';
}

export const TOUR_STEPS: TourStep[] = [
  {
    targetId: null,
    title: 'Welcome to Sentinel',
    body: 'A 30-second tour of the highlights: round-robin account pooling, live usage, security scanning, and threshold alerts.',
    placement: 'auto',
  },
  {
    targetId: 'add-account',
    tab: 'accounts',
    title: 'Add every account you own',
    body: 'Sentinel pools Claude Pro, Max, Team, and Enterprise accounts. Add them here and they all show up on the Accounts tab with live 5-hour utilization.',
    placement: 'auto',
  },
  {
    targetId: 'switching-mode',
    tab: 'accounts',
    title: 'Combine them with round-robin',
    body: 'Flip on round-robin and Sentinel rotates the OAuth token on every request across your pool. Two strategies: Balance drains every account evenly so they all hit their 5-hour reset together; Earliest reset hard-targets the account whose window resets soonest so fresh quota is used first. Flip round-robin off for classic one-at-a-time switching.',
    placement: 'auto',
  },
  {
    targetId: 'tab-security',
    title: 'Security is built in',
    body: 'Sentinel scans outbound requests and model responses for secrets, prompt injection, and risky tool calls; it also lets you gate Claude Code tools with allow/deny rules you control.',
    placement: 'bottom',
  },
  {
    targetId: 'tab-notifications',
    title: 'Alerts before you hit the wall',
    body: 'Set a threshold on your 5-hour window (per-account or pool-wide) and get a native OS notification the moment you cross it.',
    placement: 'bottom',
  },
  {
    targetId: 'tour-replay',
    title: 'Replay any time',
    body: 'Click this icon in the header to replay the tour whenever you want. You can dive into Settings then Security to fine-tune what Sentinel protects you from.',
    placement: 'bottom',
  },
];
