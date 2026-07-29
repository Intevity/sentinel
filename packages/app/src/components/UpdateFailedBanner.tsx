import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useFailedUpdate } from '../hooks/useFailedUpdate.js';
import { releaseUrlFor, failedUpdateHeadline, failedUpdateDetail } from '../lib/updateRecovery.js';

/**
 * Shown once after an update install that never landed.
 *
 * On Windows this banner is the ONLY way the user finds out: the updater
 * plugin exits the process after handing the installer to `ShellExecuteW`
 * without checking whether it launched, so the modal that started the install
 * is long gone and can never show an error. The Rust side detects the failure
 * on the next launch by comparing the running version against the marker it
 * wrote before the handoff.
 *
 * Deliberately amber, not red: nothing is broken — the user is simply still on
 * the older version, and the proxy kept working.
 */
export default function UpdateFailedBanner(): React.ReactElement | null {
  const { attempt, dismiss } = useFailedUpdate();

  if (attempt === null) return null;

  return (
    <div className="mx-4 mt-1 mb-1">
      <div className="rounded-2xl bg-ios-orange/[0.08] dark:bg-ios-orange/[0.12] ring-1 ring-ios-orange/20 p-3">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-ios-orange/10 flex items-center justify-center">
            <AlertTriangle size={15} className="text-ios-orange" strokeWidth={2} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-black dark:text-white">
              {failedUpdateHeadline(attempt)}
            </p>
            <p className="text-[11px] text-muted mt-0.5">{failedUpdateDetail(attempt)}</p>
            {attempt.artifact !== '' && (
              <p className="text-[10px] text-muted/70 mt-1 font-mono break-all">
                {attempt.artifact}
              </p>
            )}
          </div>
          <div className="flex-shrink-0 flex items-center gap-1.5">
            <button
              onClick={() => void openUrl(releaseUrlFor(attempt.targetVersion))}
              className="btn-primary"
            >
              Download
            </button>
            <button
              onClick={dismiss}
              aria-label="Dismiss"
              className="w-6 h-6 rounded-full flex items-center justify-center text-muted hover:bg-black/5 dark:hover:bg-white/10"
            >
              <X size={13} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
