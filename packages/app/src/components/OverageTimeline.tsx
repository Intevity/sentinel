import React, { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { sendToSentinel } from '../lib/ipc.js';
import type { OverageEvent } from '@claude-sentinel/shared';

interface OverageTimelineProps {
  /** Incremented by useDaemon on each overage broadcast — triggers a re-fetch. */
  overageVersion: number;
}

const TRANSITION_META = {
  entered:  { Icon: AlertTriangle, color: 'text-ios-orange', bg: 'bg-ios-orange/10', label: 'Overage started' },
  exited:   { Icon: CheckCircle,   color: 'text-ios-green',  bg: 'bg-ios-green/10',  label: 'Overage ended'   },
  disabled: { Icon: XCircle,       color: 'text-ios-red',    bg: 'bg-ios-red/10',    label: 'Overage disabled' },
} as const;

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts));
}

export default function OverageTimeline({ overageVersion }: OverageTimelineProps): React.ReactElement {
  const [events, setEvents] = useState<OverageEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sendToSentinel<OverageEvent[]>({ type: 'get_overage_events', limit: 100 });
      setEvents(res.data ?? []);
    } catch {
      // keep whatever we had
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents, overageVersion]);

  return (
    <div className="space-y-2 pt-1">
      <div className="mb-3">
        <span className="section-label">Overage Events</span>
      </div>

      {!loading && events.length === 0 ? (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-black dark:text-white">No overage events</p>
          <p className="text-[11px] text-[#8E8E93] mt-1">
            Events appear when Claude Code enters or exits overage budget.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {events.map((event) => {
            const meta = TRANSITION_META[event.transition] ?? TRANSITION_META.entered;
            const { Icon, color, bg, label } = meta;
            return (
              <div key={event.id} className="glass-card p-3">
                <div className="flex items-start gap-3">
                  <div className={`flex-shrink-0 w-8 h-8 rounded-full ${bg} flex items-center justify-center`}>
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
