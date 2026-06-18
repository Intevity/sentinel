import React from 'react';
import { Shield, ShieldAlert, ShieldX, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { SecurityKind, SecuritySeverity } from '@sentinel/shared';
import { DUR, EASE_STD } from '../lib/motion.js';
import type { SecurityBannerPayload } from '../hooks/useSecurityBanner.js';

interface SeverityStyle {
  Icon: typeof Shield;
  iconColor: string;
  iconBg: string;
  ring: string;
  bg: string;
  pillBg: string;
  pillText: string;
}

const SEVERITY_STYLE: Record<SecuritySeverity, SeverityStyle> = {
  low: {
    Icon: Shield,
    iconColor: 'text-ios-yellow',
    iconBg: 'bg-ios-yellow/15',
    ring: 'ring-ios-yellow/30',
    bg: 'bg-ios-yellow/[0.08] dark:bg-ios-yellow/[0.12]',
    pillBg: 'bg-ios-yellow/15',
    pillText: 'text-ios-yellow',
  },
  medium: {
    Icon: ShieldAlert,
    iconColor: 'text-ios-orange',
    iconBg: 'bg-ios-orange/15',
    ring: 'ring-ios-orange/30',
    bg: 'bg-ios-orange/[0.08] dark:bg-ios-orange/[0.12]',
    pillBg: 'bg-ios-orange/15',
    pillText: 'text-ios-orange',
  },
  high: {
    Icon: ShieldX,
    iconColor: 'text-ios-red',
    iconBg: 'bg-ios-red/15',
    ring: 'ring-ios-red/30',
    bg: 'bg-ios-red/[0.08] dark:bg-ios-red/[0.12]',
    pillBg: 'bg-ios-red/15',
    pillText: 'text-ios-red',
  },
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

interface Props {
  banner: SecurityBannerPayload;
  onView: () => void;
  onDismiss: () => void;
}

/**
 * Transient slip banner shown when a security broadcast arrives while the
 * user is on a non-Security tab. Clicking routes to the Security tab and
 * deep-links to the matching event row (same wiring as the OS notification's
 * Details action); X dismisses without navigating.
 */
export default function SecurityAlertBanner({
  banner,
  onView,
  onDismiss,
}: Props): React.ReactElement {
  const style = SEVERITY_STYLE[banner.severity];
  const Icon = style.Icon;

  const subtitle =
    banner.kind === 'pending'
      ? 'Approval required'
      : `${banner.severity.toUpperCase()} · ${KIND_LABEL[banner.eventKind]}`;

  const handleDismiss = (e: React.MouseEvent): void => {
    e.stopPropagation();
    onDismiss();
  };

  return (
    <motion.div
      initial={{ y: -8, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -8, opacity: 0 }}
      transition={{ duration: DUR.med, ease: EASE_STD }}
      className="mx-4 mt-2"
    >
      <button
        type="button"
        onClick={onView}
        className={`w-full text-left rounded-2xl ${style.bg} ring-1 ${style.ring} px-3 py-2.5 flex items-start gap-3 hover:brightness-105 active:scale-[0.99] transition-all`}
        aria-label={`Security alert: ${banner.title}. Click to view.`}
      >
        <div
          className={`flex-shrink-0 w-7 h-7 rounded-full ${style.iconBg} flex items-center justify-center`}
        >
          <Icon size={14} strokeWidth={2.2} className={style.iconColor} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-[12px] font-semibold text-black dark:text-white truncate">
              {banner.title}
            </p>
            {banner.kind === 'pending' && (
              <span
                className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${style.pillBg} ${style.pillText} shrink-0`}
              >
                Action required
              </span>
            )}
          </div>
          <p className="text-[10.5px] text-muted mt-0.5 leading-snug">{subtitle}</p>
        </div>
        <span
          onClick={handleDismiss}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onDismiss();
            }
          }}
          className="text-muted hover:text-black dark:hover:text-white transition-colors active:scale-90 shrink-0 mt-0.5 cursor-pointer"
          aria-label="Dismiss"
        >
          <X size={13} strokeWidth={2.5} />
        </span>
      </button>
    </motion.div>
  );
}
