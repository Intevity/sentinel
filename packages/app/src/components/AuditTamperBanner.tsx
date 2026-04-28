import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { useDaemon } from '../hooks/useDaemon.js';

/**
 * Sprint 8 — surfaces a chain-integrity break in the audit log. Renders
 * only when the daemon's startup or 24h walker has emitted
 * `audit_log_tampered`. The banner is intentionally permanent (no
 * dismiss button): a tampered audit log is a security incident, not a
 * notification the user should snooze.
 */
export default function AuditTamperBanner(): React.JSX.Element | null {
  const { auditTamper } = useDaemon();
  if (!auditTamper) return null;
  return (
    <div className="mx-4 mt-3 mb-1 px-3 py-2 rounded-xl bg-ios-red/[0.10] dark:bg-ios-red/[0.16] ring-1 ring-ios-red/30">
      <div className="flex items-start gap-2">
        <ShieldAlert size={16} className="text-ios-red mt-[1px] shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-semibold text-ios-red leading-snug">
            Audit log integrity check failed
          </p>
          <p className="text-[11px] text-black/80 dark:text-white/80 leading-snug mt-0.5">
            Row id {auditTamper.brokenAtRowId}: {auditTamper.reason}. Contact support.
          </p>
        </div>
      </div>
    </div>
  );
}
