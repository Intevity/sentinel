import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Plus, Trash2, Loader2, Pencil, X, Search, ShieldCheck } from 'lucide-react';
import type {
  PermissionRule,
  PermissionDecision,
  PermissionRuleSource,
  SecurityAllowlistEntry,
  Settings,
} from '@claude-sentinel/shared';
import { usePermissionRules } from '../hooks/usePermissionRules.js';
import { useSecurityAllowlist } from '../hooks/useSecurityAllowlist.js';
import { useInlineConfirm } from '../hooks/useInlineConfirm.js';
import { sendToSentinel } from '../lib/ipc.js';
import OverlayPanel from './OverlayPanel.js';

export type SecurityOverlayTab = 'rules' | 'allowlist';

interface SecurityRulesOverlayProps {
  onClose: () => void;
  /** Callback ref forwarded from `useAutoResizeWindow().overlayRef`. */
  measureRef?: ((el: HTMLElement | null) => void) | undefined;
  /** Which tab to show first. Defaults to 'rules'. */
  initialTab?: SecurityOverlayTab;
  /** Current settings — drives empty-state / onboarding rendering. */
  settings: Settings | null;
  /** Partial update for settings. Used by in-overlay "Enable X" buttons. */
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  /** Invoked when the user clicks "Run setup wizard" on the empty-state hero. */
  onRunSetupWizard?: () => void;
}

type Mode = 'form' | 'raw';

interface Draft {
  decision: PermissionDecision;
  tool: string;
  pattern: string;
  note: string;
  raw: string;
  mode: Mode;
  /** Sprint 9 per-project scope — empty string means global. */
  projectScope: string;
}

const BUILTIN_TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Agent',
  'NotebookEdit',
  'mcp__*',
  '*',
];

const EMPTY_DRAFT: Draft = {
  decision: 'deny',
  tool: 'Bash',
  pattern: '',
  note: '',
  raw: '',
  mode: 'form',
  projectScope: '',
};

/** Two-tabbed overlay: tool permission rules + security scanning allowlist.
 *  Replaces the old rules-only PermissionsEditor; opened from the header
 *  shield icon and from the Settings panel's "Manage …" buttons. */
export default function SecurityRulesOverlay({
  onClose,
  measureRef,
  initialTab = 'rules',
  settings,
  updateSettings,
  onRunSetupWizard,
}: SecurityRulesOverlayProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<SecurityOverlayTab>(initialTab);
  const scanOn = settings?.securityScanEnabled ?? false;
  const permsOn = settings?.toolPermissionsEnabled ?? false;
  const bothOff = !scanOn && !permsOn;

  const chrome = (
    <>
      <header className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-black/5 dark:border-white/5">
        <span className="text-[15px] font-semibold text-black dark:text-white tracking-tight">
          Security
        </span>
        <button
          onClick={onClose}
          className="text-muted hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5"
          title="Close"
          aria-label="Close security overlay"
        >
          <X size={16} strokeWidth={2.2} />
        </button>
      </header>
      <div
        role="tablist"
        aria-label="Security categories"
        className="flex gap-1 px-4 py-2 border-b border-black/5 dark:border-white/5"
      >
        {(
          [
            { id: 'rules', label: 'Tool permissions' },
            { id: 'allowlist', label: 'Scanning allowlist' },
          ] as Array<{ id: SecurityOverlayTab; label: string }>
        ).map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex-1 text-[11px] font-semibold px-2 py-1 rounded-full transition-colors ${
                active ? 'text-white' : 'text-muted hover:text-black dark:hover:text-white'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="security-tab-pill"
                  className="absolute inset-0 bg-ios-blue rounded-full -z-[1]"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="relative">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </>
  );

  return (
    <OverlayPanel measureRef={measureRef} stickyChrome={chrome}>
      <div className="px-4 py-3 space-y-4">
        {bothOff && (
          <OnboardingHero
            onEnableScan={() => void updateSettings({ securityScanEnabled: true })}
            onEnablePerms={() => void updateSettings({ toolPermissionsEnabled: true })}
            onRunSetupWizard={onRunSetupWizard}
          />
        )}
        {activeTab === 'rules' ? (
          permsOn ? (
            <PermissionRulesView />
          ) : (
            <LayerDisabledCard
              title="Tool permissions are off"
              description="Turn on the permissions layer to start writing allow/deny rules that block denied tool calls at the proxy layer."
              cta="Enable tool permissions"
              onEnable={() => void updateSettings({ toolPermissionsEnabled: true })}
            />
          )
        ) : scanOn ? (
          <AllowlistView />
        ) : (
          <LayerDisabledCard
            title="Content scanning is off"
            description="The allowlist suppresses matches you've chosen to ignore on future scans. Turn scanning on to start using it."
            cta="Enable scanning"
            onEnable={() => void updateSettings({ securityScanEnabled: true })}
          />
        )}
      </div>
    </OverlayPanel>
  );
}

// ─── Rules tab — extracted verbatim from the old PermissionsEditor ──────────

type DecisionFilter = 'all' | PermissionDecision;
type SourceFilter = 'all' | PermissionRuleSource;

function PermissionRulesView(): React.ReactElement {
  const { rules, loading, error, upsert, remove, toggle } = usePermissionRules();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  // Sprint 9: cwds collected by the daemon from active Claude Code sessions.
  // Fetched once when the rule editor opens; powers the project_scope datalist.
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void sendToSentinel<string[]>({ type: 'list_recent_working_dirs' })
      .then((res) => {
        if (alive && res.success && Array.isArray(res.data)) setRecentCwds(res.data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const startAdd = (): void => {
    setDraft({ ...EMPTY_DRAFT });
    setSaveError(null);
  };
  const startEdit = (rule: PermissionRule): void => {
    setDraft({
      decision: rule.decision,
      tool: rule.tool,
      pattern: rule.pattern ?? '',
      note: rule.note ?? '',
      raw: rule.raw,
      mode: 'form',
      projectScope: rule.projectScope ?? '',
    });
    setSaveError(null);
  };
  const cancel = (): void => {
    setDraft(null);
    setSaveError(null);
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { decision, tool, pattern, note, raw, mode } = draft;
      let finalDecision = decision;
      let finalTool = tool;
      let finalPattern: string | null = pattern.trim() ? pattern : null;
      let finalRaw = raw;
      if (mode === 'raw') {
        const parsed = parseRawForm(raw);
        if ('error' in parsed) {
          setSaveError(parsed.error);
          setSaving(false);
          return;
        }
        finalDecision = parsed.decision;
        finalTool = parsed.tool;
        finalPattern = parsed.pattern;
        finalRaw = parsed.canonicalRaw;
      } else {
        finalRaw = finalPattern ? `${finalTool}(${finalPattern})` : finalTool;
      }
      const existing = rules.find((r) => r.raw === finalRaw && r.decision === finalDecision);
      const trimmedScope = draft.projectScope.trim();
      const saveInput = {
        decision: finalDecision,
        tool: finalTool,
        pattern: finalPattern,
        raw: finalRaw,
        note: note.trim() ? note : null,
        enabled: true,
        projectScope: trimmedScope === '' ? null : trimmedScope,
      };
      await upsert(existing ? { id: existing.id, ...saveInput } : saveInput);
      setDraft(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rules.filter((r) => {
      if (decisionFilter !== 'all' && r.decision !== decisionFilter) return false;
      if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
      if (q) {
        const hay = [r.tool, r.pattern ?? '', r.raw, r.note ?? ''].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rules, search, decisionFilter, sourceFilter]);
  const denies = useMemo(
    () => filtered.filter((r) => r.decision === 'deny' || r.decision === 'ask'),
    [filtered],
  );
  const allows = useMemo(() => filtered.filter((r) => r.decision === 'allow'), [filtered]);
  const filtersActive = search.trim() !== '' || decisionFilter !== 'all' || sourceFilter !== 'all';
  const clearFilters = (): void => {
    setSearch('');
    setDecisionFilter('all');
    setSourceFilter('all');
  };
  const anyImported = rules.some((r) => r.source === 'claude-code');

  return (
    <>
      <p className="text-[11px] text-muted leading-snug px-1">
        Rules are evaluated deny-first, then allow. The first matching rule wins. Example patterns:{' '}
        <code className="text-[10.5px]">Bash(rm -rf *)</code>,{' '}
        <code className="text-[10.5px]">WebFetch(domain:example.com)</code>,{' '}
        <code className="text-[10.5px]">Read(//etc/**)</code>,{' '}
        <code className="text-[10.5px]">mcp__github__*</code>.
      </p>

      {loading && (
        <div className="flex items-center justify-center py-6 gap-2 text-muted">
          <Loader2 size={12} className="animate-spin" />
          <span className="text-[11px]">Loading rules…</span>
        </div>
      )}
      {!loading && error && <p className="text-[12px] text-ios-red px-1">{error}</p>}

      {!loading && !error && (
        <>
          {rules.length > 0 && (
            <div className="space-y-2">
              <div className="relative">
                <Search
                  size={11}
                  strokeWidth={2.5}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
                />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search tool, pattern, or note"
                  className="w-full text-[12px] pl-7 pr-7 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue placeholder:text-muted"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-black dark:hover:text-white"
                    aria-label="Clear search"
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                <FilterChip
                  label={`All (${rules.length})`}
                  active={decisionFilter === 'all'}
                  onClick={() => setDecisionFilter('all')}
                />
                <FilterChip
                  label="Allow"
                  count={rules.filter((r) => r.decision === 'allow').length}
                  active={decisionFilter === 'allow'}
                  onClick={() => setDecisionFilter('allow')}
                  tone="green"
                />
                <FilterChip
                  label="Deny"
                  count={rules.filter((r) => r.decision === 'deny').length}
                  active={decisionFilter === 'deny'}
                  onClick={() => setDecisionFilter('deny')}
                  tone="red"
                />
                <FilterChip
                  label="Ask"
                  count={rules.filter((r) => r.decision === 'ask').length}
                  active={decisionFilter === 'ask'}
                  onClick={() => setDecisionFilter('ask')}
                  tone="orange"
                />
                {anyImported && (
                  <>
                    <span className="text-muted mx-1">·</span>
                    <FilterChip
                      label="Local"
                      count={rules.filter((r) => r.source === 'local').length}
                      active={sourceFilter === 'local'}
                      onClick={() => setSourceFilter(sourceFilter === 'local' ? 'all' : 'local')}
                    />
                    <FilterChip
                      label="Claude Code"
                      count={rules.filter((r) => r.source === 'claude-code').length}
                      active={sourceFilter === 'claude-code'}
                      onClick={() =>
                        setSourceFilter(sourceFilter === 'claude-code' ? 'all' : 'claude-code')
                      }
                      tone="blue"
                    />
                  </>
                )}
                {filtersActive && (
                  <button
                    onClick={clearFilters}
                    className="ml-auto text-[11px] font-medium text-ios-blue hover:opacity-80 active:scale-95"
                  >
                    Clear
                  </button>
                )}
              </div>
              {filtered.length === 0 && (
                <p className="text-[11px] text-muted px-1">No rules match the current filter.</p>
              )}
            </div>
          )}
          {filtered.length > 0 && (
            <>
              <RuleList
                title="Deny rules"
                emptyCopy="No deny rules yet."
                rules={denies}
                onEdit={startEdit}
                onToggle={toggle}
                onRemove={remove}
              />
              <RuleList
                title="Allow rules"
                emptyCopy="No allow rules yet."
                rules={allows}
                onEdit={startEdit}
                onToggle={toggle}
                onRemove={remove}
              />
            </>
          )}
          {rules.length === 0 && (
            <>
              <RuleList
                title="Deny rules"
                emptyCopy="No deny rules yet."
                rules={[]}
                onEdit={startEdit}
                onToggle={toggle}
                onRemove={remove}
              />
              <RuleList
                title="Allow rules"
                emptyCopy="No allow rules yet."
                rules={[]}
                onEdit={startEdit}
                onToggle={toggle}
                onRemove={remove}
              />
            </>
          )}

          {draft === null && (
            <button
              onClick={startAdd}
              className="w-full flex items-center justify-center gap-1.5 text-[12px] font-medium text-ios-blue hover:opacity-80 transition-opacity active:scale-95 py-2 rounded-full bg-black/[0.04] dark:bg-white/[0.05]"
            >
              <Plus size={12} strokeWidth={2.5} />
              Add rule
            </button>
          )}

          {draft !== null && (
            <div className="glass-card px-3 py-3 space-y-3">
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span>Mode:</span>
                <button
                  onClick={() => setDraft((d) => d && { ...d, mode: 'form' })}
                  className={`px-2 py-0.5 rounded-full ${draft.mode === 'form' ? 'bg-ios-blue text-white' : ''}`}
                >
                  Form
                </button>
                <button
                  onClick={() =>
                    setDraft(
                      (d) =>
                        d && {
                          ...d,
                          mode: 'raw',
                          raw: d.pattern
                            ? `${d.decision} ${d.tool}(${d.pattern})`
                            : `${d.decision} ${d.tool}`,
                        },
                    )
                  }
                  className={`px-2 py-0.5 rounded-full ${draft.mode === 'raw' ? 'bg-ios-blue text-white' : ''}`}
                >
                  Raw
                </button>
              </div>

              {draft.mode === 'form' ? (
                <>
                  <DecisionRadio
                    value={draft.decision}
                    onChange={(v) => setDraft((d) => d && { ...d, decision: v })}
                  />
                  <div>
                    <p className="text-[11px] text-muted mb-1">Tool</p>
                    <select
                      value={BUILTIN_TOOLS.includes(draft.tool) ? draft.tool : '__custom__'}
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft((d) => d && { ...d, tool: v === '__custom__' ? '' : v });
                      }}
                      className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue"
                    >
                      {BUILTIN_TOOLS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                      <option value="__custom__">Custom…</option>
                    </select>
                    {!BUILTIN_TOOLS.includes(draft.tool) && (
                      <input
                        value={draft.tool}
                        onChange={(e) => setDraft((d) => d && { ...d, tool: e.target.value })}
                        placeholder="mcp__server__tool"
                        className="mt-1 w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue font-mono"
                      />
                    )}
                  </div>
                  <div>
                    <p className="text-[11px] text-muted mb-1">Pattern (optional)</p>
                    <input
                      value={draft.pattern}
                      onChange={(e) => setDraft((d) => d && { ...d, pattern: e.target.value })}
                      placeholder="npm *, rm -rf *, domain:example.com, //etc/**"
                      className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue font-mono"
                    />
                    <p className="text-[10px] text-muted mt-1">
                      Leave blank to match every call of <code>{draft.tool || '…'}</code>.
                    </p>
                  </div>
                </>
              ) : (
                <div>
                  <p className="text-[11px] text-muted mb-1">Raw rule</p>
                  <input
                    value={draft.raw}
                    onChange={(e) => setDraft((d) => d && { ...d, raw: e.target.value })}
                    placeholder="deny Bash(rm -rf *)"
                    className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue font-mono"
                  />
                  <p className="text-[10px] text-muted mt-1">
                    Format: <code>allow &lt;rule&gt;</code> or <code>deny &lt;rule&gt;</code>.
                  </p>
                </div>
              )}

              <div>
                <p className="text-[11px] text-muted mb-1">Note (optional)</p>
                <input
                  value={draft.note}
                  onChange={(e) => setDraft((d) => d && { ...d, note: e.target.value })}
                  placeholder="Why this rule exists"
                  className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue"
                />
              </div>

              <div>
                <p className="text-[11px] text-muted mb-1">Project scope (optional)</p>
                <input
                  value={draft.projectScope}
                  list="rule-scope-recent-cwds"
                  onChange={(e) => setDraft((d) => d && { ...d, projectScope: e.target.value })}
                  placeholder="e.g. ~/work/prod/**  (blank: applies everywhere)"
                  className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue font-mono"
                />
                <datalist id="rule-scope-recent-cwds">
                  {recentCwds.map((cwd) => (
                    <option key={cwd} value={cwd} />
                  ))}
                  {recentCwds.map((cwd) => (
                    <option key={`${cwd}-glob`} value={`${cwd}/**`} />
                  ))}
                </datalist>
                <p className="text-[10px] text-muted mt-1">
                  Path glob the request's working directory must match. Leave blank for global.
                </p>
              </div>

              {saveError && <p className="text-[11px] text-ios-red">{saveError}</p>}

              <div className="flex gap-2">
                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="flex-1 text-[12px] font-semibold text-white bg-ios-blue hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save rule'}
                </button>
                <button
                  onClick={cancel}
                  disabled={saving}
                  className="text-[12px] text-muted hover:text-black dark:hover:text-white transition-colors px-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ─── Allowlist tab ─────────────────────────────────────────────────────────

type AllowlistCategory = 'secrets' | 'injection' | 'bash' | 'write' | 'webfetch' | 'other';

interface CategoryMeta {
  id: AllowlistCategory;
  label: string;
  tone: 'red' | 'orange' | 'green' | 'blue' | undefined;
}

const CATEGORY_ORDER: CategoryMeta[] = [
  { id: 'secrets', label: 'Secrets', tone: 'red' },
  { id: 'injection', label: 'Prompt injection', tone: 'orange' },
  { id: 'bash', label: 'Risky bash', tone: 'orange' },
  { id: 'write', label: 'Risky write', tone: 'orange' },
  { id: 'webfetch', label: 'Risky webfetch', tone: 'orange' },
  { id: 'other', label: 'Other', tone: undefined },
];

const SECRET_DETECTORS = new Set<string>([
  'aws-access-key',
  'github-ghp',
  'github-pat',
  'github-oauth',
  'anthropic-key',
  'openai-project',
  'openai-legacy',
  'slack-token',
  'stripe-live-secret',
  'stripe-live-restricted',
  'google-api-key',
  'hf-token',
  'npm-token',
  'npmrc-auth',
  'google-oauth-refresh',
  'private-key-block',
  'private-key-header-doc',
]);

const INJECTION_DETECTORS = new Set<string>([
  'unicode-tag-chars',
  'ignore-instructions',
  'jailbreak-persona',
  'role-impersonation',
]);

const BASH_DETECTORS = new Set<string>([
  'curl-pipe-shell',
  'eval-curl',
  'reverse-shell-devtcp',
  'reverse-shell-bashi',
  'netcat-listen',
  'rm-rf-root',
  'ssh-authorized-keys',
  'aws-credentials-write',
  'cron-install',
  'launch-daemon',
  'base64-decode-exec',
  'curl-exfil-post',
  'curl-token-header',
  'history-wipe',
  'chmod-world-writable',
]);

function categorize(detectorId: string): AllowlistCategory {
  if (SECRET_DETECTORS.has(detectorId)) return 'secrets';
  if (INJECTION_DETECTORS.has(detectorId)) return 'injection';
  if (BASH_DETECTORS.has(detectorId)) return 'bash';
  if (detectorId.startsWith('risky-write-')) return 'write';
  if (detectorId.startsWith('risky-webfetch-')) return 'webfetch';
  return 'other';
}

type AllowlistFilter = 'all' | AllowlistCategory;

function AllowlistView(): React.ReactElement {
  const { entries, loading, error, remove } = useSecurityAllowlist();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<AllowlistFilter>('all');

  const counts = useMemo(() => {
    const m: Record<AllowlistCategory, number> = {
      secrets: 0,
      injection: 0,
      bash: 0,
      write: 0,
      webfetch: 0,
      other: 0,
    };
    for (const e of entries) m[categorize(e.detectorId)] += 1;
    return m;
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter !== 'all' && categorize(e.detectorId) !== filter) return false;
      if (q) {
        const hay = [e.title ?? '', e.detectorId, e.matchMask ?? '', e.note ?? '']
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, search, filter]);

  const grouped = useMemo(() => {
    const m: Record<AllowlistCategory, SecurityAllowlistEntry[]> = {
      secrets: [],
      injection: [],
      bash: [],
      write: [],
      webfetch: [],
      other: [],
    };
    for (const e of filtered) m[categorize(e.detectorId)].push(e);
    return m;
  }, [filtered]);

  const filtersActive = search.trim() !== '' || filter !== 'all';
  const clearFilters = (): void => {
    setSearch('');
    setFilter('all');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 gap-2 text-muted">
        <Loader2 size={12} className="animate-spin" />
        <span className="text-[11px]">Loading allowlist…</span>
      </div>
    );
  }
  if (error) return <p className="text-[12px] text-ios-red px-1">{error}</p>;

  return (
    <>
      <p className="text-[11px] text-muted leading-snug px-1">
        Matches you&apos;ve chosen to always allow. Entries here are silently suppressed across
        every future scan. Added by clicking <span className="font-semibold">Always allow</span> on
        a finding in the Security tab.
      </p>

      {entries.length > 0 && (
        <div className="space-y-2">
          <div className="relative">
            <Search
              size={11}
              strokeWidth={2.5}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, detector, match, or note"
              className="w-full text-[12px] pl-7 pr-7 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue placeholder:text-muted"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-black dark:hover:text-white"
                aria-label="Clear search"
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            <FilterChip
              label={`All (${entries.length})`}
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
            {CATEGORY_ORDER.map((cat) => {
              const count = counts[cat.id];
              if (count === 0) return null;
              const onClick = (): void => setFilter(filter === cat.id ? 'all' : cat.id);
              return cat.tone ? (
                <FilterChip
                  key={cat.id}
                  label={cat.label}
                  count={count}
                  active={filter === cat.id}
                  onClick={onClick}
                  tone={cat.tone}
                />
              ) : (
                <FilterChip
                  key={cat.id}
                  label={cat.label}
                  count={count}
                  active={filter === cat.id}
                  onClick={onClick}
                />
              );
            })}
            {filtersActive && (
              <button
                onClick={clearFilters}
                className="ml-auto text-[11px] font-medium text-ios-blue hover:opacity-80 active:scale-95"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {entries.length === 0 && (
        <div className="glass-card px-4 py-6 text-center">
          <p className="text-[12px] text-muted">
            No entries yet. Click <span className="font-semibold">Always allow</span> on a
            Security-tab event to add one.
          </p>
        </div>
      )}

      {entries.length > 0 && filtered.length === 0 && (
        <p className="text-[11px] text-muted px-1">No entries match the current filter.</p>
      )}

      {filtered.length > 0 && (
        <div className="space-y-4">
          {CATEGORY_ORDER.map((cat) => {
            const items = grouped[cat.id];
            if (items.length === 0) return null;
            return (
              <div key={cat.id}>
                <p className="section-label">{cat.label}</p>
                <div className="glass-card divide-y divide-black/5 dark:divide-white/5 mt-2">
                  {items.map((entry) => (
                    <AllowlistRow key={entry.id} entry={entry} onRemove={() => remove(entry.id)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function AllowlistRow({
  entry,
  onRemove,
}: {
  entry: SecurityAllowlistEntry;
  onRemove: () => Promise<void>;
}): React.ReactElement {
  const { pending, trigger } = useInlineConfirm(onRemove);
  const when = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(entry.createdAt));
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-black dark:text-white truncate">
          {entry.title ?? entry.detectorId}
        </p>
        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
          {entry.matchMask && (
            <code className="text-[10px] font-mono bg-muted/10 px-1 py-0.5 rounded truncate">
              {entry.matchMask}
            </code>
          )}
          <span className="text-[10px] text-muted">added {when}</span>
        </div>
        {entry.note && <p className="text-[10px] text-muted mt-1 leading-snug">{entry.note}</p>}
      </div>
      <button
        onClick={trigger}
        className={`flex-shrink-0 flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full transition-all active:scale-95 ${
          pending ? 'bg-ios-red text-white' : 'bg-ios-red/10 text-ios-red hover:bg-ios-red/20'
        }`}
        title={pending ? 'Click again to remove' : 'Remove from allowlist'}
      >
        <Trash2 size={10} strokeWidth={2.5} />
        {pending ? 'Confirm?' : 'Remove'}
      </button>
    </div>
  );
}

// ─── Shared empty-state & onboarding ───────────────────────────────────────

function OnboardingHero({
  onEnableScan,
  onEnablePerms,
  onRunSetupWizard,
}: {
  onEnableScan: () => void;
  onEnablePerms: () => void;
  onRunSetupWizard: (() => void) | undefined;
}): React.ReactElement {
  return (
    <div className="glass-card px-4 py-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} strokeWidth={2.2} className="text-ios-green flex-shrink-0" />
        <p className="text-[13px] font-semibold text-black dark:text-white">Security is off</p>
      </div>
      <p className="text-[11px] text-muted leading-snug">
        Sentinel protects claude.ai traffic in two layers: content scanning and tool permissions.
        Pick one, both, or run the setup wizard to get a recommended preset.
      </p>
      <div className="flex flex-wrap gap-2">
        {onRunSetupWizard && (
          <button
            onClick={onRunSetupWizard}
            className="text-[11px] font-semibold text-white bg-ios-blue hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all"
          >
            Run setup wizard
          </button>
        )}
        <button
          onClick={onEnableScan}
          className="text-[11px] font-semibold text-ios-blue bg-ios-blue/10 hover:bg-ios-blue/20 active:scale-95 px-3 py-1.5 rounded-full transition-all"
        >
          Enable scanning
        </button>
        <button
          onClick={onEnablePerms}
          className="text-[11px] font-semibold text-ios-blue bg-ios-blue/10 hover:bg-ios-blue/20 active:scale-95 px-3 py-1.5 rounded-full transition-all"
        >
          Enable tool permissions
        </button>
      </div>
    </div>
  );
}

function LayerDisabledCard({
  title,
  description,
  cta,
  onEnable,
}: {
  title: string;
  description: string;
  cta: string;
  onEnable: () => void;
}): React.ReactElement {
  return (
    <div className="glass-card px-4 py-5 text-center space-y-3">
      <p className="text-[13px] font-semibold text-black dark:text-white">{title}</p>
      <p className="text-[11px] text-muted leading-snug">{description}</p>
      <button
        onClick={onEnable}
        className="text-[11px] font-semibold text-white bg-ios-blue hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all"
      >
        {cta}
      </button>
    </div>
  );
}

// ─── Rules helpers ─────────────────────────────────────────────────────────

function FilterChip({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  tone?: 'red' | 'green' | 'orange' | 'blue';
}): React.ReactElement {
  const activeToneMap: Record<NonNullable<typeof tone>, string> = {
    red: 'bg-ios-red text-white',
    green: 'bg-ios-green text-white',
    orange: 'bg-ios-orange text-white',
    blue: 'bg-ios-blue text-white',
  };
  const activeClass = active
    ? tone
      ? activeToneMap[tone]
      : 'bg-ios-blue text-white'
    : 'bg-black/[0.05] dark:bg-white/[0.08] text-black/70 dark:text-white/80 hover:bg-black/[0.08] dark:hover:bg-white/[0.12]';
  return (
    <button
      onClick={onClick}
      className={`text-[11px] font-medium px-2 py-0.5 rounded-full transition-all active:scale-95 ${activeClass}`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className={`ml-1 ${active ? 'opacity-80' : 'opacity-60'}`}>· {count}</span>
      )}
    </button>
  );
}

function RuleList({
  title,
  emptyCopy,
  rules,
  onEdit,
  onToggle,
  onRemove,
}: {
  title: string;
  emptyCopy: string;
  rules: PermissionRule[];
  onEdit: (r: PermissionRule) => void;
  onToggle: (r: PermissionRule) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}): React.ReactElement {
  return (
    <div>
      <p className="section-label">{title}</p>
      {rules.length === 0 ? (
        <div className="glass-card px-4 py-6 text-center mt-2">
          <p className="text-[12px] text-muted">{emptyCopy}</p>
        </div>
      ) : (
        <div className="space-y-2 mt-2">
          {rules.map((rule) => (
            <div key={rule.id} className="glass-card px-3 py-2.5 flex items-center gap-3">
              <span
                className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  rule.decision === 'deny'
                    ? 'bg-ios-red/15 text-ios-red'
                    : rule.decision === 'ask'
                      ? 'bg-ios-orange/15 text-ios-orange'
                      : 'bg-ios-green/15 text-ios-green'
                }`}
              >
                {rule.decision}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <code className="text-[12px] font-mono text-black dark:text-white truncate">
                    {rule.raw}
                  </code>
                  {rule.source === 'claude-code' && (
                    <span
                      className="text-[9px] font-semibold uppercase tracking-wider px-1 py-0.5 rounded bg-ios-blue/10 text-ios-blue flex-shrink-0"
                      title="Imported from Claude Code's ~/.claude/settings.json"
                    >
                      cc
                    </span>
                  )}
                  {rule.projectScope && (
                    <span
                      className="text-[9px] font-mono px-1 py-0.5 rounded bg-black/[0.06] dark:bg-white/[0.08] text-black/70 dark:text-white/70 flex-shrink-0 truncate max-w-[160px]"
                      title={`Scope: ${rule.projectScope}`}
                    >
                      {rule.projectScope}
                    </span>
                  )}
                </div>
                {rule.note && (
                  <p className="text-[10px] text-muted truncate leading-snug">{rule.note}</p>
                )}
              </div>
              <label className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={() => void onToggle(rule)}
                  className="accent-ios-blue w-3.5 h-3.5"
                />
              </label>
              <button
                onClick={() => onEdit(rule)}
                className="text-muted hover:text-ios-blue transition-colors active:scale-90"
                title="Edit rule"
                aria-label="Edit rule"
              >
                <Pencil size={12} strokeWidth={2.2} />
              </button>
              <button
                onClick={() => void onRemove(rule.id)}
                className="text-muted hover:text-ios-red transition-colors active:scale-90"
                title="Delete rule"
                aria-label="Delete rule"
              >
                <Trash2 size={12} strokeWidth={2.2} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionRadio({
  value,
  onChange,
}: {
  value: PermissionDecision;
  onChange: (v: PermissionDecision) => void;
}): React.ReactElement {
  return (
    <div>
      <p className="text-[11px] text-muted mb-1">Decision</p>
      <div className="flex gap-2">
        {(['deny', 'allow'] as PermissionDecision[]).map((d) => (
          <button
            key={d}
            onClick={() => onChange(d)}
            className={`flex-1 text-[12px] font-semibold px-3 py-1.5 rounded-full transition-all ${
              value === d
                ? d === 'deny'
                  ? 'bg-ios-red text-white'
                  : 'bg-ios-green text-white'
                : 'bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white'
            }`}
          >
            {d === 'deny' ? 'Deny' : 'Allow'}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ParsedRaw {
  decision: PermissionDecision;
  tool: string;
  pattern: string | null;
  canonicalRaw: string;
}

function parseRawForm(raw: string): ParsedRaw | { error: string } {
  const trimmed = raw.trim();
  const m = /^(allow|deny)\s+(.+)$/i.exec(trimmed);
  if (!m) return { error: 'Expected "allow <rule>" or "deny <rule>"' };
  const decisionToken = m[1];
  const body = m[2];
  if (!decisionToken || !body) return { error: 'Expected "allow <rule>" or "deny <rule>"' };
  const decision = decisionToken.toLowerCase() as PermissionDecision;
  const parenIdx = body.indexOf('(');
  if (parenIdx === -1) {
    return { decision, tool: body, pattern: null, canonicalRaw: body };
  }
  if (!body.endsWith(')')) return { error: 'Missing closing ")"' };
  const tool = body.slice(0, parenIdx).trim();
  const pattern = body.slice(parenIdx + 1, -1);
  if (!tool) return { error: 'Missing tool name before "("' };
  if (!pattern) return { error: 'Empty parentheses: drop them for a whole-tool rule' };
  return { decision, tool, pattern, canonicalRaw: `${tool}(${pattern})` };
}
