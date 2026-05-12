import type {
  PermissionRuleInput,
  Settings,
  SecurityEnforcementMode,
  SecurityOsNotifyThreshold,
  PermissionDecision,
} from '@claude-sentinel/shared';
import { sendToSentinel } from './ipc.js';

export type RiskProfile = 'low' | 'medium' | 'high' | 'paranoid';

/** The subset of `Settings` keys this preset writes. Everything else on the
 *  live settings object is left untouched. Mutually exclusive with the rule
 *  set — rules go through `upsert_permission_rule`. */
export type PresetSettingsPatch = Pick<
  Settings,
  | 'securityScanEnabled'
  | 'securityEnforcementMode'
  | 'securityScanSecrets'
  | 'securityScanInjection'
  | 'securityScanToolUse'
  | 'securityOsNotifyThreshold'
  | 'securityApproveHoldSec'
  | 'toolPermissionsEnabled'
  | 'toolPermissionDefaultAction'
  | 'toolPermissionSkipInAutoMode'
  | 'denyPrivateNetworkByDefault'
>;

export interface Preset {
  profile: RiskProfile;
  label: string;
  description: string;
  highlights: string[];
  settings: PresetSettingsPatch;
  /** Rules authored in canonical `Tool` / `Tool(pattern)` form plus a
   *  decision. `raw` is the serialized form — the daemon re-parses it
   *  during upsert so we pass tool + pattern + raw together. */
  rules: PresetRule[];
}

export interface PresetRule {
  decision: PermissionDecision;
  tool: string;
  pattern: string | null;
  note: string;
}

/** Build a `raw` string matching the parser at
 *  `packages/daemon/src/security/permissions/parser.ts`. */
function toRaw(tool: string, pattern: string | null): string {
  return pattern ? `${tool}(${pattern})` : tool;
}

// ─── Ask rules shared by Medium and High ──────────────────────────────────
// Broad Bash wildcards where a flat deny is too blunt: the model may have a
// legitimate reason (e.g. rm -rf /tmp/build-output). Surfaced through
// Sentinel's approval UI instead. ask rules are Sentinel-only: they never
// appear in ~/.claude/settings.json after the sync engine's push.
const SHARED_ASK_RULES: PresetRule[] = [
  { decision: 'ask', tool: 'Bash', pattern: 'rm -rf *', note: 'Irreversible recursive delete.' },
  { decision: 'ask', tool: 'Bash', pattern: 'sudo *', note: 'Privilege escalation.' },
  {
    decision: 'ask',
    tool: 'Bash',
    pattern: 'chmod 777 *',
    note: 'World-writable perms are rarely intentional.',
  },
  { decision: 'ask', tool: 'Bash', pattern: 'curl * | bash', note: 'Remote script execution.' },
  { decision: 'ask', tool: 'Bash', pattern: 'curl * | sh', note: 'Remote script execution.' },
  { decision: 'ask', tool: 'Bash', pattern: 'wget * | bash', note: 'Remote script execution.' },
  { decision: 'ask', tool: 'Bash', pattern: 'wget * | sh', note: 'Remote script execution.' },
];

// ─── Self-protection rules applied to ALL presets ────────────────────────
// Sprint 2: an agent that can write to ~/.claude/settings.json or anywhere
// under ~/.claude-sentinel/ can disable Sentinel. Treat config-path writes
// as a self-protection invariant, not a policy choice; deny in low/medium/
// high alike. The Bash detector `config-path-write` is the second layer
// for shell redirects that don't route through the Write/Edit/MultiEdit
// tools.
//
// Scope is intentionally narrow on the ~/.claude side: ~/.claude/plans/,
// ~/.claude/projects/, and ~/.claude/todos/ are workspace dirs that Claude
// Code writes to constantly during plan-mode and session bookkeeping. A
// blanket ~/.claude/** deny would break those flows. The high-value
// targets are settings.json (permission rules) and CLAUDE.md (user-level
// memory steering Claude's behavior). Credentials/oauth_token already
// have dedicated detector rules in detectors.ts.
const SHARED_CONFIG_PROTECTION_RULES: PresetRule[] = [
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '~/.claude/settings.json',
    note: 'Protect Claude Code permission rules.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '~/.claude/settings.json',
    note: 'Protect Claude Code permission rules.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.claude/settings.json',
    note: 'Protect Claude Code permission rules.',
  },
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '~/.claude/CLAUDE.md',
    note: 'Protect user-level memory.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '~/.claude/CLAUDE.md',
    note: 'Protect user-level memory.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.claude/CLAUDE.md',
    note: 'Protect user-level memory.',
  },
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '~/.claude-sentinel/**',
    note: 'Protect Sentinel state and settings.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '~/.claude-sentinel/**',
    note: 'Protect Sentinel state and settings.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.claude-sentinel/**',
    note: 'Protect Sentinel state and settings.',
  },
];

// ─── Deny rules shared by Medium and High ─────────────────────────────────
// Resource-specific protections that should never fire interactively: SSH
// keys, AWS credentials, and known exfiltration surfaces.
const SHARED_DENY_RULES: PresetRule[] = [
  { decision: 'deny', tool: 'Write', pattern: '~/.ssh/**', note: 'Protect SSH keys.' },
  { decision: 'deny', tool: 'Edit', pattern: '~/.ssh/**', note: 'Protect SSH keys.' },
  { decision: 'deny', tool: 'Read', pattern: '~/.ssh/id_*', note: 'Private SSH keys.' },
  { decision: 'deny', tool: 'Write', pattern: '~/.aws/credentials', note: 'AWS credentials file.' },
  { decision: 'deny', tool: 'Write', pattern: '~/.aws/config', note: 'AWS config file.' },
  { decision: 'deny', tool: 'Read', pattern: '~/.aws/credentials', note: 'AWS credentials file.' },
  {
    decision: 'deny',
    tool: 'WebFetch',
    pattern: 'domain:pastebin.com',
    note: 'Common exfil surface.',
  },
  {
    decision: 'deny',
    tool: 'WebFetch',
    pattern: 'domain:webhook.site',
    note: 'Common exfil surface.',
  },
  { decision: 'deny', tool: 'WebFetch', pattern: 'domain:ngrok.io', note: 'Common exfil surface.' },
];

// ─── Persistence-mechanism denies (Medium + High) ────────────────────────
// Sprint 4: HIGH-severity persistence vectors. An agent that can drop a
// LaunchAgent plist, a systemd unit, a git hook, or a sudoers include
// installs durable post-restart access. These paths have no legitimate
// reason to be written by an LLM-driven agent, so deny everywhere from
// Medium up. Bash redirects to /etc/cron* and ~/Library/Launch{Agents,
// Daemons}/ are caught separately by the cron-install / launch-daemon
// detectors in detectors.ts; these rules cover the Write/Edit/MultiEdit
// path. Editor-config persistence (vim, nvim, emacs, vscode) is stricter
// and lives in HIGH_EDITOR_CONFIG_DENY_RULES below: the FP rate is too
// high for Medium since users edit those files routinely.
const SHARED_PERSISTENCE_DENY_RULES: PresetRule[] = [
  // macOS LaunchAgents (user)
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '~/Library/LaunchAgents/**',
    note: 'macOS LaunchAgents persistence.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '~/Library/LaunchAgents/**',
    note: 'macOS LaunchAgents persistence.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/Library/LaunchAgents/**',
    note: 'macOS LaunchAgents persistence.',
  },
  // macOS LaunchDaemons (system)
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '/Library/LaunchDaemons/**',
    note: 'macOS LaunchDaemons persistence.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '/Library/LaunchDaemons/**',
    note: 'macOS LaunchDaemons persistence.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '/Library/LaunchDaemons/**',
    note: 'macOS LaunchDaemons persistence.',
  },
  // Linux systemd (system)
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '/etc/systemd/system/**',
    note: 'Linux systemd unit persistence.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '/etc/systemd/system/**',
    note: 'Linux systemd unit persistence.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '/etc/systemd/system/**',
    note: 'Linux systemd unit persistence.',
  },
  // Linux systemd (user)
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '~/.config/systemd/user/**',
    note: 'User systemd unit persistence.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '~/.config/systemd/user/**',
    note: 'User systemd unit persistence.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.config/systemd/user/**',
    note: 'User systemd unit persistence.',
  },
  // GnuPG agent
  { decision: 'deny', tool: 'Write', pattern: '~/.gnupg/**', note: 'GnuPG agent state.' },
  { decision: 'deny', tool: 'Edit', pattern: '~/.gnupg/**', note: 'GnuPG agent state.' },
  { decision: 'deny', tool: 'MultiEdit', pattern: '~/.gnupg/**', note: 'GnuPG agent state.' },
  // Docker credential helper
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '~/.docker/config.json',
    note: 'Docker credential helper config.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '~/.docker/config.json',
    note: 'Docker credential helper config.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.docker/config.json',
    note: 'Docker credential helper config.',
  },
  // Kubernetes context
  { decision: 'deny', tool: 'Write', pattern: '~/.kube/config', note: 'Kubernetes context.' },
  { decision: 'deny', tool: 'Edit', pattern: '~/.kube/config', note: 'Kubernetes context.' },
  { decision: 'deny', tool: 'MultiEdit', pattern: '~/.kube/config', note: 'Kubernetes context.' },
  // sudoers includes + main file
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '/etc/sudoers.d/**',
    note: 'sudoers include directory.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '/etc/sudoers.d/**',
    note: 'sudoers include directory.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '/etc/sudoers.d/**',
    note: 'sudoers include directory.',
  },
  { decision: 'deny', tool: 'Write', pattern: '/etc/sudoers', note: 'sudoers main file.' },
  { decision: 'deny', tool: 'Edit', pattern: '/etc/sudoers', note: 'sudoers main file.' },
  { decision: 'deny', tool: 'MultiEdit', pattern: '/etc/sudoers', note: 'sudoers main file.' },
  // Cron directories
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '/etc/cron.d/**',
    note: 'Cron persistence (cron.d).',
  },
  { decision: 'deny', tool: 'Edit', pattern: '/etc/cron.d/**', note: 'Cron persistence (cron.d).' },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '/etc/cron.d/**',
    note: 'Cron persistence (cron.d).',
  },
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '/etc/cron.hourly/**',
    note: 'Cron persistence (hourly).',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '/etc/cron.hourly/**',
    note: 'Cron persistence (hourly).',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '/etc/cron.hourly/**',
    note: 'Cron persistence (hourly).',
  },
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '/etc/cron.daily/**',
    note: 'Cron persistence (daily).',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '/etc/cron.daily/**',
    note: 'Cron persistence (daily).',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '/etc/cron.daily/**',
    note: 'Cron persistence (daily).',
  },
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '/etc/cron.weekly/**',
    note: 'Cron persistence (weekly).',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '/etc/cron.weekly/**',
    note: 'Cron persistence (weekly).',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '/etc/cron.weekly/**',
    note: 'Cron persistence (weekly).',
  },
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '/etc/cron.monthly/**',
    note: 'Cron persistence (monthly).',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '/etc/cron.monthly/**',
    note: 'Cron persistence (monthly).',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '/etc/cron.monthly/**',
    note: 'Cron persistence (monthly).',
  },
  // Per-repo git hooks
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '**/.git/hooks/**',
    note: 'Git hooks persistence.',
  },
  { decision: 'deny', tool: 'Edit', pattern: '**/.git/hooks/**', note: 'Git hooks persistence.' },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '**/.git/hooks/**',
    note: 'Git hooks persistence.',
  },
];

// ─── Editor-config denies (High preset only) ─────────────────────────────
// MEDIUM-severity vectors: editor init scripts and extension trees can
// host persistence (vimscript autocmds, Lua require chains, Emacs init.el
// hooks, VS Code extension manifests). Deny only in High because users
// edit these legitimately and Medium aims to be unintrusive.
const HIGH_EDITOR_CONFIG_DENY_RULES: PresetRule[] = [
  // Vim
  { decision: 'deny', tool: 'Write', pattern: '~/.vimrc', note: 'Vim init script.' },
  { decision: 'deny', tool: 'Edit', pattern: '~/.vimrc', note: 'Vim init script.' },
  { decision: 'deny', tool: 'MultiEdit', pattern: '~/.vimrc', note: 'Vim init script.' },
  { decision: 'deny', tool: 'Write', pattern: '~/.vim/**', note: 'Vim runtime.' },
  { decision: 'deny', tool: 'Edit', pattern: '~/.vim/**', note: 'Vim runtime.' },
  { decision: 'deny', tool: 'MultiEdit', pattern: '~/.vim/**', note: 'Vim runtime.' },
  // Neovim
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '~/.config/nvim/init.lua',
    note: 'Neovim Lua init.',
  },
  { decision: 'deny', tool: 'Edit', pattern: '~/.config/nvim/init.lua', note: 'Neovim Lua init.' },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.config/nvim/init.lua',
    note: 'Neovim Lua init.',
  },
  { decision: 'deny', tool: 'Write', pattern: '~/.config/nvim/init.vim', note: 'Neovim init.' },
  { decision: 'deny', tool: 'Edit', pattern: '~/.config/nvim/init.vim', note: 'Neovim init.' },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.config/nvim/init.vim',
    note: 'Neovim init.',
  },
  { decision: 'deny', tool: 'Write', pattern: '~/.config/nvim/lua/**', note: 'Neovim Lua tree.' },
  { decision: 'deny', tool: 'Edit', pattern: '~/.config/nvim/lua/**', note: 'Neovim Lua tree.' },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.config/nvim/lua/**',
    note: 'Neovim Lua tree.',
  },
  // Emacs
  { decision: 'deny', tool: 'Write', pattern: '~/.emacs', note: 'Emacs init.' },
  { decision: 'deny', tool: 'Edit', pattern: '~/.emacs', note: 'Emacs init.' },
  { decision: 'deny', tool: 'MultiEdit', pattern: '~/.emacs', note: 'Emacs init.' },
  { decision: 'deny', tool: 'Write', pattern: '~/.emacs.d/init.el', note: 'Emacs init.el.' },
  { decision: 'deny', tool: 'Edit', pattern: '~/.emacs.d/init.el', note: 'Emacs init.el.' },
  { decision: 'deny', tool: 'MultiEdit', pattern: '~/.emacs.d/init.el', note: 'Emacs init.el.' },
  // VS Code user config
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '~/.config/Code/User/settings.json',
    note: 'VS Code user settings.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '~/.config/Code/User/settings.json',
    note: 'VS Code user settings.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.config/Code/User/settings.json',
    note: 'VS Code user settings.',
  },
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '~/.config/Code/User/keybindings.json',
    note: 'VS Code keybindings.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '~/.config/Code/User/keybindings.json',
    note: 'VS Code keybindings.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.config/Code/User/keybindings.json',
    note: 'VS Code keybindings.',
  },
  {
    decision: 'deny',
    tool: 'Write',
    pattern: '~/.vscode/extensions/**',
    note: 'VS Code extensions tree.',
  },
  {
    decision: 'deny',
    tool: 'Edit',
    pattern: '~/.vscode/extensions/**',
    note: 'VS Code extensions tree.',
  },
  {
    decision: 'deny',
    tool: 'MultiEdit',
    pattern: '~/.vscode/extensions/**',
    note: 'VS Code extensions tree.',
  },
];

// ─── Cloud-metadata egress denies (Medium and High) ───────────────────
// Sprint 9 promoted these from High-only to a shared set: cloud
// metadata IMDS endpoints leak EC2/GCP credentials in their default
// configuration, so blocking them is universally desirable. RFC-1918
// private-network deny (`denyPrivateNetworkByDefault: true`) stays
// High-only because users legitimately fetch from intra-LAN dev
// servers; cloud metadata IPs do not have a development analog.
const SHARED_NETWORK_DENY_RULES: PresetRule[] = [
  {
    decision: 'deny',
    tool: 'WebFetch',
    pattern: 'domain:169.254.169.254',
    note: 'Cloud metadata IMDS.',
  },
  {
    decision: 'deny',
    tool: 'WebFetch',
    pattern: 'domain:metadata.google.internal',
    note: 'GCP metadata.',
  },
  {
    decision: 'deny',
    tool: 'WebFetch',
    pattern: 'domain:metadata.googleapis.com',
    note: 'GCP metadata.',
  },
];

// ─── Paranoid-only Bash default-deny (Sprint 9) ───────────────────────
// Inside Paranoid, every Bash invocation must match an explicit allow
// rule. The catch-all whole-tool deny gates everything; the explicit
// `exec`/`eval`/`source` denies catch shell builtins that the High
// allow list's prefix patterns might miss.
const PARANOID_DEFAULT_DENY_BASH_RULES: PresetRule[] = [
  { decision: 'deny', tool: 'Bash', pattern: null, note: 'Whitelist-only Bash.' },
  { decision: 'deny', tool: 'Bash', pattern: 'exec *', note: 'Process replacement.' },
  { decision: 'deny', tool: 'Bash', pattern: 'eval *', note: 'Dynamic command execution.' },
  { decision: 'deny', tool: 'Bash', pattern: 'source *', note: 'Inline script load.' },
];

// ─── Allow list so High (default-deny) stays functional ───────────────────
const HIGH_ALLOW_RULES: PresetRule[] = [
  { decision: 'allow', tool: 'Read', pattern: null, note: 'File reads.' },
  { decision: 'allow', tool: 'Grep', pattern: null, note: 'Search.' },
  { decision: 'allow', tool: 'Glob', pattern: null, note: 'File discovery.' },
  { decision: 'allow', tool: 'Edit', pattern: null, note: 'Edit files.' },
  { decision: 'allow', tool: 'Write', pattern: null, note: 'Write files.' },
  { decision: 'allow', tool: 'NotebookEdit', pattern: null, note: 'Notebook edits.' },
  { decision: 'allow', tool: 'Bash', pattern: 'git *', note: 'Git commands.' },
  { decision: 'allow', tool: 'Bash', pattern: 'npm *', note: 'npm.' },
  { decision: 'allow', tool: 'Bash', pattern: 'pnpm *', note: 'pnpm.' },
  { decision: 'allow', tool: 'Bash', pattern: 'yarn *', note: 'yarn.' },
  { decision: 'allow', tool: 'Bash', pattern: 'node *', note: 'Node runner.' },
  { decision: 'allow', tool: 'Bash', pattern: 'python *', note: 'Python runner.' },
  { decision: 'allow', tool: 'Bash', pattern: 'python3 *', note: 'Python 3 runner.' },
  { decision: 'allow', tool: 'Bash', pattern: 'ls *', note: 'List files.' },
  { decision: 'allow', tool: 'Bash', pattern: 'cat *', note: 'Read files.' },
  { decision: 'allow', tool: 'Bash', pattern: 'grep *', note: 'Search.' },
  { decision: 'allow', tool: 'Bash', pattern: 'find *', note: 'Find files.' },
  { decision: 'allow', tool: 'WebSearch', pattern: null, note: 'Web search.' },
  {
    decision: 'allow',
    tool: 'WebFetch',
    pattern: 'domain:docs.anthropic.com',
    note: 'Anthropic docs.',
  },
  { decision: 'allow', tool: 'WebFetch', pattern: 'domain:github.com', note: 'GitHub.' },
  {
    decision: 'allow',
    tool: 'WebFetch',
    pattern: 'domain:*.githubusercontent.com',
    note: 'Raw GitHub content.',
  },
];

// ─── Presets ──────────────────────────────────────────────────────────────

export const PRESETS: Record<RiskProfile, Preset> = {
  low: {
    profile: 'low',
    label: 'Low',
    description: 'Permissive: Sentinel only watches, never blocks.',
    highlights: [
      'Scanner observes secrets only',
      'No OS notifications below HIGH severity',
      'Tool permissions disabled, except self-protection',
      'Blocks tampering with Claude Code permissions and Sentinel state',
    ],
    settings: {
      securityScanEnabled: true,
      securityEnforcementMode: 'observe' as SecurityEnforcementMode,
      securityScanSecrets: true,
      securityScanInjection: false,
      securityScanToolUse: false,
      securityOsNotifyThreshold: 'high' as SecurityOsNotifyThreshold,
      securityApproveHoldSec: 60,
      // Even in Low we keep tool permissions on so the config-protection
      // denies fire. The default-action is still allow, so nothing else
      // changes for the user.
      toolPermissionsEnabled: true,
      toolPermissionDefaultAction: 'allow' as PermissionDecision,
      toolPermissionSkipInAutoMode: true,
      denyPrivateNetworkByDefault: false,
    },
    rules: [...SHARED_CONFIG_PROTECTION_RULES],
  },
  medium: {
    profile: 'medium',
    label: 'Medium',
    description: 'Balanced: catches dangerous things, lets everything else through.',
    highlights: [
      'Blocks HIGH-severity outbound findings (with approve-and-hold)',
      'Scanner covers secrets + risky tool use',
      'Asks before rm -rf, sudo, chmod 777, curl|bash; denies SSH/AWS keys, exfil surfaces',
      'Blocks tampering with Claude Code permissions and Sentinel state',
      'Blocks persistence vectors (cron, launchd, systemd, git hooks, gpg/docker/kube)',
      'Blocks cloud metadata endpoints (IMDS, GCP)',
    ],
    settings: {
      securityScanEnabled: true,
      securityEnforcementMode: 'block_high' as SecurityEnforcementMode,
      securityScanSecrets: true,
      securityScanInjection: false,
      securityScanToolUse: true,
      securityOsNotifyThreshold: 'medium' as SecurityOsNotifyThreshold,
      securityApproveHoldSec: 60,
      toolPermissionsEnabled: true,
      toolPermissionDefaultAction: 'allow' as PermissionDecision,
      toolPermissionSkipInAutoMode: true,
      denyPrivateNetworkByDefault: false,
    },
    rules: [
      ...SHARED_CONFIG_PROTECTION_RULES,
      ...SHARED_ASK_RULES,
      ...SHARED_DENY_RULES,
      ...SHARED_NETWORK_DENY_RULES,
      ...SHARED_PERSISTENCE_DENY_RULES,
    ],
  },
  high: {
    profile: 'high',
    label: 'High',
    description: 'Strict: default-deny for tools, aggressive scanning, blocks MEDIUM+.',
    highlights: [
      'Blocks MEDIUM- and HIGH-severity outbound findings',
      'Prompt-injection scanner enabled',
      'Default-deny permissions with an explicit allow list',
      'Auto-mode bypass disabled; Sentinel still enforces',
      'Denies cloud-metadata and private network egress by default',
      'Blocks tampering with Claude Code permissions and Sentinel state',
      'Blocks persistence vectors and editor-config writes (vim, nvim, emacs, vscode)',
    ],
    settings: {
      securityScanEnabled: true,
      securityEnforcementMode: 'block_medium_high' as SecurityEnforcementMode,
      securityScanSecrets: true,
      securityScanInjection: true,
      securityScanToolUse: true,
      securityOsNotifyThreshold: 'low' as SecurityOsNotifyThreshold,
      securityApproveHoldSec: 120,
      toolPermissionsEnabled: true,
      toolPermissionDefaultAction: 'deny' as PermissionDecision,
      toolPermissionSkipInAutoMode: false,
      denyPrivateNetworkByDefault: true,
    },
    rules: [
      ...SHARED_CONFIG_PROTECTION_RULES,
      ...SHARED_ASK_RULES,
      ...SHARED_DENY_RULES,
      ...SHARED_NETWORK_DENY_RULES,
      ...SHARED_PERSISTENCE_DENY_RULES,
      ...HIGH_EDITOR_CONFIG_DENY_RULES,
      ...HIGH_ALLOW_RULES,
    ],
  },
  paranoid: {
    profile: 'paranoid',
    label: 'Paranoid',
    description: 'Whitelist-only Bash; auto-mode disabled; aggressive scanning everywhere.',
    highlights: [
      'Inherits every High protection',
      'All Bash denied except an explicit allow list',
      'No auto-mode skip: Sentinel always enforces',
      'Longest approval window (180s) for unknown tool calls',
    ],
    settings: {
      securityScanEnabled: true,
      securityEnforcementMode: 'block_medium_high' as SecurityEnforcementMode,
      securityScanSecrets: true,
      securityScanInjection: true,
      securityScanToolUse: true,
      securityOsNotifyThreshold: 'low' as SecurityOsNotifyThreshold,
      // Paranoid users want a longer review window before a held block
      // auto-denies; 180s gives room to walk away from the screen.
      securityApproveHoldSec: 180,
      toolPermissionsEnabled: true,
      toolPermissionDefaultAction: 'deny' as PermissionDecision,
      // Sentinel keeps gating even in auto mode: the whole point of
      // Paranoid is that the user does NOT trust the auto-mode
      // classifier alone.
      toolPermissionSkipInAutoMode: false,
      denyPrivateNetworkByDefault: true,
    },
    rules: [
      ...SHARED_CONFIG_PROTECTION_RULES,
      ...SHARED_ASK_RULES,
      ...SHARED_DENY_RULES,
      ...SHARED_NETWORK_DENY_RULES,
      ...SHARED_PERSISTENCE_DENY_RULES,
      ...HIGH_EDITOR_CONFIG_DENY_RULES,
      ...HIGH_ALLOW_RULES,
      ...PARANOID_DEFAULT_DENY_BASH_RULES,
    ],
  },
};

/** Apply a preset to the live daemon: write settings then upsert each rule.
 *  Also flips `securitySetupCompleted` to `true` so the wizard stops
 *  auto-firing. Rules are added cumulatively — callers that want to start
 *  from a clean slate should delete existing rules first (the wizard does
 *  not, to avoid nuking user-authored rules). */
export async function applyPreset(profile: RiskProfile): Promise<void> {
  const preset = PRESETS[profile];
  const settingsPatch: Partial<Settings> = {
    ...preset.settings,
    securitySetupCompleted: true,
  };
  const res = await sendToSentinel({ type: 'update_settings', settings: settingsPatch });
  if (!res.success) throw new Error(res.error ?? 'update_settings failed');

  for (const rule of preset.rules) {
    const input: PermissionRuleInput = {
      decision: rule.decision,
      tool: rule.tool,
      pattern: rule.pattern,
      raw: toRaw(rule.tool, rule.pattern),
      note: rule.note,
      enabled: true,
      priority: 100,
    };
    const ruleRes = await sendToSentinel({ type: 'upsert_permission_rule', rule: input });
    if (!ruleRes.success) {
      throw new Error(`Failed to install rule ${input.raw}: ${ruleRes.error ?? 'unknown'}`);
    }
  }
}

/** Flip `securitySetupCompleted` without touching any other setting. Called
 *  when the user dismisses the wizard without picking a preset. */
export async function markSetupSkipped(): Promise<void> {
  const res = await sendToSentinel({
    type: 'update_settings',
    settings: { securitySetupCompleted: true },
  });
  if (!res.success) throw new Error(res.error ?? 'update_settings failed');
}
