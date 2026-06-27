// Deep-dive sections for the three features that sell Sentinel: multi-account
// switching, security, and optimization. The flat carousel (features.ts) is the
// "see it in action" overview; this is the marketing narrative that breaks each
// pillar into the sub-features users actually came for. Copy is written from
// current app behaviour and kept free of em dashes per the project's UI-copy rule.
//
// Each sub-feature carries a poster + video slot (hasVideo false until the real
// recording lands in public/videos/), mirroring the Feature shape so the
// "demo coming soon" placeholder renders the same way as the carousel.

export interface SubFeature {
  /** Icon name resolved by Icon.astro (must exist in its path map). */
  icon: string;
  title: string;
  /** One short phrase under the title. */
  hook: string;
  description: string;
  /** File in public/videos/. Flip hasVideo true once recorded. */
  video: string;
  poster: string;
  hasVideo: boolean;
}

export interface Pillar {
  slug: string;
  /** Short kicker above the pillar title. */
  eyebrow: string;
  title: string;
  intro: string;
  subFeatures: SubFeature[];
}

export const pillars: Pillar[] = [
  {
    slug: 'multi-account',
    eyebrow: 'Multi-account',
    title: 'Every Claude account you own, in one place',
    intro:
      'Keep the accounts you own in one place and let Sentinel switch the active one for you, so you are not copying credentials between machines or losing track of which account is in use.',
    subFeatures: [
      {
        icon: 'rotate',
        title: 'Auto switching',
        hook: 'Switch the active account, hands-free',
        description:
          'Turn on Auto and Sentinel moves the active account for you, favoring the one whose 5-hour window resets soonest so you are not switching by hand. The header always shows which account is in use, and each switch rewrites the active credential safely.',
        video: 'switching.mp4',
        poster: 'switching.jpg',
        hasVideo: true,
      },
      {
        icon: 'users',
        title: 'Every plan, one view',
        hook: 'Pro, Max, Team, and Enterprise side by side',
        description:
          'Add the accounts you own and each gets a live card with utilization, plan type, and a reset countdown. One view shows them all side by side instead of a separate login per tab.',
        video: 'pool.mp4',
        poster: 'pool.jpg',
        hasVideo: true,
      },
      {
        icon: 'wallet',
        title: 'Spend caps',
        hook: 'Bound overage before it runs away',
        description:
          'Set a rolling 7-day USD cap per account or across the whole pool. A capped account pauses from rotation until its spend ages out, so paid overage stays bounded without you watching the meter.',
        video: 'caps.mp4',
        poster: 'caps.jpg',
        hasVideo: true,
      },
    ],
  },
  {
    slug: 'security',
    eyebrow: 'Security',
    title: 'See, gate, and contain every request',
    intro:
      'Sentinel sits in the request path, so it can inspect what leaves your machine, enforce which tools are allowed to run, and box in the ones that do.',
    subFeatures: [
      {
        icon: 'scan',
        title: 'Scanning',
        hook: 'Secrets, PII, and injection, in flight',
        description:
          'Every prompt and response is scanned as it passes through the local proxy. Secrets, PII, prompt-injection payloads, and risky tool calls are flagged the instant they appear, and you decide whether to just watch or block by severity.',
        video: 'scanning.mp4',
        poster: 'scanning.jpg',
        hasVideo: true,
      },
      {
        icon: 'list-checks',
        title: 'Permission rules',
        hook: 'Allow, deny, or ask per tool',
        description:
          'Write per-tool rules by name and arguments. Allow and deny rules sync straight into Claude Code so it enforces them silently, while ask rules hold the request for your approval right in the tray.',
        video: 'rules.mp4',
        poster: 'rules.jpg',
        hasVideo: true,
      },
      {
        icon: 'lock',
        title: 'Sandbox',
        hook: 'OS-level file and network limits',
        description:
          'Run the commands Claude Code and code-mode MCP servers issue inside an OS sandbox that limits the files and domains they can reach. Off by default; macOS and Linux get full filesystem and network isolation, Windows is network-only.',
        video: 'sandbox.mp4',
        poster: 'sandbox.jpg',
        hasVideo: true,
      },
    ],
  },
  {
    slug: 'optimization',
    eyebrow: 'Optimization',
    title: 'Spend fewer tokens on the same work',
    intro:
      'The proxy can see the tokens your sessions waste, and it gives you three levers to cut them. Each one shows the savings it actually banked, in tokens and dollars.',
    subFeatures: [
      {
        icon: 'bot',
        title: 'Curated subagents',
        hook: 'Route routine work to a cheaper model',
        description:
          'A library of pre-built subagents, most pinned to a cheaper model, that Sentinel recommends based on how you actually work. Routine jobs like file reads and log parsing run cheap and hand back a digest instead of raw output.',
        video: 'subagents.mp4',
        poster: 'subagents.jpg',
        hasVideo: true,
      },
      {
        icon: 'fold',
        title: 'Compression',
        hook: 'Trim bloated tool output, reversibly',
        description:
          'Oversized tool results are the quiet context hog. Sentinel trims them in flight at the aggressiveness you choose, and reversible mode keeps the original a tool call away so nothing is ever lost.',
        video: 'compression.mp4',
        poster: 'compression.jpg',
        hasVideo: true,
      },
      {
        icon: 'braces',
        title: 'Code execution',
        hook: 'Move MCP definitions out of context',
        description:
          'Bridge your MCP servers through a local loopback endpoint so their tool definitions stop riding along in every request. Claude calls a small skill instead, and the definitions leave your context for good. Loopback-only, with a per-server allowlist.',
        video: 'codemode.mp4',
        poster: 'codemode.jpg',
        hasVideo: true,
      },
    ],
  },
];
