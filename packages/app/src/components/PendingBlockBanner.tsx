import React, { useState } from 'react';
import { Shield, ShieldAlert, ShieldX, ShieldCheck, X } from 'lucide-react';
import type { PendingSecurityBlock, SecuritySeverity } from '@claude-sentinel/shared';
import { usePendingSecurityBlocks } from '../hooks/usePendingSecurityBlocks.js';
import { orderedToolInputRows } from '../lib/toolInputFields.js';

const SEVERITY_ICON: Record<SecuritySeverity, typeof Shield> = {
  low: Shield,
  medium: ShieldAlert,
  high: ShieldX,
};

const SEVERITY_RING: Record<SecuritySeverity, string> = {
  low: 'ring-ios-green/30',
  medium: 'ring-ios-orange/30',
  high: 'ring-ios-red/40',
};

const SEVERITY_BG: Record<SecuritySeverity, string> = {
  low: 'bg-ios-green/[0.08] dark:bg-ios-green/[0.12]',
  medium: 'bg-ios-orange/[0.08] dark:bg-ios-orange/[0.12]',
  high: 'bg-ios-red/[0.08] dark:bg-ios-red/[0.12]',
};

const SEVERITY_ICON_COLOR: Record<SecuritySeverity, string> = {
  low: 'text-ios-green',
  medium: 'text-ios-orange',
  high: 'text-ios-red',
};

function formatCountdown(sec: number): string {
  if (sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Renders one banner per pending outbound-block held by the proxy. The banner
 * shows a live countdown and Approve / Deny buttons. Approving adds the
 * match to the allowlist AND releases the held upstream request; denying
 * synthesizes the 403 immediately.
 *
 * Mounted once in App.tsx above the tab bar so the user sees it regardless
 * of which tab they're currently viewing.
 */
export default function PendingBlockBanner(): React.ReactElement | null {
  const { pending, approve, deny, secondsRemaining } = usePendingSecurityBlocks();
  if (pending.length === 0) return null;

  return (
    <div className="mx-4 mt-1 mb-1 space-y-2">
      {pending.map((entry) => (
        <PendingRow
          key={entry.pendingId}
          entry={entry}
          remaining={secondsRemaining(entry.pendingId)}
          onApprove={(opts) => void approve(entry.pendingId, opts)}
          onDeny={() => void deny(entry.pendingId)}
        />
      ))}
    </div>
  );
}

interface PendingRowProps {
  entry: PendingSecurityBlock;
  remaining: number;
  onApprove: (opts?: { addBypass?: boolean }) => void | Promise<void>;
  onDeny: () => void | Promise<void>;
}

function PendingRow({ entry, remaining, onApprove, onDeny }: PendingRowProps): React.ReactElement {
  const [busy, setBusy] = useState<null | 'approve' | 'deny'>(null);
  // Only the tool_use permission path has a hashable input; the
  // scanner variant has its own implicit allowlist-on-approve, and
  // `permissions_strip` doesn't see tool inputs (the tool
  // advertisement is what's being blocked, not a specific call).
  // Default off — explicit user opt-in.
  const canBypass = entry.source === 'permissions_tool_use';
  const [addBypass, setAddBypass] = useState(false);
  const Icon = SEVERITY_ICON[entry.severity];

  const handleDeny = async (): Promise<void> => {
    setBusy('deny');
    try {
      await onDeny();
    } finally {
      setBusy(null);
    }
  };
  const handleApprove = async (): Promise<void> => {
    setBusy('approve');
    try {
      await onApprove(canBypass && addBypass ? { addBypass: true } : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={`rounded-2xl ring-1 ${SEVERITY_RING[entry.severity]} ${SEVERITY_BG[entry.severity]} p-3`}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-white/60 dark:bg-black/30 flex items-center justify-center">
          <Icon size={15} className={SEVERITY_ICON_COLOR[entry.severity]} strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[13px] font-semibold text-black dark:text-white truncate">
              Sentinel blocked: {entry.title}
            </p>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-black/10 dark:bg-white/15 text-black/70 dark:text-white/80 tabular-nums">
              {formatCountdown(remaining)}
            </span>
          </div>
          <p className="text-[11px] text-[#8E8E93] mt-0.5 leading-snug">
            {canBypass
              ? 'Approve to forward this call. Deny to refuse it. Approval expires automatically.'
              : 'Approve to forward this request and allow this match in the future. Deny to refuse it now. Approval expires automatically.'}
          </p>
          {entry.matchMask && (
            <code className="inline-block mt-1.5 text-[10px] font-mono bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded">
              {entry.matchMask}
            </code>
          )}
          {entry.toolInputFields && (
            <div className="mt-1.5 space-y-1">
              {orderedToolInputRows(entry.toolInputFields).map(({ key, value }) => (
                <div key={key} className="flex items-start gap-1.5 text-[10px] font-mono">
                  <span className="flex-shrink-0 text-black/50 dark:text-white/45 select-none">
                    {key}
                  </span>
                  <span className="flex-1 min-w-0 bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded break-all whitespace-pre-wrap">
                    {value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Quick-dismiss X — same effect as letting the timer expire,
            for users who want to get rid of the banner fast without
            hunting for the Deny button below. Reuses the deny path. */}
        <button
          onClick={handleDeny}
          disabled={busy !== null}
          className="flex-shrink-0 w-6 h-6 rounded-full text-[#8E8E93] hover:bg-black/10 dark:hover:bg-white/10 active:scale-90 transition-all disabled:opacity-40 flex items-center justify-center"
          title="Dismiss: same effect as letting the timer run out"
          aria-label="Dismiss"
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      </div>
      {canBypass && (
        <label className="mt-2 flex items-center gap-1.5 text-[11px] text-black/75 dark:text-white/75 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={addBypass}
            onChange={(e) => setAddBypass(e.target.checked)}
            disabled={busy !== null}
            className="accent-ios-blue"
          />
          <span>Always allow this exact input (skip banner next time)</span>
        </label>
      )}
      <div className="flex items-center justify-end gap-2 mt-3">
        <button
          onClick={handleDeny}
          disabled={busy !== null}
          className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full text-ios-red hover:bg-ios-red/10 active:scale-95 transition-all disabled:opacity-40"
          title="Deny: synthesize a 403 now"
        >
          <X size={12} strokeWidth={2.5} />
          Deny
        </button>
        <button
          onClick={handleApprove}
          disabled={busy !== null}
          className="flex items-center gap-1 text-[12px] font-semibold px-3 py-1.5 rounded-full bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all disabled:opacity-40"
          title={
            canBypass && addBypass
              ? 'Approve this call and add a bypass so future identical calls skip the banner'
              : 'Approve: forward upstream'
          }
        >
          <ShieldCheck size={13} strokeWidth={2.5} />
          {busy === 'approve' ? 'Approving…' : canBypass ? 'Approve' : 'Approve & allow'}
        </button>
      </div>
    </div>
  );
}
