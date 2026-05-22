import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ListTree } from 'lucide-react';
import type { OptimizationEventRecord, OptimizationEventSourceCall } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../../lib/ipc.js';
import {
  buildListRequest,
  formatBytes,
  formatUsd,
  humanPattern,
  relativeTime,
  savingsColorClass,
  type StatusFilter,
} from '../../lib/opportunityList.js';
import { formatTokens, tokensColorClass, type SavingsUnits } from '../../lib/optimizeUnits.js';

/**
 * Drill-down list of analyzed optimization opportunities. Renders as a
 * collapsible glass-card section so the savings chart and curated
 * subagent list stay the primary surface; this list is for users who
 * want to verify "what's actually being counted?" Each row links back
 * to the source tool_calls that triggered detection.
 *
 * Filters narrow the list along three axes:
 *   - status (realized / potential / dismissed)
 *   - kind (measured / dismissed) - matches the optimization_events.kind
 *   - curated_id - limits to a single subagent's opportunities
 *
 * Pagination is intentionally simple: load 50, "Load more" up to the
 * 500-row IPC ceiling. The dataset is bounded by the analyzer's 7-day
 * dedup window, so we expect rows in the dozens for normal users.
 *
 * The fetch effect runs whenever filters change, regardless of whether
 * the panel is open. Cheap (one IPC round-trip, capped at 500 rows) and
 * keeps the count in the header live without a "click to load" lag.
 */

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

interface ListResponse {
  events: OptimizationEventRecord[];
  total: number;
}

export default function OpportunityList({ units }: { units: SavingsUnits }): React.ReactElement {
  const [events, setEvents] = useState<OptimizationEventRecord[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [curatedFilter, setCuratedFilter] = useState<string>('all');
  // `searchInput` is the raw text from the box; `search` is the
  // debounced value that actually drives the IPC. Two-state setup keeps
  // typing snappy without flooding the daemon.
  const [searchInput, setSearchInput] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [offset, setOffset] = useState<number>(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(
    async (
      currentStatus: StatusFilter,
      currentCurated: string,
      currentSearch: string,
      currentOffset: number,
    ) => {
      setLoading(true);
      setError(null);
      const req = buildListRequest(
        currentStatus,
        currentCurated,
        PAGE_SIZE,
        currentOffset,
        currentSearch,
      );
      const r = await sendToSentinel<ListResponse>(req);
      if (r.success && r.data) {
        setEvents(r.data.events);
        setTotal(r.data.total);
      } else {
        setError(r.error ?? 'failed to load opportunities');
      }
      setLoading(false);
    },
    [],
  );

  // Debounce the search input so each keystroke doesn't fire a request.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset offset on any filter / search change. Keeps the user from
  // landing on an out-of-range page after narrowing the result set.
  useEffect(() => {
    setOffset(0);
  }, [statusFilter, curatedFilter, search]);

  useEffect(() => {
    void fetchEvents(statusFilter, curatedFilter, search, offset);
  }, [fetchEvents, statusFilter, curatedFilter, search, offset]);

  useEffect(() => {
    let active = true;
    const unsubP = onDaemonMessage((msg) => {
      if (!active) return;
      // Refetch on the same broadcast the dashboard already listens to,
      // so the drill-down stays in sync with the savings chart. We
      // preserve the user's current page/filter state.
      if (msg.type === 'optimization_metrics_updated') {
        void fetchEvents(statusFilter, curatedFilter, search, offset);
      }
    });
    return () => {
      active = false;
      void unsubP.then((u) => u());
    };
  }, [fetchEvents, statusFilter, curatedFilter, search, offset]);

  const curatedOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const e of events) ids.add(e.curatedId);
    return [...ids].sort();
  }, [events]);

  const toggleExpanded = (id: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;
  const summary = total === 0 ? 'no events' : `${total} event${total === 1 ? '' : 's'}`;

  return (
    <div className="glass-card px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-foreground/55" />
        ) : (
          <ChevronRight className="h-3 w-3 text-foreground/55" />
        )}
        <ListTree className="h-3 w-3 text-foreground/65" />
        <h3 className="section-label">Opportunities analyzed</h3>
        <span className="ml-auto text-[10px] text-foreground/55">{summary}</span>
      </button>

      {open && (
        <div className="mt-3">
          <p className="mb-3 text-[11px] text-foreground/55">
            The events that drive the totals above. Click a row to see the source tool calls.
          </p>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <FilterChips value={statusFilter} onChange={setStatusFilter} />
            {curatedOptions.length > 0 && (
              <select
                value={curatedFilter}
                onChange={(e) => setCuratedFilter(e.target.value)}
                className="rounded border border-border-subtle/15 bg-surface-overlay/5 px-2 py-1 text-xs text-foreground/80"
                aria-label="Filter by curated subagent"
              >
                <option value="all">All subagents</option>
                {curatedOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search subagent, pattern, session"
              aria-label="Search opportunities"
              className="ml-auto min-w-[180px] flex-1 rounded border border-border-subtle/15 bg-surface-overlay/5 px-2 py-1 text-xs text-foreground/80 placeholder:text-foreground/35 focus:border-border-subtle/30 focus:outline-none"
            />
          </div>

          {error !== null && (
            <div className="mb-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          {events.length === 0 && !loading ? (
            <p className="py-6 text-center text-xs text-foreground/55">
              {search.length > 0 || statusFilter !== 'all' || curatedFilter !== 'all'
                ? 'No opportunities match these filters.'
                : 'No opportunities detected yet. Sentinel scans every minute; check back after a session.'}
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle/5">
              {events.map((ev) => (
                <OpportunityRow
                  key={ev.id}
                  ev={ev}
                  expanded={expanded.has(ev.id)}
                  onToggle={() => toggleExpanded(ev.id)}
                  units={units}
                />
              ))}
            </ul>
          )}

          {total > PAGE_SIZE && (
            <div className="mt-3 flex items-center justify-between text-[11px] text-foreground/55">
              <button
                type="button"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={!canPrev}
                className="rounded border border-border-subtle/15 px-2 py-1 text-foreground/70 hover:bg-surface-overlay/5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Prev
              </button>
              <span className="tabular-nums">
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={!canNext}
                className="rounded border border-border-subtle/15 px-2 py-1 text-foreground/70 hover:bg-surface-overlay/5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterChips({
  value,
  onChange,
}: {
  value: StatusFilter;
  onChange: (v: StatusFilter) => void;
}): React.ReactElement {
  // 'dismissed' is supported by the StatusFilter type and the daemon
  // IPC, but no UI control writes a 'dismissed' row today, so showing
  // a chip that always queries an empty result set just confuses
  // users. When we add a real per-row Dismiss button, re-introduce
  // the chip here.
  const options: Array<{ id: StatusFilter; label: string }> = [
    { id: 'all', label: 'All measured' },
    { id: 'realized', label: 'Realized' },
    { id: 'regression', label: 'Regression' },
    { id: 'potential', label: 'Potential' },
  ];
  return (
    <div className="flex gap-1" role="group" aria-label="Status filter">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          aria-pressed={value === opt.id}
          onClick={() => onChange(opt.id)}
          className={`rounded px-2 py-1 text-[11px] ${
            value === opt.id
              ? 'bg-surface-overlay/15 text-foreground'
              : 'border border-border-subtle/10 text-foreground/60 hover:bg-surface-overlay/5'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function OpportunityRow({
  ev,
  expanded,
  onToggle,
  units,
}: {
  ev: OptimizationEventRecord;
  expanded: boolean;
  onToggle: () => void;
  units: SavingsUnits;
}): React.ReactElement {
  const sessionLabel = ev.sessionId === null ? 'cross-session' : ev.sessionId.slice(0, 8);
  const patternLabel = humanPattern(ev.pattern);
  const savingsCost = ev.savingsUsd ?? 0;
  // Token savings (parent-context framing): hypoInputTokens − digestTokens.
  // Pre-migration rows whose hypothetical_total_tokens is null render
  // as 'n/a' since we can't recover hypoInputTokens. The regression
  // pill keys off cost so realized-with-loss reads consistently.
  const tokensSaved =
    ev.hypotheticalTotalTokens === null
      ? null
      : ev.hypotheticalTotalTokens - ev.digestTokens - ev.digestTokens;
  return (
    <li className="py-1.5">
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-[20px_1fr_auto_auto_auto_auto] items-center gap-2 text-left text-[11px] text-foreground/80"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-foreground/55" />
        ) : (
          <ChevronRight className="h-3 w-3 text-foreground/55" />
        )}
        <span className="truncate text-foreground/85">{patternLabel}</span>
        <span className="font-mono text-[10px] text-foreground/45">{sessionLabel}</span>
        <span className="text-[10px] text-foreground/55">{ev.curatedId}</span>
        {units === 'cost' ? (
          <span className={`tabular-nums ${savingsColorClass(savingsCost)}`}>
            {formatUsd(savingsCost)}
          </span>
        ) : tokensSaved === null ? (
          <span
            className="tabular-nums text-foreground/40"
            title="Pre-migration row — token savings not recorded."
          >
            n/a
          </span>
        ) : (
          <span className={`tabular-nums ${tokensColorClass(tokensSaved)}`}>
            {formatTokens(tokensSaved)}
          </span>
        )}
        <StatusPill kind={ev.kind} realized={ev.realized} savings={savingsCost} />
      </button>
      {expanded && <SourceCalls calls={ev.sourceCalls} ts={ev.ts} />}
    </li>
  );
}

/**
 * Three-state pill that distinguishes a realized win from a realized
 * regression. A subagent that's installed but actively making things
 * worse needs its own visual treatment so the user sees it as a
 * problem to fix, not just another row of dollar signs:
 *   - realized + savings ≥ 0 → emerald "realized"
 *   - realized + savings < 0 → red "regression" (subagent is misfit)
 *   - not realized          → sky "potential"
 *   - kind='dismissed'      → grey "dismissed"
 */
function StatusPill({
  kind,
  realized,
  savings,
}: {
  kind: OptimizationEventRecord['kind'];
  realized: boolean;
  savings: number;
}): React.ReactElement {
  if (kind === 'dismissed') {
    return (
      <span className="rounded bg-surface-overlay/10 px-1.5 py-0.5 text-[10px] text-foreground/55">
        dismissed
      </span>
    );
  }
  if (realized) {
    if (savings < -SAVINGS_REGRESSION_THRESHOLD) {
      return (
        <span
          className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-300"
          title="The subagent was installed at detection time but cost more than the inline tool calls would have. Consider uninstalling."
        >
          regression
        </span>
      );
    }
    return (
      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
        realized
      </span>
    );
  }
  return (
    <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">potential</span>
  );
}

/** Half-cent floor for the regression pill, matching the noise floor
 *  in `formatUsd` so the pill never reads "regression" while the
 *  amount cell shows "$0.00". */
const SAVINGS_REGRESSION_THRESHOLD = 0.005;

function SourceCalls({
  calls,
  ts,
}: {
  calls: OptimizationEventSourceCall[];
  ts: number;
}): React.ReactElement {
  if (calls.length === 0) {
    return (
      <p className="ml-5 mt-1 text-[10px] text-foreground/40">
        Source tool calls were pruned from the request log; can't show details.
      </p>
    );
  }
  return (
    <ul className="ml-5 mt-1 space-y-0.5 text-[10px] text-foreground/55">
      {calls.map((c) => (
        <li key={c.id} className="flex items-baseline gap-2">
          <span className="font-mono text-foreground/70">{c.toolName}</span>
          <span className="truncate font-mono text-foreground/50">{c.filePath ?? '(no path)'}</span>
          <span className="ml-auto tabular-nums text-foreground/45">
            {formatBytes(c.responseSizeBytes)}
          </span>
          <span className="tabular-nums text-foreground/35">{relativeTime(c.ts, ts)}</span>
        </li>
      ))}
    </ul>
  );
}
