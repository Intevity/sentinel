import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Loader2, Pencil } from 'lucide-react';
import type { PermissionRule, PermissionDecision, PermissionRuleSource } from '@sentinel/shared';
import { usePermissionRules } from '../hooks/usePermissionRules.js';
import { sendToSentinel } from '../lib/ipc.js';
import { FilterChip } from './FilterChip.js';
import { SearchInput } from './settings/primitives.js';

/**
 * Inline tool-permission allow/deny rules editor. Lives in the Settings ›
 * Security › Permissions sub-tab (the single source of truth for security
 * config); replaces the old standalone SecurityRulesOverlay modal. Self-
 * contained: pulls its own rules via usePermissionRules.
 */
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

type DecisionFilter = 'all' | PermissionDecision;
type SourceFilter = 'all' | PermissionRuleSource;

export default function PermissionRulesPanel(): React.ReactElement {
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
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search tool, pattern, or note"
              />
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

// ─── Shared empty-state & onboarding ───────────────────────────────────────

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
