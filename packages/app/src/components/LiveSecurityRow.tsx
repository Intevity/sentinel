import React, { useState } from 'react';
import { Shield, ShieldAlert, ShieldX, ShieldCheck, X } from 'lucide-react';
import type { PendingSecurityBlock, SecuritySeverity } from '@sentinel/shared';
import { orderedToolInputRows } from '../lib/toolInputFields.js';
import HighlightedSnippet from './HighlightedSnippet.js';

/**
 * Renders one live pending security block as a pinned row at the top of
 * the Security tab. Replaces the old top-of-screen banner so every
 * security surface lives in one place. Same controls as before
 * (countdown, Approve with mode picker, Deny) but inline with the
 * history list.
 */
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

function formatProvenance(createdAt: number, source: 'local' | 'claude-code'): string {
  const ageMs = Date.now() - createdAt;
  const minutes = Math.floor(ageMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  let when: string;
  if (days >= 1) when = days === 1 ? '1 day ago' : `${days} days ago`;
  else if (hours >= 1) when = hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  else if (minutes >= 1) when = minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  else when = 'just now';
  const origin = source === 'claude-code' ? 'via Claude Code' : 'by you';
  return `Rule added ${when} ${origin}`;
}

type ApproveMode = 'once' | 'session' | 'always';

export interface LiveSecurityRowProps {
  entry: PendingSecurityBlock;
  remaining: number;
  onApprove: (opts?: { mode?: ApproveMode }) => void | Promise<void>;
  onDeny: () => void | Promise<void>;
}

export default function LiveSecurityRow({
  entry,
  remaining,
  onApprove,
  onDeny,
}: LiveSecurityRowProps): React.ReactElement {
  const [busy, setBusy] = useState<null | 'approve' | 'deny'>(null);
  // Only the tool_use permission path supports the durable
  // "session" / "always" modes. The scanner variant has its own
  // implicit allowlist-on-approve path; `permissions_strip`
  // doesn't have a stable per-input key. The radio is hidden for
  // those sources.
  const canPickMode = entry.source === 'permissions_tool_use';
  const [mode, setMode] = useState<ApproveMode>('once');
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
      await onApprove(canPickMode ? { mode } : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      id={`security-pending-${entry.pendingId}`}
      className={`rounded-2xl ring-1 ${SEVERITY_RING[entry.severity]} ${SEVERITY_BG[entry.severity]} p-3`}
      role="alert"
      data-testid="live-security-row"
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-surface-overlay/60 dark:bg-black/30 flex items-center justify-center">
          <Icon size={15} className={SEVERITY_ICON_COLOR[entry.severity]} strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-ios-orange text-white tabular-nums"
              data-testid="status-pill"
            >
              Pending · {formatCountdown(remaining)}
            </span>
            <p className="text-[13px] font-semibold text-black dark:text-white truncate">
              {entry.title}
            </p>
          </div>
          <p className="text-[11px] text-muted mt-0.5 leading-snug">
            {canPickMode
              ? 'Approve to forward this call. Deny to refuse it. Approval expires automatically.'
              : 'Approve to forward this request and allow this match in the future. Deny to refuse it now. Approval expires automatically.'}
          </p>
          {entry.provenance && (
            <p className="text-[10px] text-muted/80 mt-1 leading-snug italic">
              {formatProvenance(entry.provenance.createdAt, entry.provenance.source)}
            </p>
          )}
          {entry.recentApproveCount !== undefined && entry.recentApproveCount >= 5 && (
            <div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-ios-orange/10 border border-ios-orange/20 px-2 py-1 text-[10px] text-ios-orange">
              <span className="font-semibold">
                Approved {entry.recentApproveCount} times in the last 5 minutes:
              </span>
              <span className="text-ios-orange/90">consider editing the rule in Settings.</span>
            </div>
          )}
          {entry.matchMask && (
            <code className="inline-block mt-1.5 text-[10px] font-mono bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded">
              {entry.matchMask}
            </code>
          )}
          {entry.snippet && (
            <div className="mt-1.5 text-[10px] leading-snug">
              <span className="text-muted">Context: </span>
              <HighlightedSnippet text={entry.snippet} />
            </div>
          )}
          {entry.sourceHint && (
            <div className="mt-1 text-[10px] text-muted truncate" title={entry.sourceHint}>
              Source: <code className="font-mono">{entry.sourceHint}</code>
            </div>
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
        {/* Quick-dismiss X. Same effect as letting the timer expire,
            for users who want to get rid of the row fast. Reuses deny. */}
        <button
          onClick={handleDeny}
          disabled={busy !== null}
          className="flex-shrink-0 w-6 h-6 rounded-full text-muted hover:bg-black/10 dark:hover:bg-surface-overlay/10 active:scale-90 transition-all disabled:opacity-40 flex items-center justify-center"
          title="Dismiss: same effect as letting the timer run out"
          aria-label="Dismiss"
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      </div>
      {canPickMode && (
        <fieldset
          className="mt-2 flex items-center gap-1 text-[11px] text-black/75 dark:text-white/75"
          aria-label="Approval scope"
        >
          {(['once', 'session', 'always'] as const).map((m) => (
            <label
              key={m}
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md cursor-pointer select-none border transition-colors ${
                mode === m
                  ? 'bg-ios-blue/10 border-ios-blue text-ios-blue'
                  : 'border-transparent bg-black/[0.03] dark:bg-white/[0.05] hover:border-black/10 dark:hover:border-border-subtle/15'
              }`}
              title={
                m === 'once'
                  ? 'Approve only this single call'
                  : m === 'session'
                    ? 'Approve every matching call in this Claude Code session for the next 12 hours'
                    : 'Approve and stop asking about anything else matching this rule'
              }
            >
              <input
                type="radio"
                name={`approve-mode-${entry.pendingId}`}
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
                disabled={busy !== null}
                className="sr-only"
              />
              <span className="font-medium capitalize">
                {m === 'once' ? 'Once' : m === 'session' ? 'For session' : 'Always'}
              </span>
            </label>
          ))}
        </fieldset>
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
            canPickMode
              ? mode === 'always'
                ? 'Approve and add a permanent bypass'
                : mode === 'session'
                  ? 'Approve for this session (12h)'
                  : 'Approve only this call'
              : 'Approve: forward upstream'
          }
        >
          <ShieldCheck size={13} strokeWidth={2.5} />
          {busy === 'approve' ? 'Approving…' : canPickMode ? 'Approve' : 'Approve & allow'}
        </button>
      </div>
    </div>
  );
}
