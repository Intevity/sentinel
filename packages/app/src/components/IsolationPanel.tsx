import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { IsolationPolicy, Settings } from '@sentinel/shared';
import { Section, ToggleRow } from './settings/primitives.js';
import { useSandboxStatus } from '../hooks/useSandboxStatus.js';
import { sendToSentinel } from '../lib/ipc.js';

const EMPTY_POLICY: IsolationPolicy = {
  enabled: false,
  syncToClaudeCode: false,
  enforceCodeMode: false,
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
  credentials: { files: [], envVars: [] },
};

interface IsolationPanelProps {
  settings: Settings | null;
  updateSettings: (patch: Partial<Settings>) => Promise<unknown>;
}

/** Add/remove editor for a list of strings (domains, paths, env-var names). */
function StringListEditor(props: {
  label: string;
  placeholder: string;
  items: string[];
  onChange: (items: string[]) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const v = draft.trim();
    if (v === '' || props.items.includes(v)) {
      setDraft('');
      return;
    }
    props.onChange([...props.items, v]);
    setDraft('');
  };
  return (
    <div className="px-3 py-2">
      <div className="text-[11px] font-semibold text-black dark:text-white mb-1.5">
        {props.label}
      </div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {props.items.length === 0 && <span className="text-[11px] text-muted">None</span>}
        {props.items.map((item) => (
          <span
            key={item}
            className="inline-flex items-center gap-1 rounded-full bg-black/[0.05] dark:bg-white/[0.08] px-2 py-0.5 text-[11px]"
          >
            {item}
            <button
              type="button"
              onClick={() => props.onChange(props.items.filter((x) => x !== item))}
              className="text-muted hover:text-ios-red transition-colors"
              aria-label={`Remove ${item}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={props.placeholder}
          className="flex-1 rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1 text-[11px] outline-none focus:border-ios-blue"
        />
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1 rounded-md bg-ios-blue px-2 py-1 text-[11px] font-semibold text-white hover:opacity-90"
        >
          <Plus size={12} /> Add
        </button>
      </div>
    </div>
  );
}

/** First-enable reconciliation choice, mirroring the Claude Code sync modal. */
function FirstEnableSandboxModal(props: {
  onClose: () => void;
  onConfirm: (mode: 'merge' | 'import' | 'export') => void;
}): React.ReactElement {
  const choices: Array<{ mode: 'merge' | 'import' | 'export'; label: string; desc: string }> = [
    {
      mode: 'merge',
      label: 'Merge',
      desc: "Combine this policy with any existing sandbox block in Claude Code's settings.",
    },
    {
      mode: 'import',
      label: 'Import from Claude Code',
      desc: "Replace this policy's content with the existing settings.json sandbox block.",
    },
    {
      mode: 'export',
      label: 'Export to Claude Code',
      desc: 'Overwrite the settings.json sandbox block with this policy.',
    },
  ];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={props.onClose}
    >
      <div
        className="w-[340px] rounded-2xl bg-white dark:bg-neutral-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[13px] font-semibold mb-1">Enable Claude Code sandbox sync</div>
        <div className="text-[11px] text-muted mb-3">
          Choose how to reconcile with any sandbox settings Claude Code already has.
        </div>
        <div className="space-y-1.5">
          {choices.map((c) => (
            <button
              key={c.mode}
              type="button"
              onClick={() => props.onConfirm(c.mode)}
              className="w-full text-left rounded-lg border border-black/10 dark:border-white/15 px-3 py-2 hover:border-ios-blue transition-colors"
            >
              <div className="text-[12px] font-semibold text-ios-blue">{c.label}</div>
              <div className="text-[10px] text-muted">{c.desc}</div>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={props.onClose}
          className="mt-3 w-full text-[11px] text-muted hover:text-black dark:hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The "Isolation" tab of the security overlay: edits the canonical
 * {@link IsolationPolicy} (Sentinel's sandbox feature). Toggles drive Leg A
 * (sync to Claude Code's native sandbox) and Leg B (sandbox code-mode MCP
 * children); the list editors configure the shared network/filesystem/
 * credential policy. UI is not coverage-instrumented (packages/app/src/**).
 */
export default function IsolationPanel({
  settings,
  updateSettings,
}: IsolationPanelProps): React.ReactElement {
  const policy = settings?.isolationPolicy ?? EMPTY_POLICY;
  const { status, capability } = useSandboxStatus();
  const [firstEnableOpen, setFirstEnableOpen] = useState(false);

  const save = (next: IsolationPolicy): void => {
    void updateSettings({ isolationPolicy: next }).catch(() => undefined);
  };

  const handleSyncToggle = (v: boolean): void => {
    if (v && !policy.syncToClaudeCode) {
      setFirstEnableOpen(true);
      return;
    }
    save({ ...policy, syncToClaudeCode: v });
  };

  const confirmFirstEnable = (mode: 'merge' | 'import' | 'export'): void => {
    setFirstEnableOpen(false);
    save({ ...policy, syncToClaudeCode: true });
    // The engine's first-enable honors merge by default; for import/export we
    // additionally drive the reconciliation explicitly.
    if (mode !== 'merge') {
      void sendToSentinel({ type: 'sandbox_sync_pull', mode }).catch(() => undefined);
    }
  };

  return (
    <div className="space-y-3 overflow-y-auto">
      <Section title="Sandbox isolation">
        <ToggleRow
          label="Enable isolation policy"
          description="Master switch for OS-level sandboxing. Off by default."
          checked={policy.enabled}
          onChange={(v) => save({ ...policy, enabled: v })}
        />
        <ToggleRow
          label="Sync to Claude Code's sandbox"
          description="Write this policy into ~/.claude/settings.json so Claude Code's own native sandbox enforces it (Leg A)."
          checked={policy.syncToClaudeCode}
          onChange={handleSyncToggle}
        />
        <ToggleRow
          label="Sandbox code-mode MCP servers"
          description="Wrap Sentinel's own code-mode MCP child processes in the sandbox (Leg B)."
          checked={policy.enforceCodeMode}
          onChange={(v) => save({ ...policy, enforceCodeMode: v })}
        />
      </Section>

      {policy.syncToClaudeCode && status && (
        <div className="px-3 text-[11px] text-muted">
          Claude Code sync:{' '}
          <span className="font-semibold text-black dark:text-white">
            {status.active ? 'active' : 'inactive'}
          </span>
          {status.lastError && <span className="text-ios-red"> · {status.lastError}</span>}
        </div>
      )}

      {policy.enforceCodeMode && capability && (
        <div className="px-3 text-[11px] text-muted">
          Code-mode sandbox:{' '}
          <span
            className={`font-semibold ${
              capability.capability === 'unavailable'
                ? 'text-ios-red'
                : 'text-black dark:text-white'
            }`}
          >
            {capability.capability}
          </span>
          {capability.reasons.map((r, i) => (
            <div key={i} className="text-[10px] text-ios-orange">
              {r}
            </div>
          ))}
        </div>
      )}

      <Section title="Network">
        <StringListEditor
          label="Allowed domains"
          placeholder="example.com or *.example.com"
          items={policy.network.allowedDomains}
          onChange={(items) =>
            save({ ...policy, network: { ...policy.network, allowedDomains: items } })
          }
        />
        <StringListEditor
          label="Denied domains"
          placeholder="blocked.example.com"
          items={policy.network.deniedDomains}
          onChange={(items) =>
            save({ ...policy, network: { ...policy.network, deniedDomains: items } })
          }
        />
      </Section>

      <Section title="Filesystem">
        <StringListEditor
          label="Allow write"
          placeholder="~/.cache or /tmp/build"
          items={policy.filesystem.allowWrite}
          onChange={(items) =>
            save({ ...policy, filesystem: { ...policy.filesystem, allowWrite: items } })
          }
        />
        <StringListEditor
          label="Deny write"
          placeholder="/etc"
          items={policy.filesystem.denyWrite}
          onChange={(items) =>
            save({ ...policy, filesystem: { ...policy.filesystem, denyWrite: items } })
          }
        />
        <StringListEditor
          label="Deny read"
          placeholder="~/"
          items={policy.filesystem.denyRead}
          onChange={(items) =>
            save({ ...policy, filesystem: { ...policy.filesystem, denyRead: items } })
          }
        />
        <StringListEditor
          label="Allow read (within a denied region)"
          placeholder="."
          items={policy.filesystem.allowRead}
          onChange={(items) =>
            save({ ...policy, filesystem: { ...policy.filesystem, allowRead: items } })
          }
        />
      </Section>

      <Section title="Credentials (denied to sandboxed commands)">
        <StringListEditor
          label="Files"
          placeholder="~/.aws/credentials or ~/.ssh"
          items={policy.credentials.files}
          onChange={(items) =>
            save({ ...policy, credentials: { ...policy.credentials, files: items } })
          }
        />
        <StringListEditor
          label="Environment variables"
          placeholder="GITHUB_TOKEN"
          items={policy.credentials.envVars}
          onChange={(items) =>
            save({ ...policy, credentials: { ...policy.credentials, envVars: items } })
          }
        />
      </Section>

      {firstEnableOpen && (
        <FirstEnableSandboxModal
          onClose={() => setFirstEnableOpen(false)}
          onConfirm={confirmFirstEnable}
        />
      )}
    </div>
  );
}
