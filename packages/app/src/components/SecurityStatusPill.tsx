import React from 'react';
import type { SecurityEvent } from '@sentinel/shared';
import { securityStatusInfo, type SecurityStatusVariant } from '../lib/securityStatusLabel.js';

const VARIANT_CLASS: Record<SecurityStatusVariant, string> = {
  diagnostic: 'text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-muted/15 text-muted',
  allowed: 'text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ios-green/15 text-ios-green',
  denied: 'text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ios-red/15 text-ios-red',
  'timed-out': 'text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-muted/15 text-muted',
  muted: 'text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-muted/15 text-muted',
  blocked: 'text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-ios-red text-white',
  detected: 'text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ios-orange/15 text-ios-orange',
};

/** Unified status indicator on every security-event row. Replaces the
 *  inconsistent "BLOCKED" badge that only showed on one outcome. The
 *  (event → label/variant) decision lives in `securityStatusInfo`
 *  (lib/securityStatusLabel.ts) so it's covered by a pure-logic test. */
export default function SecurityStatusPill({
  event,
}: {
  event: SecurityEvent;
}): React.ReactElement {
  const info = securityStatusInfo(event);
  return (
    <span className={VARIANT_CLASS[info.variant]} data-testid="status-pill">
      {info.label}
    </span>
  );
}
