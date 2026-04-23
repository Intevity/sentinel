import type {
  PermissionRuleInput,
  Settings,
  SecurityEnforcementMode,
  SecurityOsNotifyThreshold,
  PermissionDecision,
} from '@claude-sentinel/shared';
import { sendToSentinel } from './ipc.js';

export type RiskProfile = 'low' | 'medium' | 'high';

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
  | 'securityBlockHoldEnabled'
  | 'securityApproveHoldSec'
  | 'toolPermissionsEnabled'
  | 'toolPermissionDefaultAction'
  | 'toolPermissionSkipInAutoMode'
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
      'Tool permissions disabled',
    ],
    settings: {
      securityScanEnabled: true,
      securityEnforcementMode: 'observe' as SecurityEnforcementMode,
      securityScanSecrets: true,
      securityScanInjection: false,
      securityScanToolUse: false,
      securityOsNotifyThreshold: 'high' as SecurityOsNotifyThreshold,
      securityBlockHoldEnabled: false,
      securityApproveHoldSec: 60,
      toolPermissionsEnabled: false,
      toolPermissionDefaultAction: 'allow' as PermissionDecision,
      toolPermissionSkipInAutoMode: true,
    },
    rules: [],
  },
  medium: {
    profile: 'medium',
    label: 'Medium',
    description: 'Balanced: catches dangerous things, lets everything else through.',
    highlights: [
      'Blocks HIGH-severity outbound findings (with approve-and-hold)',
      'Scanner covers secrets + risky tool use',
      'Asks before rm -rf, sudo, chmod 777, curl|bash; denies SSH/AWS keys, exfil surfaces',
    ],
    settings: {
      securityScanEnabled: true,
      securityEnforcementMode: 'block_high' as SecurityEnforcementMode,
      securityScanSecrets: true,
      securityScanInjection: false,
      securityScanToolUse: true,
      securityOsNotifyThreshold: 'medium' as SecurityOsNotifyThreshold,
      securityBlockHoldEnabled: true,
      securityApproveHoldSec: 60,
      toolPermissionsEnabled: true,
      toolPermissionDefaultAction: 'allow' as PermissionDecision,
      toolPermissionSkipInAutoMode: true,
    },
    rules: [...SHARED_ASK_RULES, ...SHARED_DENY_RULES],
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
    ],
    settings: {
      securityScanEnabled: true,
      securityEnforcementMode: 'block_medium_high' as SecurityEnforcementMode,
      securityScanSecrets: true,
      securityScanInjection: true,
      securityScanToolUse: true,
      securityOsNotifyThreshold: 'low' as SecurityOsNotifyThreshold,
      securityBlockHoldEnabled: true,
      securityApproveHoldSec: 120,
      toolPermissionsEnabled: true,
      toolPermissionDefaultAction: 'deny' as PermissionDecision,
      toolPermissionSkipInAutoMode: false,
    },
    rules: [...SHARED_ASK_RULES, ...SHARED_DENY_RULES, ...HIGH_ALLOW_RULES],
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
