import React, { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import {
  validateApiKeyInput,
  validateWorkspaceIdInput,
  type AccountInfo,
  type StoreApiKeyResult,
} from '@sentinel/shared';
import { sendToSentinel } from '../lib/ipc.js';

interface ApiKeyFormProps {
  /** Called when the user cancels, and after the key is stored. */
  onClose: () => void;
  /** Replace this existing API-key account's key in place, keeping its name,
   *  settings and history (the card's "Replace key" action). */
  replaceAccount?: AccountInfo;
}

const INPUT =
  'w-full text-[12px] px-2.5 py-1.5 rounded-lg bg-[#F2F2F7] dark:bg-[#2A2A2A] text-black dark:text-white ' +
  'placeholder:text-muted/60 outline-none focus:ring-2 focus:ring-ios-blue/40 disabled:opacity-50';

/**
 * Add Account → API key. Takes an Anthropic API key from the Claude Console
 * (a personal or service-account key `sk-ant-usr…`, or a workspace key
 * `sk-ant-api…`). The daemon checks it against the API before storing it and
 * answers with the reason when it refuses, which is shown here so the user can
 * fix the key without retyping the rest. Success is also announced by the
 * daemon's `login_complete` broadcast, which AccountSwitcher turns into its
 * status message.
 */
export default function ApiKeyForm({
  onClose,
  replaceAccount,
}: ApiKeyFormProps): React.ReactElement {
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [orgName, setOrgName] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    if (saving) return;
    const key = validateApiKeyInput(apiKey);
    if (!key.ok) {
      setError(key.error);
      return;
    }
    const workspace = validateWorkspaceIdInput(workspaceId);
    if (!workspace.ok) {
      setError(workspace.error);
      return;
    }
    setError('');
    setSaving(true);
    try {
      const res = await sendToSentinel<StoreApiKeyResult>({
        type: 'store_api_key',
        apiKey: key.apiKey,
        ...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
        ...(replaceAccount
          ? { accountId: replaceAccount.id }
          : {
              ...(label.trim() ? { label: label.trim() } : {}),
              ...(orgName.trim() ? { orgName: orgName.trim() } : {}),
            }),
      });
      if (res.success) {
        onClose();
        return;
      }
      setError(res.error ?? 'Sentinel could not add the API key.');
    } catch (err) {
      setError(`Sentinel did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    setSaving(false);
  };

  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') void submit();
  };

  return (
    <div className="rounded-2xl bg-white dark:bg-[#1E1E1E] shadow-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5">
        <h2 className="text-[13px] font-semibold text-black dark:text-white truncate pr-2">
          {replaceAccount ? `Replace the API key for ${replaceAccount.email}` : 'Add an API key'}
        </h2>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-full hover:bg-muted/10 flex items-center justify-center flex-shrink-0"
          title="Close"
          aria-label="Close"
        >
          <X size={14} className="text-muted" />
        </button>
      </div>
      <div className="px-4 py-3 space-y-3">
        <p className="text-[11px] leading-snug text-muted">
          Create a key in the Claude Console under Settings → API keys. Personal keys start with{' '}
          <span className="font-mono whitespace-nowrap">sk-ant-usr</span>, workspace keys with{' '}
          <span className="font-mono whitespace-nowrap">sk-ant-api</span>.
        </p>
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-muted">API key</span>
          <input
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={onEnter}
            placeholder="sk-ant-…"
            disabled={saving}
            data-testid="api-key-input"
            className={`${INPUT} font-mono`}
          />
        </label>
        {!replaceAccount && (
          <>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted">Name</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={onEnter}
                placeholder="Work API key"
                disabled={saving}
                className={INPUT}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted">Organization (optional)</span>
              <input
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                onKeyDown={onEnter}
                disabled={saving}
                className={INPUT}
              />
            </label>
          </>
        )}
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-muted">Workspace ID (optional)</span>
          <input
            spellCheck={false}
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            onKeyDown={onEnter}
            placeholder="wrkspc_…"
            disabled={saving}
            className={`${INPUT} font-mono`}
          />
          <span className="block text-[10px] leading-snug text-muted">
            Only for a personal key that works in more than one workspace.
          </span>
        </label>
        <p className="text-[10px] leading-snug text-muted">
          Requests on this account bill to your API credits, not a subscription. In Auto mode,
          Sentinel uses it only when no subscription account has room.
        </p>
        {error && (
          <p role="alert" className="text-[11px] leading-snug text-ios-red">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            disabled={saving}
            className="text-[11px] font-medium px-3 py-1.5 rounded-lg text-muted hover:text-black dark:hover:text-white transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={saving || !apiKey.trim()}
            data-testid="api-key-submit"
            className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all disabled:opacity-40"
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            {saving ? 'Checking key…' : replaceAccount ? 'Replace key' : 'Add account'}
          </button>
        </div>
      </div>
    </div>
  );
}
