import React, { useMemo, useState } from 'react';
import { Check, CheckCheck, Shield, ShieldAlert, ShieldX } from 'lucide-react';
import type { AccountInfo, NotificationRecord, NotificationType } from '@sentinel/shared';
import { sendToSentinel } from '../lib/ipc.js';
import { accountColor } from '../lib/accountColor.js';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll.js';
import AccountColorDot from './AccountColorDot.js';

export type NotificationCategoryFilter = 'all' | 'usage' | 'security';

const SECURITY_TYPES: ReadonlySet<NotificationType> = new Set([
  'security_low',
  'security_medium',
  'security_high',
]);

const SEVERITY_ICON: Record<string, typeof Shield> = {
  security_low: Shield,
  security_medium: ShieldAlert,
  security_high: ShieldX,
};

const SEVERITY_CLR: Record<string, string> = {
  security_low: 'text-ios-green',
  security_medium: 'text-ios-orange',
  security_high: 'text-ios-red',
};

const SEVERITY_BG: Record<string, string> = {
  security_low: 'bg-ios-green/10',
  security_medium: 'bg-ios-orange/10',
  security_high: 'bg-ios-red/10',
};

interface NotificationHistoryProps {
  notifications?: NotificationRecord[];
  /** When set, only notifications scoped to this account (or global,
   *  account_id == null) are shown. Omit to render the full history. */
  accountId?: string;
  /** Enrolled accounts — used only to resolve the per-row color dot that
   *  keys each notification to its originating account. Optional so
   *  existing call sites still compile; omitted means muted-gray dots. */
  accounts?: AccountInfo[];
  /** Category chip state. The filter is now applied server-side via
   *  useNotifications.types in the parent — these props are wire-only.
   *  When omitted (legacy callers), the chip group hides. */
  categoryFilter?: NotificationCategoryFilter;
  onCategoryFilterChange?: (next: NotificationCategoryFilter) => void;
  /** Pagination handle. When `loadMore` is provided, the component
   *  appends an IntersectionObserver sentinel beneath the list so it
   *  can grow as the user scrolls. Without it, the list renders
   *  single-shot (legacy callers). */
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMore?: () => void;
  onRefresh?: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  overage_entered: 'bg-ios-orange/10 text-ios-orange',
  overage_disabled: 'bg-ios-red/10 text-ios-red',
  account_switched: 'bg-ios-blue/10 text-ios-blue',
  usage_alert: 'bg-ios-blue/10 text-ios-blue',
  security_low: 'bg-ios-green/10 text-ios-green',
  security_medium: 'bg-ios-orange/10 text-ios-orange',
  security_high: 'bg-ios-red/10 text-ios-red',
};

function isSecurityType(t: NotificationType): boolean {
  return SECURITY_TYPES.has(t);
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

export default function NotificationHistory({
  notifications = [],
  accountId,
  accounts,
  categoryFilter: categoryFilterProp,
  onCategoryFilterChange,
  hasMore = false,
  loadingMore = false,
  loadMore,
  onRefresh,
}: NotificationHistoryProps): React.ReactElement {
  const [acknowledging, setAcknowledging] = useState<number | null>(null);
  const [dismissingAll, setDismissingAll] = useState(false);

  // Local-only fallback for legacy callers that don't pass the lifted
  // filter state. New call sites (AlertsEditor) own the state above so
  // it can drive server-side `useNotifications.types`.
  const [localCategoryFilter, setLocalCategoryFilter] = useState<NotificationCategoryFilter>('all');
  const categoryFilter = categoryFilterProp ?? localCategoryFilter;
  const setCategoryFilter = onCategoryFilterChange ?? setLocalCategoryFilter;
  const filterIsServerDriven = categoryFilterProp !== undefined;

  const sentinelRef = useInfiniteScroll({
    hasMore,
    loading: loadingMore,
    loadMore: loadMore ?? (() => undefined),
  });

  const colorFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts ?? []) map.set(a.id, accountColor(a));
    return (id: string | null): string | null => (id ? (map.get(id) ?? null) : null);
  }, [accounts]);

  const handleAcknowledge = async (id: number): Promise<void> => {
    setAcknowledging(id);
    try {
      await sendToSentinel({ type: 'acknowledge_notification', id });
      onRefresh?.();
    } finally {
      setAcknowledging(null);
    }
  };

  const handleDismissAll = async (): Promise<void> => {
    setDismissingAll(true);
    try {
      await sendToSentinel(
        accountId
          ? { type: 'acknowledge_all_notifications', accountId }
          : { type: 'acknowledge_all_notifications' },
      );
      onRefresh?.();
    } finally {
      setDismissingAll(false);
    }
  };

  // Account scoping: server-side when AlertsEditor passes the lifted
  // categoryFilter (it also passes accountId to the daemon), otherwise
  // we fall back to client-side scoping for legacy callers.
  const scoped = filterIsServerDriven
    ? notifications
    : accountId !== undefined
      ? notifications.filter((n) => n.accountId === accountId || n.accountId == null)
      : notifications;

  const filtered = filterIsServerDriven
    ? scoped
    : scoped.filter((n) => {
        if (categoryFilter === 'all') return true;
        if (categoryFilter === 'security') return isSecurityType(n.type);
        return !isSecurityType(n.type);
      });

  const unread = filtered.filter((n) => !n.acknowledged);
  const read = filtered.filter((n) => n.acknowledged);
  const sorted = [...unread, ...read];

  // When the parent owns the filter state, always surface the chips —
  // gating on the loaded set (which is itself filtered) would let the
  // chip group hide and trap the user on a category they can't escape.
  // Legacy callers (no lifted state) still use the loaded-set heuristic.
  const hasSecurity = filterIsServerDriven || scoped.some((n) => isSecurityType(n.type));

  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="section-label">Alerts</span>
          {unread.length > 0 && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-ios-blue text-white">
              {unread.length}
            </span>
          )}
        </div>
        {unread.length > 0 && (
          <button
            onClick={() => void handleDismissAll()}
            disabled={dismissingAll}
            className="flex items-center gap-1 text-[11px] font-medium text-ios-blue hover:opacity-80 transition-opacity active:scale-95 disabled:opacity-40"
          >
            <CheckCheck size={12} strokeWidth={2.5} />
            {dismissingAll ? 'Dismissing…' : 'Dismiss all'}
          </button>
        )}
      </div>

      {hasSecurity && (
        <div className="flex gap-1 mb-2">
          {(['all', 'usage', 'security'] as const).map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
                categoryFilter === cat
                  ? 'bg-ios-blue text-white'
                  : 'bg-muted/10 text-muted hover:bg-muted/20'
              }`}
            >
              {cat === 'all' ? 'All' : cat === 'usage' ? 'Usage' : 'Security'}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-black dark:text-white">No alerts yet</p>
          <p className="text-[11px] text-muted mt-1">
            Overage and account switch events appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((notif) => {
            const typeStyle = TYPE_COLORS[notif.type] ?? 'bg-muted/10 text-muted';
            const security = isSecurityType(notif.type);
            const SeverityIcon = security ? SEVERITY_ICON[notif.type] : null;
            const severityColor = security ? SEVERITY_CLR[notif.type] : '';
            const severityBg = security ? SEVERITY_BG[notif.type] : '';
            return (
              <div
                key={notif.id}
                className={`glass-card p-3 transition-opacity duration-300 ${
                  notif.acknowledged ? 'opacity-45' : ''
                }`}
              >
                <div className="flex items-start gap-3">
                  {security && SeverityIcon ? (
                    <div
                      className={`flex-shrink-0 w-8 h-8 rounded-full ${severityBg} flex items-center justify-center`}
                    >
                      <SeverityIcon size={15} className={severityColor} strokeWidth={2} />
                    </div>
                  ) : (
                    <div className="flex-shrink-0 pt-1">
                      <AccountColorDot color={colorFor(notif.accountId)} size="sm" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                      {security && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-muted/10 text-muted tracking-wider">
                          SECURITY
                        </span>
                      )}
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${typeStyle}`}
                      >
                        {security
                          ? notif.type.replace('security_', '').toUpperCase()
                          : notif.type.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-[13px] font-semibold text-black dark:text-white leading-snug">
                      {notif.title.replace(/^(?:⚠️|🚫|✅)\s*/u, '')}
                    </p>
                    <p className="text-[11px] text-muted mt-0.5 leading-snug">{notif.body}</p>
                    <p className="text-[10px] text-muted/70 mt-1.5">{formatDate(notif.ts)}</p>
                  </div>
                  {!notif.acknowledged && (
                    <button
                      onClick={() => void handleAcknowledge(notif.id)}
                      disabled={acknowledging === notif.id}
                      className="flex-shrink-0 w-7 h-7 rounded-full bg-ios-blue/10 hover:bg-ios-blue/20
                                 active:scale-90 disabled:opacity-40 transition-all flex items-center justify-center"
                      title="Dismiss"
                    >
                      <Check size={13} className="text-ios-blue" strokeWidth={2.5} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {loadMore && hasMore && (
            <div ref={sentinelRef} className="py-3 text-center text-[10px] text-muted">
              {loadingMore ? 'Loading more…' : ' '}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
