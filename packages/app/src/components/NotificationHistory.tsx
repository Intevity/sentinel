import React, { useState } from 'react';
import { Check, CheckCheck } from 'lucide-react';
import type { NotificationRecord } from '@claude-sentinel/shared';
import { sendToSentinel } from '../lib/ipc.js';

interface NotificationHistoryProps {
  notifications?: NotificationRecord[];
  /** When set, only notifications scoped to this account (or global,
   *  account_id == null) are shown. Omit to render the full history. */
  accountId?: string;
  onRefresh?: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  overage_entered:        'bg-ios-orange/10 text-ios-orange',
  overage_disabled:       'bg-ios-red/10 text-ios-red',
  account_switched:       'bg-ios-blue/10 text-ios-blue',
  usage_alert:            'bg-ios-blue/10 text-ios-blue',
  all_accounts_exhausted: 'bg-ios-red/10 text-ios-red',
};

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts));
}

export default function NotificationHistory({
  notifications = [],
  accountId,
  onRefresh,
}: NotificationHistoryProps): React.ReactElement {
  const [acknowledging, setAcknowledging] = useState<number | null>(null);
  const [dismissingAll, setDismissingAll] = useState(false);

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

  // Show only notifications tied to the active account, plus global events
  // that aren't bound to any account (account_id IS NULL).
  const scoped = accountId !== undefined
    ? notifications.filter((n) => n.accountId === accountId || n.accountId == null)
    : notifications;

  const unread = scoped.filter((n) => !n.acknowledged);
  const read   = scoped.filter((n) => n.acknowledged);
  const sorted = [...unread, ...read];

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

      {scoped.length === 0 ? (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-black dark:text-white">No alerts yet</p>
          <p className="text-[11px] text-[#8E8E93] mt-1">
            Overage and account switch events appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((notif) => {
            const typeStyle = TYPE_COLORS[notif.type] ?? 'bg-[#8E8E93]/10 text-[#8E8E93]';
            return (
              <div
                key={notif.id}
                className={`glass-card p-3 transition-opacity duration-300 ${
                  notif.acknowledged ? 'opacity-45' : ''
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${typeStyle}`}>
                        {notif.type.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-[13px] font-semibold text-black dark:text-white leading-snug">
                      {notif.title.replace(/^[⚠️🚫✅]\s*/, '')}
                    </p>
                    <p className="text-[11px] text-[#8E8E93] mt-0.5 leading-snug">{notif.body}</p>
                    <p className="text-[10px] text-[#8E8E93]/70 mt-1.5">{formatDate(notif.ts)}</p>
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
        </div>
      )}
    </div>
  );
}
