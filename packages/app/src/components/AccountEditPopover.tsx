import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { AccountInfo } from '@sentinel/shared';
import { sendToSentinel } from '../lib/ipc.js';

interface Props {
  account: AccountInfo;
  onClose: () => void;
}

/**
 * Edit an account's user-maintained metadata: display name and organization
 * label. Setup-token accounts can't derive either from the API (the token is
 * inference-only), so this is the only way to correct a typo'd name or fill
 * in the org after enrollment. Mirrors AccountColorPicker's overlay shape;
 * persistence goes through the same `update_account` IPC message, and the
 * daemon's `account_updated` broadcast refreshes the card.
 */
export default function AccountEditPopover({ account, onClose }: Props): React.ReactElement {
  const [name, setName] = useState(account.displayName || account.email);
  const [orgName, setOrgName] = useState(account.orgName);
  const [saving, setSaving] = useState(false);

  const dirty =
    name.trim() !== (account.displayName || account.email) || orgName.trim() !== account.orgName;
  const valid = name.trim().length > 0;

  const save = async (): Promise<void> => {
    if (!valid || !dirty) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await sendToSentinel({
        type: 'update_account',
        accountId: account.id,
        displayName: name.trim(),
        orgName: orgName.trim(),
      });
    } finally {
      setSaving(false);
      onClose();
    }
  };

  return (
    <div className="absolute inset-0 bg-black/40 z-40 flex items-center justify-center p-3">
      <div className="bg-white dark:bg-[#1E1E1E] rounded-2xl shadow-card max-w-[380px] w-full max-h-full overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5">
          <h2 className="text-[14px] font-semibold text-black dark:text-white truncate pr-2">
            Edit account · {account.displayName || account.email}
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
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
              }}
              disabled={saving}
              className="w-full text-[12px] px-2.5 py-1.5 rounded-lg bg-[#F2F2F7] dark:bg-[#2A2A2A] text-black dark:text-white outline-none focus:ring-2 focus:ring-ios-blue/40 disabled:opacity-50"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted">Organization</span>
            <input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
              }}
              placeholder="Optional"
              disabled={saving}
              className="w-full text-[12px] px-2.5 py-1.5 rounded-lg bg-[#F2F2F7] dark:bg-[#2A2A2A] text-black dark:text-white outline-none focus:ring-2 focus:ring-ios-blue/40 disabled:opacity-50"
            />
          </label>
          <p className="text-[10px] leading-snug text-muted">
            Setup tokens can't read your profile, so the name and organization shown here are yours
            to maintain.
          </p>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={saving}
              className="text-[11px] font-medium px-3 py-1.5 rounded-lg text-muted hover:text-black dark:hover:text-white transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving || !valid}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
