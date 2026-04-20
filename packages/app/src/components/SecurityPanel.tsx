import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Shield, ShieldAlert, ShieldX, Check, CheckCheck, Trash2, ShieldOff, FolderOpen, Terminal, MessageSquare, Settings2, Info, ChevronDown, ChevronRight, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { SecurityEvent, SecuritySeverity, SecurityKind, AutoModeStatus } from '@claude-sentinel/shared';
import { useSecurityEvents } from '../hooks/useSecurityEvents.js';
import { useSettings } from '../hooks/useSettings.js';
import { useAutoModeStatus } from '../hooks/useAutoModeStatus.js';
import { QuickToggle, QuickSegmented, QuickChipToggle } from './settings/primitives.js';

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
  tool_permission_blocked: 'Tool Blocked',
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
  const { settings, update } = useSettings();
  const autoMode = useAutoModeStatus();
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [includeWeakSignals, setIncludeWeakSignals] = useState(false);
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
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
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
      if (severityFilter !== 'all' && e.severity !== severityFilter) return false;
      if (kindFilter !== 'all' && e.kind !== kindFilter) return false;
      if (q) {
        const hay = [e.title, e.reason, e.matchMask ?? '', e.sourceHint ?? '']
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [events, severityFilter, kindFilter, search]);

  const kindsInView = useMemo(() => {
    const s = new Set<SecurityKind>();
    for (const e of events) s.add(e.kind);
    return Array.from(s);
  }, [events]);

  // One-line chip shown next to "Filters" when collapsed so the user can see
  // what's narrowing the list without needing to expand.
  const activeFilterSummary = useMemo(() => {
    const parts: string[] = [];
    if (severityFilter !== 'all') parts.push(severityFilter.toUpperCase());
    if (kindFilter !== 'all') parts.push(KIND_LABEL[kindFilter as SecurityKind]);
    if (search.trim()) parts.push(`"${search.trim()}"`);
    if (includeWeakSignals) parts.push('incl. weak');
    return parts.join(' · ');
  }, [severityFilter, kindFilter, search, includeWeakSignals]);

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
          <div className="mt-3 flex items-center justify-center gap-2">
            <button
              onClick={() => void update({ securityScanEnabled: true }).catch(() => undefined)}
              className="text-[12px] font-semibold px-3 py-1.5 rounded-full bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all"
            >
              Turn on scanning
            </button>
            <button
              onClick={() => onRequestOpenSettings?.('security-enable-toggle')}
              disabled={!onRequestOpenSettings}
              className="text-[12px] font-medium text-ios-blue hover:opacity-80 transition-opacity active:scale-95 disabled:opacity-40"
            >
              Configure…
            </button>
          </div>
        </div>
      </div>
    );
  }

  const unreadCount = filtered.filter((e) => !e.acknowledged).length;

  return (
    <div className="space-y-2 pt-1">
      <AutoModeBanner status={autoMode} skipInAutoMode={settings?.toolPermissionSkipInAutoMode ?? true} />

      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="section-label">Security</span>
          {unreadCount > 0 && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-ios-red text-white">
              {unreadCount}
            </span>
          )}
          <span
            className="text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors cursor-help"
            title="Sentinel stores redacted fingerprints of findings, never the original secret text."
          >
            <Info size={11} strokeWidth={2.2} />
          </span>
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

      {/* Quick-access strip — always visible so common settings don't require
          opening Settings. The master "Scan" pill is always shown (so the
          user always has a one-click path to re-enable); enforcement +
          categories are gated behind `securityScanEnabled` to avoid
          offering no-op toggles. Writes flow through useSettings().update,
          exactly the same path as the full SettingsPanel controls. */}
      {settings && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <QuickToggle
            label="Scan"
            checked={settings.securityScanEnabled}
            onChange={(v) => void update({ securityScanEnabled: v }).catch(() => undefined)}
            title={settings.securityScanEnabled ? 'Security scanning is on' : 'Security scanning is off'}
          />
          {settings.securityScanEnabled && (
            <>
              <QuickSegmented
                ariaLabel="Enforcement mode"
                value={(settings.securityEnforcementMode ?? 'observe') as 'observe' | 'block_high' | 'block_medium_high'}
                onChange={(v) => void update({ securityEnforcementMode: v }).catch(() => undefined)}
                options={[
                  { value: 'observe',           label: 'Observe',  title: 'Record findings; never block' },
                  { value: 'block_high',        label: 'HIGH',     title: 'Block only HIGH-severity findings' },
                  { value: 'block_medium_high', label: 'MED+HIGH', title: 'Block MEDIUM and HIGH findings' },
                ]}
              />
              <span className="text-[10px] text-[#8E8E93]">·</span>
              <QuickChipToggle
                label="Secrets"
                active={settings.securityScanSecrets}
                onChange={(v) => void update({ securityScanSecrets: v }).catch(() => undefined)}
                title="Scan for API keys, tokens, private keys"
              />
              <QuickChipToggle
                label="Injection"
                active={settings.securityScanInjection}
                onChange={(v) => void update({ securityScanInjection: v }).catch(() => undefined)}
                title="Heuristic prompt-injection detection"
              />
              <QuickChipToggle
                label="Tool-use"
                active={settings.securityScanToolUse}
                onChange={(v) => void update({ securityScanToolUse: v }).catch(() => undefined)}
                title="Inspect proposed Bash / Write / WebFetch tool calls"
              />
            </>
          )}
        </div>
      )}

      {/* Collapsible filter section. Mirrors the Logs tab pattern: a chevron
          toggle, an inline summary showing active filters, and the full
          filter controls revealed on expand. */}
      <div className="mb-2">
        <button
          onClick={() => setFiltersOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-medium text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors active:scale-95"
          title={filtersOpen ? 'Hide filters' : 'Show filters'}
          aria-expanded={filtersOpen}
        >
          {filtersOpen
            ? <ChevronDown size={11} strokeWidth={2.5} />
            : <ChevronRight size={11} strokeWidth={2.5} />}
          <span>Filters</span>
          {activeFilterSummary && (
            <span className="text-[10px] text-ios-blue">· {activeFilterSummary}</span>
          )}
        </button>
        {filtersOpen && (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-1">
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
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setKindFilter('all')}
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
                    kindFilter === 'all'
                      ? 'bg-ios-blue text-white'
                      : 'bg-[#8E8E93]/10 text-[#8E8E93] hover:bg-[#8E8E93]/20'
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
                        : 'bg-[#8E8E93]/10 text-[#8E8E93] hover:bg-[#8E8E93]/20'
                    }`}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            )}

            <input
              type="text"
              placeholder="Search titles, reasons, sources…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full text-[11px] bg-[#8E8E93]/10 text-black dark:text-white rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ios-blue"
            />

            <label className="flex items-center gap-2 text-[11px] text-[#8E8E93]">
              <input
                type="checkbox"
                checked={includeWeakSignals}
                onChange={(e) => setIncludeWeakSignals(e.target.checked)}
                className="w-3 h-3 accent-ios-blue"
              />
              Show weak signals (confidence &lt; 0.7)
            </label>
          </div>
        )}
      </div>

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

function formatAgo(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function buildBannerCopy(
  status: AutoModeStatus,
  skipInAutoMode: boolean,
): { headline: string; meta: string } {
  const { activeSessions, autoModeSessions, source } = status;
  const sessionsLabel = (n: number): string => `${n} session${n === 1 ? '' : 's'}`;

  // When enforcement is NOT being skipped, the banner is informational: we
  // detected auto mode but Sentinel is still gating tool calls. Headline +
  // meta both reflect that.
  if (!skipInAutoMode) {
    if (source === 'manual' && autoModeSessions === 0) {
      return {
        headline: 'Auto mode · manual override',
        meta: activeSessions > 0 ? `${sessionsLabel(activeSessions)} tracked · still enforcing` : 'Still enforcing',
      };
    }
    if (autoModeSessions > 0 && autoModeSessions < activeSessions) {
      return {
        headline: `Auto mode detected · ${autoModeSessions} of ${activeSessions} sessions`,
        meta: 'Rules still enforced on every session',
      };
    }
    if (autoModeSessions === 1 && activeSessions === 1) {
      return { headline: 'Auto mode detected', meta: 'Rules still enforced · 1 session' };
    }
    if (autoModeSessions > 0 && autoModeSessions === activeSessions) {
      return {
        headline: `Auto mode · ${sessionsLabel(autoModeSessions)}`,
        meta: 'Rules still enforced on every session',
      };
    }
    return {
      headline: 'Auto mode active',
      meta: 'Rules still enforced — toggle "Skip enforcement in auto mode" in Settings to bypass',
    };
  }

  // Skipping path — Sentinel is standing down on auto-mode sessions.
  if (source === 'manual' && autoModeSessions === 0) {
    return {
      headline: 'Auto mode · manual override',
      meta: activeSessions > 0 ? `${sessionsLabel(activeSessions)} tracked · forced bypass` : 'Forced bypass',
    };
  }
  if (autoModeSessions === 1 && activeSessions === 1) {
    return { headline: 'Auto mode · Sentinel standing down', meta: '1 session' };
  }
  if (autoModeSessions > 0 && autoModeSessions < activeSessions) {
    return {
      headline: `Auto mode · ${autoModeSessions} of ${activeSessions} sessions`,
      meta: 'Enforcement skipped only on auto sessions',
    };
  }
  if (autoModeSessions > 0 && autoModeSessions === activeSessions) {
    return {
      headline: `Auto mode · ${sessionsLabel(autoModeSessions)}`,
      meta: 'Sentinel standing down on every session',
    };
  }
  return {
    headline: 'Auto mode active',
    meta: source === 'manual' ? 'manual override' : 'detected from request headers',
  };
}

/**
 * Inline banner that appears when Claude Code is in auto mode — either
 * because the user flipped the manual override in Settings or because the
 * daemon observed auto-mode beta headers on a recent request. The pulsing
 * icon and slide-in entrance make the bypass state easy to notice at a
 * glance. Copy adapts to the session count so parallel sessions read
 * correctly ("1 of 3 sessions"). Click to expand → per-session breakdown.
 */
function AutoModeBanner({
  status,
  skipInAutoMode,
}: {
  status: AutoModeStatus;
  skipInAutoMode: boolean;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const copy = buildBannerCopy(status, skipInAutoMode);
  const hasSessions = status.sessions.length > 0;

  // Two visual treatments:
  //   - skipping (Sentinel standing down): calm blue/purple gradient — the
  //     "all-good, trusting the classifier" look.
  //   - enforcing (auto detected but rules still on): amber gradient — the
  //     "heads up, unusual posture" look. Same information, visually
  //     distinct so a glance tells the user which regime they're in.
  const accent = skipInAutoMode
    ? {
        cardBg: 'bg-gradient-to-r from-ios-purple/15 via-ios-blue/10 to-ios-blue/5',
        cardBorder: 'border-ios-blue/20',
        cardDivider: 'border-ios-blue/15',
        dot: 'bg-ios-blue',
        icon: 'text-ios-blue',
      }
    : {
        cardBg: 'bg-gradient-to-r from-ios-orange/15 via-ios-orange/8 to-ios-orange/5',
        cardBorder: 'border-ios-orange/25',
        cardDivider: 'border-ios-orange/20',
        dot: 'bg-ios-orange',
        icon: 'text-ios-orange',
      };

  return (
    <AnimatePresence initial={false}>
      {status.active && (
        <motion.div
          layout
          initial={{ opacity: 0, y: -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: -8, height: 0 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className="overflow-hidden"
        >
          <div className={`px-3 py-2 mb-2 rounded-xl border ${accent.cardBg} ${accent.cardBorder}`}>
            <button
              type="button"
              onClick={() => hasSessions && setExpanded((v) => !v)}
              disabled={!hasSessions}
              className="flex items-start gap-2 w-full text-left disabled:cursor-default"
              aria-expanded={hasSessions ? expanded : undefined}
              title={hasSessions ? (expanded ? 'Hide session details' : 'Show session details') : undefined}
            >
              <span className="relative inline-flex items-center justify-center mt-0.5 flex-shrink-0">
                <span
                  aria-hidden
                  className={`animate-ping absolute inline-block w-2.5 h-2.5 rounded-full opacity-50 ${accent.dot}`}
                />
                <span className={`relative inline-block w-2.5 h-2.5 rounded-full ${accent.dot}`} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-semibold text-black dark:text-white leading-tight flex items-center gap-1">
                  <Zap size={11} strokeWidth={2.5} className={accent.icon} />
                  {copy.headline}
                  <span className="text-[10px] font-normal text-[#8E8E93]">· {copy.meta}</span>
                </p>
                <p className="text-[10.5px] text-[#8E8E93] leading-snug mt-0.5">
                  {skipInAutoMode
                    ? 'Sentinel is standing down on auto-mode sessions. Rule enforcement still applies to other sessions.'
                    : 'Sentinel is still enforcing rules on every session. Turn on "Skip enforcement in auto mode" in Settings if you want Sentinel to defer to Claude Code\u2019s classifier.'}
                </p>
              </div>
              {hasSessions && (
                expanded
                  ? <ChevronDown size={11} strokeWidth={2.5} className="text-[#8E8E93] mt-1" />
                  : <ChevronRight size={11} strokeWidth={2.5} className="text-[#8E8E93] mt-1" />
              )}
            </button>

            {hasSessions && expanded && (
              <div className={`mt-2 pt-2 border-t ${accent.cardDivider} space-y-1.5`}>
                {status.sessions.map((s) => (
                  <div key={s.sessionId} className="flex items-center gap-2 text-[10.5px]">
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        s.autoMode ? accent.dot : 'bg-[#8E8E93]/60'
                      }`}
                    />
                    <span className={`font-semibold tabular-nums ${s.autoMode ? accent.icon : 'text-[#8E8E93]'}`}>
                      {s.autoMode ? 'AUTO' : 'normal'}
                    </span>
                    <span className="text-[#8E8E93] font-mono truncate flex-1 min-w-0" title={s.sessionId}>
                      {s.sessionId.slice(0, 8)}…
                    </span>
                    <span className="text-[#8E8E93] flex-shrink-0">{formatAgo(s.lastSeenAt)}</span>
                  </div>
                ))}
                {status.processCount !== null && (
                  <p className="text-[10px] text-[#8E8E93] pt-1 italic">
                    {status.processCount} claude-code {status.processCount === 1 ? 'process' : 'processes'} running
                  </p>
                )}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
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
