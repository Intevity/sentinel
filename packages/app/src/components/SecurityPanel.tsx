import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Shield, ShieldAlert, ShieldX, Check, CheckCheck, Trash2, ShieldOff, FolderOpen, Terminal, MessageSquare, Settings2, Info } from 'lucide-react';
import type { SecurityEvent, SecuritySeverity, SecurityKind } from '@claude-sentinel/shared';
import { useSecurityEvents } from '../hooks/useSecurityEvents.js';
import { useSettings } from '../hooks/useSettings.js';

/** Inline two-click confirm: first click transitions into `pending`
 *  state which reverts after `timeoutMs`. Second click while pending
 *  fires the action. Used instead of browser confirm() because Tauri
 *  webview suppresses native confirm dialogs in some configurations. */
function useConfirmButton(action: () => void | Promise<void>, timeoutMs = 4000): {
  pending: boolean;
  trigger: () => void;
  cancel: () => void;
} {
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);
  const trigger = (): void => {
    if (!pending) {
      setPending(true);
      timerRef.current = setTimeout(() => setPending(false), timeoutMs);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setPending(false);
    void action();
  };
  const cancel = (): void => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setPending(false);
  };
  return { pending, trigger, cancel };
}

interface SecurityPanelProps {
  viewAccountId?: string | undefined;
  /** Opens the Settings panel and smooth-scrolls to the given anchor id.
   *  Invoked from the "Enable in Settings" button when scanning is off. */
  onRequestOpenSettings?: (target: string) => void;
}

const SEVERITY_META: Record<SecuritySeverity, { Icon: typeof Shield; color: string; bg: string; label: string }> = {
  low:    { Icon: Shield,      color: 'text-ios-green',  bg: 'bg-ios-green/10',  label: 'LOW' },
  medium: { Icon: ShieldAlert, color: 'text-ios-orange', bg: 'bg-ios-orange/10', label: 'MEDIUM' },
  high:   { Icon: ShieldX,     color: 'text-ios-red',    bg: 'bg-ios-red/10',    label: 'HIGH' },
};

const KIND_LABEL: Record<SecurityKind, string> = {
  secret: 'Secret',
  pii: 'PII',
  prompt_injection: 'Injection',
  risky_bash: 'Risky Bash',
  risky_write: 'Risky Write',
  risky_webfetch: 'Risky WebFetch',
  scan_truncated: 'Scan Truncated',
  scan_skipped_encoding: 'Scan Skipped',
  scan_deferred_oversized: 'Scan Deferred',
};

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts));
}

/**
 * Heuristic: does the scanner's sourceHint look like a filesystem path?
 * File-path hints are surfaced with a folder icon so the user can tell
 * "Claude Code read this file and it contained a secret" at a glance,
 * as opposed to the opaque `messages[354].tool_result[2]` JSON-index
 * fallback the scanner emits when the originating file isn't
 * recoverable.
 */
function isFilePath(hint: string): boolean {
  return /^\//.test(hint) || /^~\//.test(hint) || /^[a-zA-Z]:\\/.test(hint);
}

/** Visual + semantic metadata per provenance category. Drives the
 *  "Origin:" row in the expanded detail. */
const PROVENANCE_META: Record<
  NonNullable<SecurityEvent['provenance']>,
  { label: string; Icon: typeof FolderOpen; color: string; bg: string }
> = {
  'file-read':     { label: 'File read',        Icon: FolderOpen,     color: 'text-ios-green',  bg: 'bg-ios-green/10' },
  'tool-use':      { label: 'Tool use',         Icon: Terminal,       color: 'text-ios-blue',   bg: 'bg-ios-blue/10'  },
  'conversation':  { label: 'Conversation',     Icon: MessageSquare,  color: 'text-[#8E8E93]',  bg: 'bg-[#8E8E93]/10' },
  'system-prompt': { label: 'System prompt',    Icon: Settings2,      color: 'text-[#8E8E93]',  bg: 'bg-[#8E8E93]/10' },
  'telemetry':     { label: 'Scanner telemetry', Icon: Info,          color: 'text-[#8E8E93]',  bg: 'bg-[#8E8E93]/10' },
};

function ProvenanceBadge({ provenance }: { provenance: SecurityEvent['provenance'] }): React.ReactElement {
  const meta = PROVENANCE_META[provenance];
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${meta.bg} ${meta.color}`}>
      <meta.Icon size={10} strokeWidth={2.2} />
      {meta.label}
    </span>
  );
}

type SeverityFilter = 'all' | SecuritySeverity;
type KindFilter = 'all' | SecurityKind;

export default function SecurityPanel({ viewAccountId, onRequestOpenSettings }: SecurityPanelProps): React.ReactElement {
  const { settings } = useSettings();
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [includeWeakSignals, setIncludeWeakSignals] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { events, loading, error, acknowledge, acknowledgeAll, clearAll, addToAllowlist } = useSecurityEvents({
    ...(viewAccountId !== undefined ? { accountId: viewAccountId } : {}),
    includeWeakSignals,
  });

  const clearConfirm = useConfirmButton(clearAll);

  // NOTE: all hooks must run unconditionally before any early return below.
  // React error #300 ("Rendered fewer hooks than expected") fires if a
  // render path skips a hook that a previous render called.
  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (severityFilter !== 'all' && e.severity !== severityFilter) return false;
      if (kindFilter !== 'all' && e.kind !== kindFilter) return false;
      return true;
    });
  }, [events, severityFilter, kindFilter]);

  const kindsInView = useMemo(() => {
    const s = new Set<SecurityKind>();
    for (const e of events) s.add(e.kind);
    return Array.from(s);
  }, [events]);

  // Disabled-state early return. If the user has turned scanning off (or
  // flipped the master toggle during a session), give them a clear cue
  // plus a one-click path back to Settings. `settings` is undefined while
  // loading; fall through to the normal list in that case so the panel
  // doesn't flash a disabled banner on mount.
  if (settings && !settings.securityScanEnabled) {
    return (
      <div className="space-y-2 pt-1">
        <div className="glass-card px-4 py-8 text-center">
          <ShieldOff size={28} className="mx-auto text-[#8E8E93] mb-2" strokeWidth={2} />
          <p className="text-[13px] font-semibold text-black dark:text-white">
            Security scanning is off
          </p>
          <p className="text-[11px] text-[#8E8E93] mt-1 leading-snug max-w-[320px] mx-auto">
            Outbound secrets, risky tool calls, and injection heuristics
            are not being checked. Enable scanning to start catching issues.
          </p>
          <button
            onClick={() => onRequestOpenSettings?.('security-enable-toggle')}
            disabled={!onRequestOpenSettings}
            className="mt-3 text-[12px] font-semibold px-3 py-1.5 rounded-full bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all disabled:opacity-40"
          >
            Enable in Settings →
          </button>
        </div>
      </div>
    );
  }

  const unreadCount = filtered.filter((e) => !e.acknowledged).length;

  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="section-label">Security</span>
          {unreadCount > 0 && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-ios-red text-white">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              onClick={() => void acknowledgeAll()}
              className="flex items-center gap-1 text-[11px] font-medium text-ios-blue hover:opacity-80 transition-opacity active:scale-95"
              title="Dismiss all"
            >
              <CheckCheck size={12} strokeWidth={2.5} />
              Dismiss
            </button>
          )}
          {events.length > 0 && (
            <button
              onClick={clearConfirm.trigger}
              className={`flex items-center gap-1 text-[11px] font-medium transition-opacity active:scale-95 ${
                clearConfirm.pending ? 'text-white bg-ios-red px-2 py-0.5 rounded-full' : 'text-ios-red hover:opacity-80'
              }`}
              title={clearConfirm.pending ? 'Click again to delete' : 'Clear all'}
            >
              <Trash2 size={12} strokeWidth={2.5} />
              {clearConfirm.pending ? 'Click again to delete' : 'Clear'}
            </button>
          )}
        </div>
      </div>

      <p className="text-[10px] text-[#8E8E93] leading-snug mb-2">
        Sentinel stores redacted fingerprints of findings, never the original secret text.
      </p>

      <div className="flex flex-wrap gap-1 mb-2">
        {(['all', 'high', 'medium', 'low'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSeverityFilter(s)}
            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
              severityFilter === s
                ? 'bg-ios-blue text-white'
                : 'bg-[#8E8E93]/10 text-[#8E8E93] hover:bg-[#8E8E93]/20'
            }`}
          >
            {s === 'all' ? 'All' : s.toUpperCase()}
          </button>
        ))}
      </div>

      {kindsInView.length > 1 && (
        <div className="flex flex-wrap gap-1 mb-2">
          <button
            onClick={() => setKindFilter('all')}
            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
              kindFilter === 'all'
                ? 'bg-ios-blue text-white'
                : 'bg-[#8E8E93]/10 text-[#8E8E93]'
            }`}
          >
            All Kinds
          </button>
          {kindsInView.map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
                kindFilter === k
                  ? 'bg-ios-blue text-white'
                  : 'bg-[#8E8E93]/10 text-[#8E8E93]'
              }`}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}

      <label className="flex items-center gap-2 text-[11px] text-[#8E8E93] mb-2">
        <input
          type="checkbox"
          checked={includeWeakSignals}
          onChange={(e) => setIncludeWeakSignals(e.target.checked)}
          className="w-3 h-3"
        />
        Show weak signals (confidence &lt; 0.7)
      </label>

      {error && (
        <div className="glass-card px-3 py-2 text-[11px] text-ios-red">{error}</div>
      )}

      {!loading && filtered.length === 0 && !error ? (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-black dark:text-white">No security events</p>
          <p className="text-[11px] text-[#8E8E93] mt-1">
            Outbound secrets and risky tool calls will appear here when detected.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((event) => (
            <SecurityRow
              key={event.id}
              event={event}
              expanded={expandedId === event.id}
              onToggle={() => setExpandedId(expandedId === event.id ? null : event.id)}
              onAcknowledge={() => void acknowledge(event.id)}
              onAllowlist={() => void addToAllowlist(event.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface SecurityRowProps {
  event: SecurityEvent;
  expanded: boolean;
  onToggle: () => void;
  onAcknowledge: () => void;
  onAllowlist: () => void;
}

function SecurityRow({ event, expanded, onToggle, onAcknowledge, onAllowlist }: SecurityRowProps): React.ReactElement {
  const allowConfirm = useConfirmButton(onAllowlist);
  const meta = SEVERITY_META[event.severity];
  const { Icon, color, bg, label } = meta;
  return (
    <div className={`glass-card transition-opacity duration-300 ${event.acknowledged ? 'opacity-45' : ''}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left p-3 flex items-start gap-3"
      >
        <div className={`flex-shrink-0 w-8 h-8 rounded-full ${bg} flex items-center justify-center`}>
          <Icon size={15} className={color} strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${bg} ${color}`}>
              {label}
            </span>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#8E8E93]/10 text-[#8E8E93]">
              {KIND_LABEL[event.kind]}
            </span>
            {event.blocked && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-ios-red text-white">
                BLOCKED
              </span>
            )}
            {event.occurrences > 1 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#8E8E93]/10 text-[#8E8E93]">
                ×{event.occurrences}
              </span>
            )}
          </div>
          <p className="text-[13px] font-semibold text-black dark:text-white leading-snug truncate">
            {event.title}
          </p>
          <p className="text-[10px] text-[#8E8E93]/70 mt-0.5">{formatDate(event.ts)}</p>
        </div>
        {!event.acknowledged && (
          <button
            onClick={(e) => { e.stopPropagation(); onAcknowledge(); }}
            className="flex-shrink-0 w-7 h-7 rounded-full bg-ios-blue/10 hover:bg-ios-blue/20 active:scale-90 transition-all flex items-center justify-center"
            title="Dismiss"
          >
            <Check size={13} className="text-ios-blue" strokeWidth={2.5} />
          </button>
        )}
      </button>

      {expanded && (
        <div className="border-t border-black/5 dark:border-white/5 px-3 py-2 space-y-1.5 text-[11px]">
          <div>
            <span className="text-[#8E8E93]">Reason:</span>{' '}
            <span className="text-black dark:text-white">{event.reason}</span>
          </div>
          {event.matchMask && (
            <div>
              <span className="text-[#8E8E93]">Match:</span>{' '}
              <code className="text-[10px] font-mono bg-[#8E8E93]/10 px-1 py-0.5 rounded">
                {event.matchMask}
              </code>
            </div>
          )}
          {event.snippet && (
            <div>
              <span className="text-[#8E8E93]">Context:</span>{' '}
              <code className="text-[10px] font-mono bg-[#8E8E93]/10 px-1 py-0.5 rounded break-all">
                {event.snippet}
              </code>
            </div>
          )}
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[#8E8E93] flex-shrink-0">Origin:</span>
            <ProvenanceBadge provenance={event.provenance} />
          </div>
          {!event.blocked
            && (event.provenance === 'conversation' || event.provenance === 'system-prompt')
            && event.kind !== 'risky_bash'
            && event.kind !== 'risky_write'
            && event.kind !== 'risky_webfetch' && (
              <p className="text-[10px] text-[#8E8E93] leading-snug -mt-0.5">
                Not blocked — Sentinel only blocks secret matches that come from a file Claude Code read or wrote.
                Matches in conversation text aren't treated as data exfiltration.
              </p>
            )}
          {event.sourceHint && (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[#8E8E93] flex-shrink-0">Source:</span>
              {isFilePath(event.sourceHint) ? (
                <>
                  <FolderOpen size={11} className="text-[#8E8E93] flex-shrink-0" strokeWidth={2} />
                  <code
                    className="text-[10px] font-mono bg-[#8E8E93]/10 px-1 py-0.5 rounded truncate min-w-0"
                    title={event.sourceHint}
                  >
                    {event.sourceHint}
                  </code>
                </>
              ) : (
                <code className="text-[10px] font-mono text-[#8E8E93] truncate min-w-0">
                  {event.sourceHint}
                </code>
              )}
            </div>
          )}
          <div>
            <span className="text-[#8E8E93]">Detector:</span>{' '}
            <code className="text-[10px] font-mono text-[#8E8E93]">{event.detectorId}</code>{' '}
            <span className="text-[#8E8E93]">(conf {event.confidence.toFixed(2)})</span>
          </div>
          <div className="pt-1.5 flex items-center justify-between gap-2">
            <p className="text-[10px] text-[#8E8E93] leading-snug flex-1 min-w-0">
              "Always allow" adds this exact match to your allowlist so future
              detections of the same value are silently suppressed.
            </p>
            <button
              onClick={(e) => { e.stopPropagation(); allowConfirm.trigger(); }}
              className={`flex-shrink-0 flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full transition-all active:scale-95 ${
                allowConfirm.pending
                  ? 'bg-ios-orange text-white'
                  : 'bg-ios-orange/10 text-ios-orange hover:bg-ios-orange/20'
              }`}
              title={allowConfirm.pending ? 'Click again to allow' : 'Suppress all future matches of this exact value'}
            >
              <ShieldOff size={10} strokeWidth={2.5} />
              {allowConfirm.pending ? 'Confirm?' : 'Always allow'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
