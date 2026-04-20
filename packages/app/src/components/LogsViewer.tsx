import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, ChevronRight, FileJson, FileText, Trash2 } from 'lucide-react';
import type { LogEntry, LogLevel } from '@claude-sentinel/shared';
import { useDaemonLogs } from '../hooks/useDaemonLogs.js';
import { useSettings } from '../hooks/useSettings.js';

/** Initial visible window. Rendering 5000 raw DOM rows is laggy; we cap at
 *  500 and offer a "Show all" escape hatch for power users. */
const VISIBLE_CAP = 500;

const LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: 'text-[#8E8E93]',
  info:  'text-black dark:text-white',
  warn:  'text-ios-orange',
  error: 'text-ios-red',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatExportLine(e: LogEntry): string {
  const iso = new Date(e.timestamp).toISOString();
  const lvl = e.level.toUpperCase().padEnd(5);
  const tag = e.tag ? `[${e.tag}] ` : '';
  return `[${iso}] ${lvl} ${tag}${e.message}`;
}

function useConfirmButton(action: () => void | Promise<void>, timeoutMs = 4000): {
  pending: boolean;
  trigger: () => void;
} {
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
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
  return { pending, trigger };
}

export default function LogsViewer(): React.ReactElement {
  const { settings, update } = useSettings();
  const { entries, loading, error, clearLogs } = useDaemonLogs();

  // Client-side level filter — independent of the daemon's emit level. Shows
  // everything by default; the user can mute noisy levels in-view without
  // losing them from the ring buffer.
  const [levelMask, setLevelMask] = useState<Set<LogLevel>>(
    () => new Set(LEVEL_ORDER),
  );
  const [tagMask, setTagMask] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  // Filters are collapsible so the log list can fill the tab. Closed by
  // default — the summary next to the header surfaces active filters at a
  // glance, so the user doesn't need to expand just to see what's narrowing.
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 100);
    return () => clearTimeout(id);
  }, [search]);

  // Auto-tail behavior: the list pins to the bottom as new entries stream in.
  // If the user scrolls up, `stickToBottom` flips off and we surface a floating
  // arrow button to jump back. The "within 24px of bottom" threshold treats the
  // freshly-scrolled state as bottom (avoids bouncing off after programmatic
  // scroll) without clutching onto small manual nudges.
  //
  // `isProgrammaticScroll` suppresses the onScroll handler during the
  // auto-pin write. Without it, setting scrollTop triggers a scroll event
  // that calls setStickToBottom on the same commit; combined with `visible`
  // being a fresh slice every render, this cascades into React error #300
  // ("Too many re-renders").
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isProgrammaticScroll = useRef(false);
  const [stickToBottom, setStickToBottom] = useState(true);

  const handleScroll = (): void => {
    if (isProgrammaticScroll.current) {
      isProgrammaticScroll.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    const nearBottom = distanceFromBottom < 24;
    setStickToBottom((prev) => (prev === nearBottom ? prev : nearBottom));
  };

  const jumpToBottom = (): void => {
    const el = scrollRef.current;
    if (el) {
      isProgrammaticScroll.current = true;
      el.scrollTop = el.scrollHeight;
    }
    setStickToBottom(true);
  };

  const tagsInView = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.tag) set.add(e.tag);
    }
    return Array.from(set).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return entries.filter((e) => {
      if (!levelMask.has(e.level)) return false;
      if (tagMask.size > 0 && (!e.tag || !tagMask.has(e.tag))) return false;
      if (q && !e.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, levelMask, tagMask, debouncedSearch]);

  const visible = showAll ? filtered : filtered.slice(-VISIBLE_CAP);
  const truncated = !showAll && filtered.length > VISIBLE_CAP;

  // Key the pin-to-bottom effect off the last entry's seq (a stable primitive)
  // rather than `visible` (a fresh array every render). That makes the effect
  // fire only when a new entry actually arrives, not on every render.
  const lastSeq = visible.length > 0 ? visible[visible.length - 1]!.seq : -1;

  useLayoutEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (!el) return;
    isProgrammaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
  }, [lastSeq, stickToBottom]);

  const clearConfirm = useConfirmButton(async () => {
    setClearing(true);
    try {
      await clearLogs();
    } finally {
      setClearing(false);
    }
  });

  const handleLevelEmitChange = async (level: LogLevel): Promise<void> => {
    try {
      await update({ logLevel: level });
    } catch {
      /* useSettings surfaces errors; ignore here */
    }
  };

  const toggleLevel = (level: LogLevel): void => {
    setLevelMask((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const toggleTag = (tag: string): void => {
    setTagMask((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  // Short summary of active filters — shown next to the Filters toggle so the
  // user can see at a glance what's narrowing without expanding the panel.
  // Empty string when nothing is filtering (i.e. the default state).
  const activeFilterSummary = useMemo(() => {
    const parts: string[] = [];
    const hiddenLevels = LEVEL_ORDER.filter((l) => !levelMask.has(l));
    if (hiddenLevels.length > 0) {
      parts.push(`hiding ${hiddenLevels.map((l) => l.toUpperCase()).join('/')}`);
    }
    if (tagMask.size > 0) {
      parts.push(`${tagMask.size} tag${tagMask.size === 1 ? '' : 's'}`);
    }
    if (debouncedSearch.trim()) {
      parts.push(`"${debouncedSearch.trim()}"`);
    }
    return parts.join(' · ');
  }, [levelMask, tagMask, debouncedSearch]);

  const exportLogs = async (format: 'txt' | 'json'): Promise<void> => {
    setExporting(true);
    try {
      // Lazy imports keep these out of the initial bundle and let web dev
      // mode (where the plugins aren't available) fail late.
      const [{ save }, { writeTextFile }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
      ]);
      const date = new Date().toISOString().slice(0, 10);
      const path = await save({
        defaultPath: `claude-sentinel-logs-${date}.${format}`,
        filters: [
          format === 'json'
            ? { name: 'JSON', extensions: ['json'] }
            : { name: 'Text', extensions: ['txt'] },
        ],
      });
      if (!path) return;
      const body =
        format === 'json'
          ? JSON.stringify(filtered, null, 2)
          : filtered.map(formatExportLine).join('\n');
      await writeTextFile(path, body);
    } finally {
      setExporting(false);
    }
  };

  // Empty/no-match/loading states render inline (not in the scroll pane) so
  // the surrounding flex layout still fills the tab when entries don't exist.
  const showEmptyState = !loading && entries.length === 0 && !error;
  const showNoMatchState = !loading && entries.length > 0 && filtered.length === 0;

  return (
    <div className="flex flex-col h-full min-h-0 pt-1">
      {/* Header — fixed at top of the tab */}
      <div className="flex items-center justify-between flex-shrink-0 mb-2">
        <div className="flex items-center gap-2">
          <span className="section-label">Logs</span>
          <span className="text-[10px] text-[#8E8E93]">
            {filtered.length}{filtered.length !== entries.length ? ` / ${entries.length}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void exportLogs('txt')}
            disabled={exporting || filtered.length === 0}
            className="flex items-center gap-1 text-[11px] font-medium text-ios-blue hover:opacity-80 transition-opacity active:scale-95 disabled:opacity-40"
            title="Export filtered logs as text"
          >
            <FileText size={12} strokeWidth={2.5} />
            Export
          </button>
          <button
            onClick={() => void exportLogs('json')}
            disabled={exporting || filtered.length === 0}
            className="flex items-center gap-1 text-[11px] font-medium text-ios-blue hover:opacity-80 transition-opacity active:scale-95 disabled:opacity-40"
            title="Export filtered logs as JSON"
          >
            <FileJson size={12} strokeWidth={2.5} />
            JSON
          </button>
          {entries.length > 0 && (
            <button
              onClick={clearConfirm.trigger}
              disabled={clearing}
              className={`flex items-center gap-1 text-[11px] font-medium transition-opacity active:scale-95 ${
                clearConfirm.pending ? 'text-white bg-ios-red px-2 py-0.5 rounded-full' : 'text-ios-red hover:opacity-80'
              }`}
              title={clearConfirm.pending ? 'Click again to clear' : 'Clear all logs'}
            >
              <Trash2 size={12} strokeWidth={2.5} />
              {clearConfirm.pending ? 'Click again' : 'Clear'}
            </button>
          )}
        </div>
      </div>

      {/* Collapsible filters — closed by default; a one-line summary next to
          the toggle shows active filters without needing to expand. */}
      <div className="flex-shrink-0 mb-2">
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
            {/* Emit-level selector — flows into settings.logLevel. Changes take
                effect live on the daemon without a restart. */}
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-[#8E8E93]">Daemon log level:</label>
              <select
                value={settings?.logLevel ?? 'info'}
                onChange={(e) => { void handleLevelEmitChange(e.target.value as LogLevel); }}
                disabled={!settings}
                className="text-[11px] font-medium bg-[#8E8E93]/10 text-black dark:text-white rounded-full px-2 py-0.5 disabled:opacity-40"
                title="Minimum severity the daemon emits. Lower to DEBUG only when troubleshooting."
              >
                {LEVEL_ORDER.map((l) => (
                  <option key={l} value={l}>{l.toUpperCase()}</option>
                ))}
              </select>
            </div>

            {/* Client-side level filter chips — hide / unhide levels in view. */}
            <div className="flex flex-wrap gap-1">
              {LEVEL_ORDER.map((level) => (
                <button
                  key={level}
                  onClick={() => toggleLevel(level)}
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
                    levelMask.has(level)
                      ? 'bg-ios-blue text-white'
                      : 'bg-[#8E8E93]/10 text-[#8E8E93] hover:bg-[#8E8E93]/20'
                  }`}
                >
                  {level.toUpperCase()}
                </button>
              ))}
            </div>

            {tagsInView.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {tagsInView.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
                      tagMask.has(tag)
                        ? 'bg-ios-blue text-white'
                        : 'bg-[#8E8E93]/10 text-[#8E8E93] hover:bg-[#8E8E93]/20'
                    }`}
                    title={`Filter to ${tag} entries`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            <input
              type="text"
              placeholder="Search messages…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full text-[11px] bg-[#8E8E93]/10 text-black dark:text-white rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ios-blue"
            />
          </div>
        )}
      </div>

      {error && (
        <div className="glass-card px-3 py-2 text-[11px] text-ios-red flex-shrink-0 mb-2">{error}</div>
      )}

      {/* Log list — fills remaining height with a single internal scroll.
          flex-1 + min-h-0 gives it a bounded height so the inner absolute-
          positioned scroll pane can take over. */}
      <div className="flex-1 min-h-0 relative">
        {showEmptyState && (
          <div className="glass-card px-4 py-10 text-center">
            <p className="text-[13px] font-medium text-black dark:text-white">No logs yet</p>
            <p className="text-[11px] text-[#8E8E93] mt-1">
              Daemon activity will stream here in real time.
            </p>
          </div>
        )}

        {showNoMatchState && (
          <div className="glass-card px-4 py-6 text-center">
            <p className="text-[12px] text-[#8E8E93]">
              No entries match your filters.
            </p>
          </div>
        )}

        {filtered.length > 0 && (
          <>
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="absolute inset-0 glass-card px-2 py-2 font-mono text-[10.5px] leading-[1.35] overflow-y-auto overflow-x-auto"
            >
              {truncated && (
                <div className="flex items-center justify-between px-1 py-1 text-[10px] text-[#8E8E93]">
                  <span>
                    Showing last {VISIBLE_CAP} of {filtered.length} filtered entries
                  </span>
                  <button
                    onClick={() => setShowAll(true)}
                    className="text-ios-blue font-semibold hover:opacity-80"
                  >
                    Show all
                  </button>
                </div>
              )}
              {visible.map((e) => (
                <div
                  key={e.seq}
                  className={`whitespace-pre-wrap break-words ${LEVEL_STYLE[e.level]}`}
                >
                  <span className="text-[#8E8E93]">{formatTime(e.timestamp)}</span>{' '}
                  <span className="font-semibold">{e.level.toUpperCase().padEnd(5)}</span>{' '}
                  {e.tag && <span className="text-ios-blue">[{e.tag}]</span>}{' '}
                  {e.tag && e.message.startsWith(`[${e.tag}]`) ? e.message.slice(e.tag.length + 2).trimStart() : e.message}
                </div>
              ))}
            </div>
            {!stickToBottom && (
              <button
                onClick={jumpToBottom}
                title="Follow new entries"
                aria-label="Follow new entries"
                className="absolute bottom-2 right-3 flex items-center justify-center w-7 h-7 rounded-full bg-ios-blue/70 hover:bg-ios-blue text-white backdrop-blur-sm shadow-[0_2px_6px_rgba(0,0,0,0.25)] transition-colors active:scale-90"
              >
                <ArrowDown size={14} strokeWidth={2.5} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
