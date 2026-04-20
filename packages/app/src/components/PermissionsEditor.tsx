import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Loader2, Pencil, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { PermissionRule, PermissionDecision } from '@claude-sentinel/shared';
import { usePermissionRules } from '../hooks/usePermissionRules.js';
import { panelSlide } from '../lib/motion.js';

interface PermissionsEditorProps {
  onClose: () => void;
}

type Mode = 'form' | 'raw';

interface Draft {
  decision: PermissionDecision;
  tool: string;
  pattern: string;
  note: string;
  raw: string;
  mode: Mode;
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
};

/** Slide-over editor for tool-permission rules. Opens from SettingsPanel. */
export default function PermissionsEditor({ onClose }: PermissionsEditorProps): React.ReactElement {
  const { rules, loading, error, upsert, remove, toggle } = usePermissionRules();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    });
    setSaveError(null);
  };
  const cancel = (): void => { setDraft(null); setSaveError(null); };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { decision, tool, pattern, note, raw, mode } = draft;
      // In raw mode, prefer the raw input verbatim; in form mode, rebuild raw
      // from tool + pattern. The daemon validates either way.
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
      const saveInput = {
        decision: finalDecision,
        tool: finalTool,
        pattern: finalPattern,
        raw: finalRaw,
        note: note.trim() ? note : null,
        enabled: true,
      };
      await upsert(existing ? { id: existing.id, ...saveInput } : saveInput);
      setDraft(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const denies = useMemo(() => rules.filter((r) => r.decision === 'deny'), [rules]);
  const allows = useMemo(() => rules.filter((r) => r.decision === 'allow'), [rules]);

  return (
    <motion.div
      {...panelSlide}
      className="absolute inset-0 z-30 flex flex-col bg-[#F2F2F7] dark:bg-[#111111]"
    >
      <header className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-black/5 dark:border-white/5">
        <span className="text-[15px] font-semibold text-black dark:text-white tracking-tight">
          Tool permission rules
        </span>
        <button
          onClick={onClose}
          className="text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5"
          title="Close"
          aria-label="Close rules editor"
        >
          <X size={16} strokeWidth={2.2} />
        </button>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        <p className="text-[11px] text-[#8E8E93] leading-snug px-1">
          Rules are evaluated deny-first, then allow. The first matching rule wins.
          Example patterns:{' '}
          <code className="text-[10.5px]">Bash(rm -rf *)</code>,{' '}
          <code className="text-[10.5px]">WebFetch(domain:example.com)</code>,{' '}
          <code className="text-[10.5px]">Read(//etc/**)</code>,{' '}
          <code className="text-[10.5px]">mcp__github__*</code>.
        </p>

        {loading && (
          <div className="flex items-center justify-center py-6 gap-2 text-[#8E8E93]">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-[11px]">Loading rules…</span>
          </div>
        )}
        {!loading && error && <p className="text-[12px] text-ios-red px-1">{error}</p>}

        {!loading && !error && (
          <>
            <RuleList title="Deny rules" emptyCopy="No deny rules yet." rules={denies} onEdit={startEdit} onToggle={toggle} onRemove={remove} />
            <RuleList title="Allow rules" emptyCopy="No allow rules yet." rules={allows} onEdit={startEdit} onToggle={toggle} onRemove={remove} />

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
                <div className="flex items-center gap-2 text-[11px] text-[#8E8E93]">
                  <span>Mode:</span>
                  <button
                    onClick={() => setDraft((d) => d && { ...d, mode: 'form' })}
                    className={`px-2 py-0.5 rounded-full ${draft.mode === 'form' ? 'bg-ios-blue text-white' : ''}`}
                  >
                    Form
                  </button>
                  <button
                    onClick={() => setDraft((d) => d && { ...d, mode: 'raw', raw: d.pattern ? `${d.decision} ${d.tool}(${d.pattern})` : `${d.decision} ${d.tool}` })}
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
                      <p className="text-[11px] text-[#8E8E93] mb-1">Tool</p>
                      <select
                        value={BUILTIN_TOOLS.includes(draft.tool) ? draft.tool : '__custom__'}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDraft((d) => d && { ...d, tool: v === '__custom__' ? '' : v });
                        }}
                        className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue"
                      >
                        {BUILTIN_TOOLS.map((t) => (
                          <option key={t} value={t}>{t}</option>
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
                      <p className="text-[11px] text-[#8E8E93] mb-1">Pattern (optional)</p>
                      <input
                        value={draft.pattern}
                        onChange={(e) => setDraft((d) => d && { ...d, pattern: e.target.value })}
                        placeholder="npm *, rm -rf *, domain:example.com, //etc/**"
                        className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue font-mono"
                      />
                      <p className="text-[10px] text-[#8E8E93] mt-1">
                        Leave blank to match every call of <code>{draft.tool || '…'}</code>.
                      </p>
                    </div>
                  </>
                ) : (
                  <div>
                    <p className="text-[11px] text-[#8E8E93] mb-1">Raw rule</p>
                    <input
                      value={draft.raw}
                      onChange={(e) => setDraft((d) => d && { ...d, raw: e.target.value })}
                      placeholder="deny Bash(rm -rf *)"
                      className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue font-mono"
                    />
                    <p className="text-[10px] text-[#8E8E93] mt-1">
                      Format: <code>allow &lt;rule&gt;</code> or <code>deny &lt;rule&gt;</code>.
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-[11px] text-[#8E8E93] mb-1">Note (optional)</p>
                  <input
                    value={draft.note}
                    onChange={(e) => setDraft((d) => d && { ...d, note: e.target.value })}
                    placeholder="Why this rule exists"
                    className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-black dark:text-white border-none focus:outline-none focus:ring-1 focus:ring-ios-blue"
                  />
                </div>

                {saveError && (
                  <p className="text-[11px] text-ios-red">{saveError}</p>
                )}

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
                    className="text-[12px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors px-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </motion.div>
  );
}

function RuleList({
  title, emptyCopy, rules, onEdit, onToggle, onRemove,
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
          <p className="text-[12px] text-[#8E8E93]">{emptyCopy}</p>
        </div>
      ) : (
        <div className="space-y-2 mt-2">
          {rules.map((rule) => (
            <div key={rule.id} className="glass-card px-3 py-2.5 flex items-center gap-3">
              <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                rule.decision === 'deny' ? 'bg-ios-red/15 text-ios-red' : 'bg-ios-green/15 text-ios-green'
              }`}>
                {rule.decision}
              </span>
              <div className="flex-1 min-w-0">
                <code className="text-[12px] font-mono text-black dark:text-white block truncate">{rule.raw}</code>
                {rule.note && (
                  <p className="text-[10px] text-[#8E8E93] truncate leading-snug">{rule.note}</p>
                )}
              </div>
              <label className="flex items-center gap-1.5 text-[11px] text-[#8E8E93] cursor-pointer">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={() => void onToggle(rule)}
                  className="accent-ios-blue w-3.5 h-3.5"
                />
              </label>
              <button
                onClick={() => onEdit(rule)}
                className="text-[#8E8E93] hover:text-ios-blue transition-colors active:scale-90"
                title="Edit rule"
                aria-label="Edit rule"
              >
                <Pencil size={12} strokeWidth={2.2} />
              </button>
              <button
                onClick={() => void onRemove(rule.id)}
                className="text-[#8E8E93] hover:text-ios-red transition-colors active:scale-90"
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

function DecisionRadio({ value, onChange }: { value: PermissionDecision; onChange: (v: PermissionDecision) => void }): React.ReactElement {
  return (
    <div>
      <p className="text-[11px] text-[#8E8E93] mb-1">Decision</p>
      <div className="flex gap-2">
        {(['deny', 'allow'] as PermissionDecision[]).map((d) => (
          <button
            key={d}
            onClick={() => onChange(d)}
            className={`flex-1 text-[12px] font-semibold px-3 py-1.5 rounded-full transition-all ${
              value === d
                ? (d === 'deny' ? 'bg-ios-red text-white' : 'bg-ios-green text-white')
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

/** Lightweight client-side parse for the raw-mode text input. The daemon
 *  also validates on upsert, but this gives the user an immediate red flag
 *  without a round-trip. */
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
  if (!pattern) return { error: 'Empty parentheses — drop them for a whole-tool rule' };
  return { decision, tool, pattern, canonicalRaw: `${tool}(${pattern})` };
}
