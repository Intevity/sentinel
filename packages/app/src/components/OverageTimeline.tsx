import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AlertTriangle, CheckCircle, XCircle, PauseCircle, PlayCircle, Trash2 } from 'lucide-react';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';
import type { OverageEvent } from '@claude-sentinel/shared';

/** In-memory pause event tracked from `account_paused`/`account_unpaused`
 *  broadcasts. Not persisted — the timeline only reflects pauses that have
 *  happened while this UI instance has been mounted. */
interface PauseEvent {
  id: string;
  ts: number;
  accountId: string;
  kind: 'paused' | 'unpaused';
  reason?: 'sentinel_budget' | 'anthropic_overage_disabled';
}

interface OverageTimelineProps {
  /** Incremented by useDaemon on each overage broadcast — triggers a re-fetch. */
  overageVersion: number;
  /** View-scope account. When undefined the daemon returns events across all
   *  accounts (legacy behavior). The per-tab picker in App.tsx sets this. */
  viewAccountId?: string | undefined;
}

const TRANSITION_META = {
  entered: {
    Icon: AlertTriangle,
    color: 'text-ios-orange',
    bg: 'bg-ios-orange/10',
    label: 'Overage started',
  },
  exited: {
    Icon: CheckCircle,
    color: 'text-ios-green',
    bg: 'bg-ios-green/10',
    label: 'Overage ended',
  },
  disabled: {
    Icon: XCircle,
    color: 'text-ios-red',
    bg: 'bg-ios-red/10',
    label: 'Overage disabled',
  },
} as const;

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

export default function OverageTimeline({
  overageVersion,
  viewAccountId,
}: OverageTimelineProps): React.ReactElement {
  const [events, setEvents] = useState<OverageEvent[]>([]);
  const [pauseEvents, setPauseEvents] = useState<PauseEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to live pause/unpause broadcasts. The daemon does NOT persist
  // these (pause state lives in-memory on the tracker) so our visibility is
  // bounded to the current session. Good enough for "what just happened?"
  // debugging; a persistent audit log would need a new DB table.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'account_paused' && (!viewAccountId || msg.accountId === viewAccountId)) {
        const pe: PauseEvent = {
          id: `pause-${msg.accountId}-${Date.now()}`,
          ts: Date.now(),
          accountId: msg.accountId,
          kind: 'paused',
          reason: msg.reason,
        };
        setPauseEvents((prev) => [pe, ...prev].slice(0, 50));
      } else if (
        msg.type === 'account_unpaused' &&
        (!viewAccountId || msg.accountId === viewAccountId)
      ) {
        const pe: PauseEvent = {
          id: `unpause-${msg.accountId}-${Date.now()}`,
          ts: Date.now(),
          accountId: msg.accountId,
          kind: 'unpaused',
        };
        setPauseEvents((prev) => [pe, ...prev].slice(0, 50));
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [viewAccountId]);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sendToSentinel<OverageEvent[]>(
        viewAccountId
          ? { type: 'get_overage_events', limit: 100, accountId: viewAccountId }
          : { type: 'get_overage_events', limit: 100 },
      );
      setEvents(res.data ?? []);
    } catch {
      // keep whatever we had
    } finally {
      setLoading(false);
    }
  }, [viewAccountId]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents, overageVersion]);

  useEffect(
    () => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    },
    [],
  );

  const handleClearClick = useCallback(async () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      confirmTimerRef.current = setTimeout(() => setConfirmingClear(false), 4000);
      return;
    }
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmingClear(false);
    try {
      await sendToSentinel(
        viewAccountId
          ? { type: 'clear_overage_events', accountId: viewAccountId }
          : { type: 'clear_overage_events' },
      );
    } catch {
      // swallow — the refetch below will resurface the current truth
    }
    await fetchEvents();
  }, [confirmingClear, viewAccountId, fetchEvents]);

  return (
    <div className="space-y-2 pt-1">
      <div className="mb-3 flex items-center justify-between">
        <span className="section-label">Overage Events</span>
        {events.length > 0 && (
          <button
            onClick={() => void handleClearClick()}
            className={`flex items-center gap-1 text-[11px] font-medium transition-colors active:scale-95 ${
              confirmingClear
                ? 'text-white bg-ios-red px-2 py-0.5 rounded-full'
                : 'text-ios-red hover:text-ios-red/70'
            }`}
            title={confirmingClear ? 'Click again to clear' : 'Clear all overage events'}
          >
            <Trash2 size={12} strokeWidth={2.5} />
            {confirmingClear ? 'Click again' : 'Clear'}
          </button>
        )}
      </div>

      {!loading && events.length === 0 && pauseEvents.length === 0 ? (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-black dark:text-white">No overage events</p>
          <p className="text-[11px] text-[#8E8E93] mt-1">
            Events appear when Claude Code enters or exits overage budget.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {pauseEvents.map((pe) => {
            const Icon = pe.kind === 'paused' ? PauseCircle : PlayCircle;
            const color = pe.kind === 'paused' ? 'text-ios-red' : 'text-ios-green';
            const bg = pe.kind === 'paused' ? 'bg-ios-red/10' : 'bg-ios-green/10';
            const label =
              pe.kind === 'paused'
                ? pe.reason === 'sentinel_budget'
                  ? 'Paused by Sentinel budget'
                  : 'Paused: overage disabled'
                : 'Resumed';
            return (
              <div key={pe.id} className="glass-card p-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`flex-shrink-0 w-8 h-8 rounded-full ${bg} flex items-center justify-center`}
                  >
                    <Icon size={15} className={color} strokeWidth={2} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[13px] font-semibold ${color}`}>{label}</p>
                    <p className="text-[11px] text-[#8E8E93] mt-0.5 truncate">{pe.accountId}</p>
                  </div>
                  <span className="flex-shrink-0 text-[10px] text-[#8E8E93] mt-0.5">
                    {formatDate(pe.ts)}
                  </span>
                </div>
              </div>
            );
          })}
          {events.map((event) => {
            const meta = TRANSITION_META[event.transition] ?? TRANSITION_META.entered;
            const { Icon, color, bg, label } = meta;
            return (
              <div key={event.id} className="glass-card p-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`flex-shrink-0 w-8 h-8 rounded-full ${bg} flex items-center justify-center`}
                  >
                    <Icon size={15} className={color} strokeWidth={2} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[13px] font-semibold ${color}`}>{label}</p>
                    <p className="text-[11px] text-[#8E8E93] mt-0.5 truncate">{event.accountId}</p>
                    {event.disabledReason && (
                      <p className="text-[11px] text-[#8E8E93]">Reason: {event.disabledReason}</p>
                    )}
                    {event.resetsAt && (
                      <p className="text-[11px] text-[#8E8E93]">
                        Resets: {formatDate(event.resetsAt * 1000)}
                      </p>
                    )}
                  </div>
                  <span className="flex-shrink-0 text-[10px] text-[#8E8E93] mt-0.5">
                    {formatDate(event.ts)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
