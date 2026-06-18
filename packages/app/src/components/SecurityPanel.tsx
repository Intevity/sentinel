import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll.js';
import {
  Shield,
  ShieldAlert,
  ShieldX,
  Check,
  CheckCheck,
  Copy,
  Trash2,
  ShieldOff,
  FolderOpen,
  Terminal,
  MessageSquare,
  Settings2,
  Info,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type {
  SecurityEvent,
  SecuritySeverity,
  SecurityKind,
  AutoModeStatus,
} from '@sentinel/shared';
import { useSecurityEvents } from '../hooks/useSecurityEvents.js';
import { useSettings } from '../hooks/useSettings.js';
import { useAutoModeStatus } from '../hooks/useAutoModeStatus.js';
import { usePermissionRules } from '../hooks/usePermissionRules.js';
import { usePendingSecurityBlocks } from '../hooks/usePendingSecurityBlocks.js';
import LiveSecurityRow from './LiveSecurityRow.js';
import SecurityStatusPill from './SecurityStatusPill.js';
import HighlightedSnippet from './HighlightedSnippet.js';
import {
  QuickSegmented,
  QuickChipToggle,
  Switch,
  SettingsCard,
  SettingsRow,
} from './settings/primitives.js';
import InfoTooltip from './InfoTooltip.js';
import { describeScanSummary } from '../lib/securityScanSummary.js';
import {
  buildEventCopyText,
  COPY_DETAILS_LABEL,
  COPY_INTERNAL_KEYS,
} from '../lib/securityEventCopyText.js';
import { sendToSentinel } from '../lib/ipc.js';

/** Inline two-click confirm: first click transitions into `pending`
 *  state which reverts after `timeoutMs`. Second click while pending
 *  fires the action. Used instead of browser confirm() because Tauri
 *  webview suppresses native confirm dialogs in some configurations. */
function useConfirmButton(
  action: () => void | Promise<void>,
  timeoutMs = 4000,
): {
  pending: boolean;
  trigger: () => void;
  cancel: () => void;
} {
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
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
  /** Row id to auto-expand (and flash) when this panel mounts or this
   *  prop changes. Used when the user clicks the "Details" action on
   *  an OS security notification — the Rust side switches the active
   *  tab to Security and passes the security_events row id here. */
  autoExpandEventId?: number | null;
  /** Called once the auto-expand has been applied so the parent can
   *  clear its state and not re-expand on subsequent renders. */
  onAutoExpandHandled?: () => void;
}

const SEVERITY_META: Record<
  SecuritySeverity,
  { Icon: typeof Shield; color: string; bg: string; label: string }
> = {
  low: { Icon: Shield, color: 'text-ios-green', bg: 'bg-ios-green/10', label: 'LOW' },
  medium: { Icon: ShieldAlert, color: 'text-ios-orange', bg: 'bg-ios-orange/10', label: 'MEDIUM' },
  high: { Icon: ShieldX, color: 'text-ios-red', bg: 'bg-ios-red/10', label: 'HIGH' },
};

const KIND_LABEL: Record<SecurityKind, string> = {
  secret: 'Secret',
  pii: 'PII',
  prompt_injection: 'Injection',
  risky_bash: 'Risky Bash',
  risky_write: 'Risky Write',
  risky_read: 'Risky Read',
  risky_webfetch: 'Risky WebFetch',
  scan_truncated: 'Scan Truncated',
  scan_skipped_encoding: 'Scan Skipped',
  scan_deferred_oversized: 'Scan Deferred',
  tool_permission_blocked: 'Tool Blocked',
};

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
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
  'file-read': {
    label: 'File read',
    Icon: FolderOpen,
    color: 'text-ios-green',
    bg: 'bg-ios-green/10',
  },
  'tool-use': { label: 'Tool use', Icon: Terminal, color: 'text-ios-blue', bg: 'bg-ios-blue/10' },
  'tool-result': {
    label: 'Tool result',
    Icon: Terminal,
    color: 'text-ios-blue',
    bg: 'bg-ios-blue/10',
  },
  'mcp-description': {
    label: 'MCP tool description',
    Icon: Info,
    color: 'text-muted',
    bg: 'bg-muted/10',
  },
  conversation: {
    label: 'Conversation',
    Icon: MessageSquare,
    color: 'text-muted',
    bg: 'bg-muted/10',
  },
  'system-prompt': {
    label: 'System prompt',
    Icon: Settings2,
    color: 'text-muted',
    bg: 'bg-muted/10',
  },
  telemetry: {
    label: 'Scanner telemetry',
    Icon: Info,
    color: 'text-muted',
    bg: 'bg-muted/10',
  },
};

function ProvenanceBadge({
  provenance,
}: {
  provenance: SecurityEvent['provenance'];
}): React.ReactElement {
  const meta = PROVENANCE_META[provenance];
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${meta.bg} ${meta.color}`}
    >
      <meta.Icon size={10} strokeWidth={2.2} />
      {meta.label}
    </span>
  );
}

type SeverityFilter = 'all' | SecuritySeverity;
type KindFilter = 'all' | SecurityKind;

/** Kinds the scanner can produce. Used when the user has the scanner ON
 *  and tool permissions OFF — we narrow the daemon query to only return
 *  scanner-class events. Hoisted to module scope so its identity is
 *  stable across renders (the daemon-fetch hook would otherwise refetch
 *  on every render that re-allocates the array). */
const SCANNER_KINDS: SecurityKind[] = [
  'secret',
  'pii',
  'prompt_injection',
  'risky_bash',
  'risky_write',
  'risky_webfetch',
  'scan_truncated',
  'scan_skipped_encoding',
  'scan_deferred_oversized',
];

/** Kind set when only tool permissions are on. Single element today, but
 *  named for symmetry with SCANNER_KINDS so future kinds in this class
 *  have a clear home. */
const PERMISSION_KINDS: SecurityKind[] = ['tool_permission_blocked'];

/** Debounce a string value so a parent component fetching off it doesn't
 *  refire on every keystroke. 250ms is plenty for an SQLite local query
 *  and matches typical "instant search" feel. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export default function SecurityPanel({
  viewAccountId,
  onRequestOpenSettings,
  autoExpandEventId,
  onAutoExpandHandled,
}: SecurityPanelProps): React.ReactElement {
  const { settings, update } = useSettings();
  const autoMode = useAutoModeStatus();
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [includeWeakSignals, setIncludeWeakSignals] = useState(false);
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  /** Row id currently flashing after an auto-expand from an OS
   *  notification. Used to add a brief ring highlight so the user can
   *  spot where they landed in a long event list. Cleared by a
   *  self-timeout 2 s after the flash starts. */
  const [flashEventId, setFlashEventId] = useState<number | null>(null);

  // Settings drive the scanner-only / permissions-only mode narrowing,
  // which used to filter the loaded list client-side. With server-side
  // filtering it must apply BEFORE the kind chip choice, so we resolve
  // it inline here. Read settings off the existing useSettings result.
  const scanEnabledForFilter = settings?.securityScanEnabled ?? true;
  const permissionsEnabledForFilter = settings?.toolPermissionsEnabled ?? false;
  const scannerOnlyForFilter = scanEnabledForFilter && !permissionsEnabledForFilter;
  const permissionsOnlyForFilter = !scanEnabledForFilter && permissionsEnabledForFilter;

  // Resolve the `kinds` param the daemon should filter by. Priority:
  //   1. explicit kind chip → that single kind
  //   2. scanner-only mode → SCANNER_KINDS
  //   3. permissions-only mode → PERMISSION_KINDS
  //   4. otherwise → undefined (no kind constraint)
  // Memoised on primitive deps so its identity is stable across renders.
  const kindsForFetch = useMemo<SecurityKind[] | undefined>(() => {
    if (kindFilter !== 'all') return [kindFilter];
    if (scannerOnlyForFilter) return SCANNER_KINDS;
    if (permissionsOnlyForFilter) return PERMISSION_KINDS;
    return undefined;
  }, [kindFilter, scannerOnlyForFilter, permissionsOnlyForFilter]);

  const debouncedSearch = useDebouncedValue(search, 250);

  const {
    events,
    loading,
    loadingMore,
    hasMore,
    error,
    loadMore,
    acknowledge,
    acknowledgeAll,
    clearAll,
    addToAllowlist,
  } = useSecurityEvents({
    ...(viewAccountId !== undefined ? { accountId: viewAccountId } : {}),
    includeWeakSignals,
    ...(severityFilter !== 'all' ? { severity: severityFilter } : {}),
    ...(kindsForFetch !== undefined ? { kinds: kindsForFetch } : {}),
    ...(debouncedSearch.trim() !== '' ? { search: debouncedSearch.trim() } : {}),
  });

  const sentinelRef = useInfiniteScroll({ hasMore, loading: loadingMore, loadMore });

  // Live pending blocks render as pinned rows at the top of the events
  // list. Replaces the old top-of-screen banner so every security
  // decision and history item lives in one place. Cross-tab visibility
  // is handled in App.tsx via the Security tab badge.
  const {
    pending: pendingBlocks,
    approve: approvePending,
    deny: denyPending,
    secondsRemaining,
  } = usePendingSecurityBlocks();

  // Kinds the chip filter row should offer. With server-side filtering,
  // a fresh page returned for "kindFilter=secret" only contains secrets
  // — naively reading kinds from the loaded events would shrink the
  // chip group to a single chip and trap the user. So we accumulate
  // every kind we've ever seen across this session (the chip group
  // monotonically grows) and let the user pick freely.
  const [kindsEverSeen, setKindsEverSeen] = useState<Set<SecurityKind>>(
    () => new Set<SecurityKind>(),
  );
  useEffect(() => {
    setKindsEverSeen((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const e of events) {
        if (!next.has(e.kind)) {
          next.add(e.kind);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [events]);

  // Auto-expand + scroll + flash when the parent hands us a target id
  // from a notification click. Runs once per change of
  // `autoExpandEventId` (guarded by the effect deps) so re-clicking
  // Details on a subsequent notification re-fires the flash. If the
  // row isn't in the current event list (likely because filters are
  // hiding it), still expand + clear filters so the user lands on
  // something visible rather than an empty list.
  //
  // We intentionally do NOT start the flash-clear timer in this
  // effect: calling `onAutoExpandHandled` synchronously flips
  // `autoExpandEventId` back to null, which triggers a re-run of
  // this effect whose cleanup would immediately kill the timer — so
  // the flash would stick forever. The separate effect below owns
  // the flash lifecycle, keyed on `flashEventId` which only changes
  // when a new flash starts or the timer clears it.
  useEffect(() => {
    if (autoExpandEventId == null) return;
    // Clear filters that might hide the target row.
    setSeverityFilter('all');
    setKindFilter('all');
    setSearch('');
    setExpandedId(autoExpandEventId);
    setFlashEventId(autoExpandEventId);
    // Scroll the matching DOM node into view on the next tick so the
    // expand-triggered height change lands first.
    requestAnimationFrame(() => {
      const el = document.getElementById(`security-event-${autoExpandEventId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    onAutoExpandHandled?.();
  }, [autoExpandEventId, onAutoExpandHandled]);

  // Flash auto-clear. Separate effect so the timer isn't tied to the
  // prop-consumption cycle above. The 2200 ms matches the CSS
  // `security-flash` animation duration (2 s) + a small buffer so
  // the ring finishes its fade-out before the class is removed.
  useEffect(() => {
    if (flashEventId == null) return;
    const t = window.setTimeout(() => setFlashEventId(null), 2200);
    return () => window.clearTimeout(t);
  }, [flashEventId]);

  const clearConfirm = useConfirmButton(clearAll);

  // Transient hint shown after a successful "Always allow" so the user
  // knows where the new entry lives — the Allowlist section in Settings.
  // Auto-clears after 5s. Needed because the allowlisted finding also
  // disappears from the list (dedup by match_hash), leaving the user
  // with no signal that anything happened otherwise.
  const [allowlistHintShown, setAllowlistHintShown] = useState(false);
  const allowlistHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (allowlistHintTimerRef.current) clearTimeout(allowlistHintTimerRef.current);
    },
    [],
  );
  const handleAllowlist = (eventId: number): void => {
    void addToAllowlist(eventId);
    setAllowlistHintShown(true);
    if (allowlistHintTimerRef.current) clearTimeout(allowlistHintTimerRef.current);
    allowlistHintTimerRef.current = setTimeout(() => setAllowlistHintShown(false), 5000);
  };

  // Transient hint shown after a synthetic-kind "Mute these" click.
  // Separate from the allowlist hint because the copy + deep-link
  // target differ; reusing the same state would let a stale toast
  // flicker between the two actions.
  const [muteHintShown, setMuteHintShown] = useState(false);
  const muteHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (muteHintTimerRef.current) clearTimeout(muteHintTimerRef.current);
    },
    [],
  );
  const handleMute = (event: SecurityEvent): void => {
    // Map the synthetic kind to its matching Settings flag. The three
    // `scan_*` kinds are exhaustive — any future synthetic would fall
    // through this switch and silently do nothing (safe default).
    let patch: Partial<import('@sentinel/shared').Settings> | null = null;
    if (event.kind === 'scan_deferred_oversized') patch = { securityMuteScanDeferred: true };
    else if (event.kind === 'scan_truncated') patch = { securityMuteScanTruncated: true };
    else if (event.kind === 'scan_skipped_encoding') patch = { securityMuteScanSkipped: true };
    if (!patch) return;
    void update(patch).catch(() => undefined);
    // Acknowledge the current row too so it fades alongside the mute
    // — keeps the user's hands on one action per decision.
    void acknowledge(event.id);
    setMuteHintShown(true);
    if (muteHintTimerRef.current) clearTimeout(muteHintTimerRef.current);
    muteHintTimerRef.current = setTimeout(() => setMuteHintShown(false), 5000);
  };

  // NOTE: all hooks must run unconditionally before any early return below.
  // React error #300 ("Rendered fewer hooks than expected") fires if a
  // render path skips a hook that a previous render called.

  // Filter chips list — see kindsEverSeen above for the rationale on
  // accumulating instead of reading from the current event list.
  const kindsInView = useMemo(() => Array.from(kindsEverSeen), [kindsEverSeen]);

  // One-line chip shown next to "Filters" when collapsed so the user can see
  // what's narrowing the list without needing to expand.
  const activeFilterSummary = useMemo(() => {
    const parts: string[] = [];
    if (severityFilter !== 'all') parts.push(severityFilter.toUpperCase());
    if (kindFilter !== 'all') parts.push(KIND_LABEL[kindFilter as SecurityKind]);
    if (search.trim()) parts.push(`"${search.trim()}"`);
    if (includeWeakSignals) parts.push('incl. diagnostics');
    return parts.join(' · ');
  }, [severityFilter, kindFilter, search, includeWeakSignals]);

  // Independent feature flags. Scanning and tool permissions are two
  // separate subsystems; the tab is useful whenever either is on.
  // Settings is undefined during the initial load — fall through to
  // the normal render in that window so we don't flash a disabled
  // banner before the real state arrives.
  const scanEnabled = scanEnabledForFilter;
  const permissionsEnabled = permissionsEnabledForFilter;
  const bothOff = settings != null && !scanEnabled && !permissionsEnabled;
  // When exactly one feature is on, the other has nothing to surface —
  // narrow the visible list to that feature's kind set so the user
  // isn't looking at a spurious "no events" message while events of
  // the OTHER kind are stacking up invisibly. The actual narrowing
  // happens server-side via kindsForFetch (see above).
  const scannerOnly = scannerOnlyForFilter;
  const permissionsOnly = permissionsOnlyForFilter;

  // Pull permission rules for the status strip's rule count. Hook
  // always runs (mustn't be gated on bothOff) to keep hook order
  // stable across renders.
  const { rules: permissionRules } = usePermissionRules();
  const enabledRuleCount = permissionRules.filter((r) => r.enabled).length;

  // Fully-disabled short circuit: if the user has turned BOTH features
  // off, the panel has nothing useful to show — render a single card
  // with both enable-actions and a deep link to the relevant settings
  // anchors. Anything less than both-off falls through to the normal
  // render path below.
  if (bothOff) {
    return (
      <div className="space-y-2 pt-1">
        <div className="glass-card px-4 py-8 text-center">
          <ShieldOff size={28} className="mx-auto text-muted mb-2" strokeWidth={2} />
          <p className="text-[13px] font-semibold text-black dark:text-white">Security is off</p>
          <p className="text-[11px] text-muted mt-1 leading-snug max-w-[340px] mx-auto">
            Both security scanning and tool permissions are disabled. Enable one (or both) to start
            catching secrets, injection, risky tool calls, or blocking specific tools.
          </p>
          <div className="mt-3 flex items-center justify-center gap-2 flex-wrap">
            <button
              onClick={() => void update({ securityScanEnabled: true }).catch(() => undefined)}
              className="text-[12px] font-semibold px-3 py-1.5 rounded-full bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all"
            >
              Turn on scanning
            </button>
            <button
              onClick={() => void update({ toolPermissionsEnabled: true }).catch(() => undefined)}
              className="text-[12px] font-semibold px-3 py-1.5 rounded-full bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all"
            >
              Turn on tool permissions
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

  const unreadCount = events.filter((e) => !e.acknowledged).length;

  return (
    <div className="space-y-2 pt-1">
      <AutoModeBanner
        status={autoMode}
        skipInAutoMode={settings?.toolPermissionSkipInAutoMode ?? true}
      />

      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="section-label">Security</span>
          {unreadCount > 0 && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-ios-red text-white">
              {unreadCount}
            </span>
          )}
          <InfoTooltip text="Sentinel stores redacted fingerprints of findings, never the original secret text." />
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
                clearConfirm.pending
                  ? 'text-white bg-ios-red px-2 py-0.5 rounded-full'
                  : 'text-ios-red hover:opacity-80'
              }`}
              title={clearConfirm.pending ? 'Click again to delete' : 'Clear all'}
            >
              <Trash2 size={12} strokeWidth={2.5} />
              {clearConfirm.pending ? 'Click again to delete' : 'Clear'}
            </button>
          )}
        </div>
      </div>

      {/* Scanning card — labeled, collapsible, visually distinct from the
          filter pills below. Collapsed by default with a one-line summary
          in the header so state is visible at a glance. Writes flow through
          useSettings().update, same path as the full SettingsPanel. */}
      {settings && (
        <SettingsCard title="Scanning" summary={describeScanSummary(settings)} defaultOpen={false}>
          <SettingsRow
            label="Security scanning"
            description="Inspect prompts, files, and tool calls for risks."
          >
            <Switch
              label="Security scanning"
              checked={settings.securityScanEnabled}
              onChange={(v) => void update({ securityScanEnabled: v }).catch(() => undefined)}
            />
          </SettingsRow>
          <SettingsRow
            label="Tool permissions"
            description={
              settings.toolPermissionsEnabled
                ? `${enabledRuleCount} rule${enabledRuleCount === 1 ? '' : 's'} enforced`
                : 'Allow/deny rules not applied'
            }
          >
            <Switch
              label="Tool permissions"
              checked={settings.toolPermissionsEnabled}
              onChange={(v) => void update({ toolPermissionsEnabled: v }).catch(() => undefined)}
            />
          </SettingsRow>
          {settings.securityScanEnabled && (
            <>
              <SettingsRow
                label="When a risk is detected"
                description="Observe records findings; Block stops the outbound request."
              >
                <QuickSegmented
                  ariaLabel="Enforcement mode"
                  value={
                    (settings.securityEnforcementMode ?? 'observe') as
                      | 'observe'
                      | 'block_high'
                      | 'block_medium_high'
                  }
                  onChange={(v) =>
                    void update({ securityEnforcementMode: v }).catch(() => undefined)
                  }
                  options={[
                    { value: 'observe', label: 'Observe', title: 'Record findings; never block' },
                    {
                      value: 'block_high',
                      label: 'HIGH',
                      title: 'Block only HIGH-severity findings',
                    },
                    {
                      value: 'block_medium_high',
                      label: 'MED+HIGH',
                      title: 'Block MEDIUM and HIGH findings',
                    },
                  ]}
                />
              </SettingsRow>
              <SettingsRow
                label="Scan for"
                description="Categories inspected on every outbound request."
              >
                <div className="flex flex-wrap gap-1 justify-end">
                  <QuickChipToggle
                    label="Secrets"
                    active={settings.securityScanSecrets}
                    onChange={(v) => void update({ securityScanSecrets: v }).catch(() => undefined)}
                    title="Scan for API keys, tokens, private keys"
                  />
                  <QuickChipToggle
                    label="Injection"
                    active={settings.securityScanInjection}
                    onChange={(v) =>
                      void update({ securityScanInjection: v }).catch(() => undefined)
                    }
                    title="Heuristic prompt-injection detection"
                  />
                  <QuickChipToggle
                    label="Tool-use"
                    active={settings.securityScanToolUse}
                    onChange={(v) => void update({ securityScanToolUse: v }).catch(() => undefined)}
                    title="Inspect proposed Bash / Write / WebFetch tool calls"
                  />
                </div>
              </SettingsRow>
            </>
          )}
        </SettingsCard>
      )}

      {/* Collapsible filter section. Mirrors the Logs tab pattern: a chevron
          toggle, an inline summary showing active filters, and the full
          filter controls revealed on expand. */}
      <div className="mb-2">
        <button
          onClick={() => setFiltersOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-medium text-muted hover:text-black dark:hover:text-white transition-colors active:scale-95"
          title={filtersOpen ? 'Hide filters' : 'Show filters'}
          aria-expanded={filtersOpen}
        >
          {filtersOpen ? (
            <ChevronDown size={11} strokeWidth={2.5} />
          ) : (
            <ChevronRight size={11} strokeWidth={2.5} />
          )}
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
                      : 'bg-muted/10 text-muted hover:bg-muted/20'
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
                      : 'bg-muted/10 text-muted hover:bg-muted/20'
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
                        : 'bg-muted/10 text-muted hover:bg-muted/20'
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
              className="w-full text-[11px] bg-muted/10 text-black dark:text-white rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ios-blue"
            />

            <label className="flex items-center gap-2 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={includeWeakSignals}
                onChange={(e) => setIncludeWeakSignals(e.target.checked)}
                className="w-3 h-3 accent-ios-blue"
              />
              Show scan diagnostics (truncation, encoding-skip, deferred)
            </label>
          </div>
        )}
      </div>

      {error && <div className="glass-card px-3 py-2 text-[11px] text-ios-red">{error}</div>}

      {allowlistHintShown && (
        <div className="glass-card px-3 py-2 text-[11px] text-muted flex items-start gap-2">
          <Check size={12} className="text-ios-green flex-shrink-0 mt-0.5" strokeWidth={2.5} />
          <span className="flex-1 leading-snug">
            Added to allowlist. Manage entries in{' '}
            <span className="font-semibold text-black dark:text-white">
              Settings → Security → Allowlist
            </span>
            .
          </span>
          <button
            onClick={() => setAllowlistHintShown(false)}
            className="text-muted hover:text-black dark:hover:text-white p-0.5 -m-0.5 flex-shrink-0"
            aria-label="Dismiss"
          >
            <X size={10} strokeWidth={2.5} />
          </button>
        </div>
      )}

      {muteHintShown && (
        <div className="glass-card px-3 py-2 text-[11px] text-muted flex items-start gap-2">
          <Check size={12} className="text-ios-green flex-shrink-0 mt-0.5" strokeWidth={2.5} />
          <span className="flex-1 leading-snug">
            Muted. Un-mute from{' '}
            <button
              onClick={() => onRequestOpenSettings?.('oversized-threshold-slider')}
              disabled={!onRequestOpenSettings}
              className="font-semibold text-ios-blue hover:opacity-80 disabled:opacity-40"
            >
              Settings → Security → Oversized request scanning
            </button>
            .
          </span>
          <button
            onClick={() => setMuteHintShown(false)}
            className="text-muted hover:text-black dark:hover:text-white p-0.5 -m-0.5 flex-shrink-0"
            aria-label="Dismiss"
          >
            <X size={10} strokeWidth={2.5} />
          </button>
        </div>
      )}

      {/* Single-feature hint: when only one subsystem is on, tell the
          user the list is filtered accordingly and offer a link to the
          OTHER system's toggle. Silent when both are on (the common
          case) or when neither is on (short-circuited above). */}
      {settings && (scannerOnly || permissionsOnly) && (
        <div className="glass-card px-3 py-2 text-[11px] text-muted flex items-start gap-2">
          <Info size={12} className="text-ios-blue flex-shrink-0 mt-0.5" strokeWidth={2.5} />
          <span className="flex-1 leading-snug">
            {scannerOnly ? (
              <>
                Tool permissions are off — only showing scanner findings.{' '}
                <button
                  onClick={() =>
                    void update({ toolPermissionsEnabled: true }).catch(() => undefined)
                  }
                  className="font-semibold text-ios-blue hover:opacity-80"
                >
                  Turn on tool permissions
                </button>
              </>
            ) : (
              <>
                Scanning is off — only showing tool-permission blocks.{' '}
                <button
                  onClick={() => void update({ securityScanEnabled: true }).catch(() => undefined)}
                  className="font-semibold text-ios-blue hover:opacity-80"
                >
                  Turn on scanning
                </button>
              </>
            )}
          </span>
        </div>
      )}

      {pendingBlocks.length > 0 && (
        <div className="space-y-2" data-testid="live-security-pending">
          {pendingBlocks.map((entry) => (
            <LiveSecurityRow
              key={entry.pendingId}
              entry={entry}
              remaining={secondsRemaining(entry.pendingId)}
              onApprove={(opts) => void approvePending(entry.pendingId, opts)}
              onDeny={() => void denyPending(entry.pendingId)}
            />
          ))}
        </div>
      )}

      {!loading && events.length === 0 && pendingBlocks.length === 0 && !error ? (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-black dark:text-white">No security events</p>
          <p className="text-[11px] text-muted mt-1">
            {scannerOnly
              ? 'Scanner findings will appear here when detected.'
              : permissionsOnly
                ? 'Tool-permission blocks will appear here when they fire.'
                : 'Outbound secrets, risky tool calls, and tool-permission blocks will appear here when detected.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {events.map((event) => (
            <SecurityRow
              key={event.id}
              event={event}
              expanded={expandedId === event.id}
              flashing={flashEventId === event.id}
              onToggle={() => setExpandedId(expandedId === event.id ? null : event.id)}
              onAcknowledge={() => void acknowledge(event.id)}
              onAllowlist={() => handleAllowlist(event.id)}
              onMute={() => handleMute(event)}
            />
          ))}
          {hasMore && (
            <div ref={sentinelRef} className="py-3 text-center text-[10px] text-muted">
              {loadingMore ? 'Loading more…' : ' '}
            </div>
          )}
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

function buildBannerCopy(status: AutoModeStatus, skipInAutoMode: boolean): { headline: string } {
  const { activeSessions, autoModeSessions, source } = status;
  const sessionsLabel = (n: number): string => `${n} session${n === 1 ? '' : 's'}`;

  // When enforcement is NOT being skipped, the banner is informational: we
  // detected auto mode but Sentinel is still gating tool calls. The
  // explanatory paragraph below the headline covers the "still enforcing"
  // semantics, so the headline alone carries the state.
  if (!skipInAutoMode) {
    if (source === 'manual' && autoModeSessions === 0) {
      return { headline: 'Auto mode · manual override' };
    }
    if (autoModeSessions > 0 && autoModeSessions < activeSessions) {
      return {
        headline: `Auto mode detected · ${autoModeSessions} of ${activeSessions} sessions`,
      };
    }
    if (autoModeSessions === 1 && activeSessions === 1) {
      return { headline: 'Auto mode detected' };
    }
    if (autoModeSessions > 0 && autoModeSessions === activeSessions) {
      return { headline: `Auto mode · ${sessionsLabel(autoModeSessions)}` };
    }
    return { headline: 'Auto mode active' };
  }

  // Skipping path — Sentinel is standing down on auto-mode sessions.
  if (source === 'manual' && autoModeSessions === 0) {
    return { headline: 'Auto mode · manual override' };
  }
  if (autoModeSessions === 1 && activeSessions === 1) {
    return { headline: 'Auto mode · Sentinel standing down' };
  }
  if (autoModeSessions > 0 && autoModeSessions < activeSessions) {
    return { headline: `Auto mode · ${autoModeSessions} of ${activeSessions} sessions` };
  }
  if (autoModeSessions > 0 && autoModeSessions === activeSessions) {
    return { headline: `Auto mode · ${sessionsLabel(autoModeSessions)}` };
  }
  return { headline: 'Auto mode active' };
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
              title={
                hasSessions
                  ? expanded
                    ? 'Hide session details'
                    : 'Show session details'
                  : undefined
              }
            >
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-semibold text-black dark:text-white leading-tight flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="relative inline-flex items-center justify-center flex-shrink-0"
                  >
                    <span
                      className={`animate-ping absolute inline-block w-2 h-2 rounded-full opacity-50 ${accent.dot}`}
                    />
                    <span className={`relative inline-block w-2 h-2 rounded-full ${accent.dot}`} />
                  </span>
                  <span className="whitespace-nowrap">{copy.headline}</span>
                </p>
                <p className="text-[10.5px] text-muted leading-snug mt-0.5">
                  {skipInAutoMode
                    ? 'Sentinel is standing down on auto-mode sessions. Rule enforcement still applies to other sessions.'
                    : 'Sentinel is still enforcing rules on every session. Turn on "Skip enforcement in auto mode" in Settings if you want Sentinel to defer to Claude Code\u2019s classifier.'}
                </p>
              </div>
              {hasSessions &&
                (expanded ? (
                  <ChevronDown size={11} strokeWidth={2.5} className="text-muted mt-1" />
                ) : (
                  <ChevronRight size={11} strokeWidth={2.5} className="text-muted mt-1" />
                ))}
            </button>

            <AnimatePresence initial={false}>
              {hasSessions && expanded && (
                <motion.div
                  key="sessions"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{
                    height: { duration: 0.26, ease: [0.22, 1, 0.36, 1] },
                    opacity: { duration: 0.18, ease: 'easeOut' },
                  }}
                  className="overflow-hidden"
                >
                  <div className={`mt-2 pt-2 border-t ${accent.cardDivider} space-y-1.5`}>
                    {status.sessions.map((s) => (
                      <div key={s.sessionId} className="flex items-center gap-2 text-[10.5px]">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            s.autoMode ? accent.dot : 'bg-muted/60'
                          }`}
                        />
                        <span
                          className={`font-semibold tabular-nums ${s.autoMode ? accent.icon : 'text-muted'}`}
                        >
                          {s.autoMode ? 'AUTO' : 'normal'}
                        </span>
                        <span
                          className="text-muted font-mono truncate flex-1 min-w-0"
                          title={s.sessionId}
                        >
                          {s.sessionId.slice(0, 8)}…
                        </span>
                        <span className="text-muted flex-shrink-0">{formatAgo(s.lastSeenAt)}</span>
                      </div>
                    ))}
                    {status.processCount !== null && (
                      <p className="text-[10px] text-muted pt-1 italic">
                        {status.processCount} claude-code{' '}
                        {status.processCount === 1 ? 'process' : 'processes'} running
                      </p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface SecurityRowProps {
  event: SecurityEvent;
  expanded: boolean;
  /** Temporary attention cue — when true, the row renders a blue
   *  ring for ~2 s so the user can spot where the notification click
   *  landed in a long list. Parent clears it via a timer. */
  flashing?: boolean;
  onToggle: () => void;
  onAcknowledge: () => void;
  onAllowlist: () => void;
  /** Only meaningful on synthetic `scan_*` rows. Flips the matching
   *  Settings mute flag so future alerts of this kind are dropped.
   *  Ignored (and hidden) for real finding rows, which use the
   *  allowlist path instead. */
  onMute: () => void;
}

function SecurityRow({
  event,
  expanded,
  flashing,
  onToggle,
  onAcknowledge,
  onAllowlist,
  onMute,
}: SecurityRowProps): React.ReactElement {
  const allowConfirm = useConfirmButton(onAllowlist);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);
  const handleCopy = (): void => {
    void navigator.clipboard
      .writeText(buildEventCopyText(event))
      .then(() => {
        setCopied(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard rejection — leave UI unchanged so user can retry */
      });
  };
  // Synthetic `scan_*` events are telemetry, not detections. They
  // don't have a "match" to allowlist — the allowlist key is
  // `${kind}:${accountId}`, so a single click would silence every
  // alert of that kind on the account. Offer "Mute these" (a
  // settings-level per-kind switch) instead, which is the semantically
  // correct control and is reversible from Settings.
  const isSynthetic = event.kind.startsWith('scan_');
  const meta = SEVERITY_META[event.severity];
  const { Icon, color, bg, label } = meta;
  return (
    <div
      id={`security-event-${event.id}`}
      className={`glass-card transition-opacity duration-300 ${
        event.acknowledged ? 'opacity-75' : ''
      } ${flashing ? 'security-row-flash' : ''}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left p-3 flex items-start gap-3"
      >
        <div
          className={`flex-shrink-0 w-8 h-8 rounded-full ${bg} flex items-center justify-center`}
        >
          <Icon size={15} className={color} strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${bg} ${color}`}>
              {label}
            </span>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-muted/10 text-muted">
              {KIND_LABEL[event.kind]}
            </span>
            <SecurityStatusPill event={event} />
            {event.occurrences > 1 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-muted/10 text-muted">
                ×{event.occurrences}
              </span>
            )}
          </div>
          <p className="text-[13px] font-semibold text-black dark:text-white leading-snug truncate">
            {event.title}
          </p>
          <p className="text-[10px] text-muted/70 mt-0.5">{formatDate(event.ts)}</p>
        </div>
        {!event.acknowledged && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAcknowledge();
            }}
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
            <span className="text-muted">Reason:</span>{' '}
            <span className="text-black dark:text-white">{event.reason}</span>
          </div>
          {event.matchMask && (
            <div>
              <span className="text-muted">Match:</span>{' '}
              <code className="text-[10px] font-mono bg-muted/10 px-1 py-0.5 rounded">
                {event.matchMask}
              </code>
            </div>
          )}
          {event.snippet && (
            <div>
              <span className="text-muted">Context:</span>{' '}
              <HighlightedSnippet text={event.snippet} />
            </div>
          )}
          <DetailsList details={event.details} />

          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-muted flex-shrink-0">Origin:</span>
            <ProvenanceBadge provenance={event.provenance} />
          </div>
          {!event.blocked &&
            (event.provenance === 'conversation' || event.provenance === 'system-prompt') &&
            event.kind !== 'risky_bash' &&
            event.kind !== 'risky_write' &&
            event.kind !== 'risky_webfetch' && (
              <p className="text-[10px] text-muted leading-snug -mt-0.5">
                Not blocked — Sentinel only blocks secret matches that come from a file Claude Code
                read or wrote. Matches in conversation text aren't treated as data exfiltration.
              </p>
            )}
          {event.sourceHint && (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-muted flex-shrink-0">Source:</span>
              {isFilePath(event.sourceHint) ? (
                <>
                  <FolderOpen size={11} className="text-muted flex-shrink-0" strokeWidth={2} />
                  <code
                    className="text-[10px] font-mono bg-muted/10 px-1 py-0.5 rounded truncate min-w-0"
                    title={event.sourceHint}
                  >
                    {event.sourceHint}
                  </code>
                </>
              ) : (
                <code className="text-[10px] font-mono text-muted truncate min-w-0">
                  {event.sourceHint}
                </code>
              )}
            </div>
          )}
          <div>
            <span className="text-muted">Detector:</span>{' '}
            <code className="text-[10px] font-mono text-muted">{event.detectorId}</code>{' '}
            <span className="text-muted">(conf {event.confidence.toFixed(2)})</span>
          </div>
          <ReplayContextSection eventId={event.id} />
          <div className="pt-1.5 flex items-center justify-between gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleCopy();
              }}
              className="flex-shrink-0 flex items-center gap-1 text-[10px] font-semibold text-ios-blue hover:opacity-80 active:scale-95 transition-all"
              title="Copy event details to clipboard"
              aria-label="Copy event details to clipboard"
            >
              <Copy size={10} strokeWidth={2.5} />
              {copied ? 'Copied' : 'Copy'}
            </button>
            {isSynthetic ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onMute();
                }}
                className="flex-shrink-0 flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full transition-all active:scale-95 bg-muted/15 text-muted hover:bg-muted/25"
                title="Stop showing alerts of this kind. Reversible from Settings → Security."
              >
                <ShieldOff size={10} strokeWidth={2.5} />
                Mute these
              </button>
            ) : event.resolution === 'user_approve' ? null : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  allowConfirm.trigger();
                }}
                className={`flex-shrink-0 flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full transition-all active:scale-95 ${
                  allowConfirm.pending
                    ? event.blocked
                      ? 'bg-ios-orange text-white'
                      : 'bg-[#8E8E93] text-white'
                    : event.blocked
                      ? 'bg-ios-orange/10 text-ios-orange hover:bg-ios-orange/20'
                      : 'bg-muted/15 text-muted hover:bg-muted/25'
                }`}
                title={
                  allowConfirm.pending
                    ? event.blocked
                      ? 'Click again to allow'
                      : 'Click again to mute'
                    : event.blocked
                      ? 'Suppress all future matches of this exact value'
                      : 'Stop alerting on this exact value in the future'
                }
              >
                <ShieldOff size={10} strokeWidth={2.5} />
                {allowConfirm.pending ? 'Confirm?' : event.blocked ? 'Always allow' : 'Mute'}
              </button>
            )}
          </div>
          <p className="text-[10px] text-muted leading-snug">
            {isSynthetic
              ? 'Informational telemetry, not a detection. "Mute these" hides future alerts of this kind until you re-enable them in Settings.'
              : event.resolution === 'user_approve'
                ? 'You approved this held request. The match was added to your allowlist so future identical calls skip the approval banner.'
                : event.blocked
                  ? '"Always allow" adds this exact match to your allowlist so future identical calls skip the approval banner.'
                  : '"Mute" adds this exact match to your allowlist so future detections are silently suppressed. The request was not blocked.'}
          </p>
        </div>
      )}
    </div>
  );
}

/** Sprint 8 — surface the captured forensic incident replay (if any)
 *  for an expanded security event. Lazy-loads the row from the daemon
 *  on first render; renders nothing if no capture exists, which is the
 *  common case (the setting is off by default). */
interface ReplayMessageRow {
  ts: number;
  role: string;
  text: string;
  tool?: string;
}
interface ReplayPayload {
  eventId: number;
  capturedAt: number;
  messages: ReplayMessageRow[];
}
function ReplayContextSection({ eventId }: { eventId: number }): React.ReactElement | null {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'empty' }
    | { status: 'loaded'; data: ReplayPayload }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void sendToSentinel({ type: 'get_incident_replay', eventId })
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setState({ status: 'error', message: res.error ?? 'replay fetch failed' });
          return;
        }
        const payload = res.data as ReplayPayload | null | undefined;
        if (!payload) {
          setState({ status: 'empty' });
          return;
        }
        setState({ status: 'loaded', data: payload });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (state.status === 'idle' || state.status === 'loading' || state.status === 'empty') {
    return null;
  }
  if (state.status === 'error') return null;

  const { data } = state;
  return (
    <div className="pt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[10px] font-semibold text-ios-blue hover:underline"
      >
        {open ? 'Hide' : 'Replay context'} ({data.messages.length} message
        {data.messages.length === 1 ? '' : 's'})
      </button>
      {open && (
        <div className="mt-1 space-y-1 border-l-2 border-ios-blue/30 pl-2">
          {data.messages.map((m, i) => (
            <div key={i} className="text-[10px] leading-snug">
              <span className="text-muted font-mono">{new Date(m.ts).toLocaleTimeString()}</span>{' '}
              <span className="font-semibold text-black dark:text-white">{m.role}</span>
              {m.tool ? <span className="text-muted"> [{m.tool}]</span> : null}
              <p className="text-black/80 dark:text-white/80 break-words font-mono">{m.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Renders structured tool-call details (url / command / file_path / prompt …)
 *  below the "Context" row so users can see what was blocked without having to
 *  parse the snippet string. Internal/reference ids (matchedRuleId, etc.) are
 *  filtered out — they're already surfaced elsewhere in the expand panel.
 *  Both filter and label sets are sourced from `securityEventCopyText.ts` so
 *  the on-screen rendering and the Copy-to-clipboard payload stay in sync. */
const DETAILS_INTERNAL_KEYS = COPY_INTERNAL_KEYS;
const DETAILS_LABEL = COPY_DETAILS_LABEL;

function DetailsList({
  details,
}: {
  details: Record<string, unknown> | null;
}): React.ReactElement | null {
  if (!details) return null;
  const entries = Object.entries(details).filter(
    ([k, v]) => !DETAILS_INTERNAL_KEYS.has(k) && typeof v === 'string' && v.length > 0,
  );
  if (entries.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-start gap-1.5 min-w-0">
          <span className="text-muted flex-shrink-0">{DETAILS_LABEL[k] ?? k}:</span>
          <code className="text-[10px] font-mono bg-muted/10 px-1 py-0.5 rounded break-all min-w-0">
            {String(v)}
          </code>
        </div>
      ))}
    </div>
  );
}
