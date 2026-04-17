import React from 'react';
import type { OAuthAccount } from '@claude-sentinel/shared';

interface AccountChipProps {
  account: OAuthAccount | null;
}

/**
 * A compact pill shown above non-Accounts tab content, so the user always
 * knows which account's data is on screen. Usage/Metrics/Overage/Notifications
 * are all scoped to the active account.
 */
export default function AccountChip({ account }: AccountChipProps): React.ReactElement | null {
  if (!account) return null;
  const display = account.displayName || account.emailAddress;
  const org = account.organizationName;

  return (
    <div className="pt-1 pb-2">
      <div className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.05] dark:bg-white/[0.07] px-2.5 py-[3px]">
        <span className="text-[9px] text-[#8E8E93] uppercase tracking-wider font-semibold">Showing</span>
        <span className="text-[11px] font-semibold text-black dark:text-white">{display}</span>
        {org && (
          <>
            <span className="text-[11px] text-[#8E8E93]">·</span>
            <span className="text-[11px] text-[#8E8E93]">{org}</span>
          </>
        )}
      </div>
    </div>
  );
}
