import type { SwitchingMode } from '@sentinel/shared';

/**
 * Visual status shared by AccountCard (Accounts tab) and AccountViewPicker
 * (Usage/Metrics/Alerts/Security tabs). Keeping the derivation centralized
 * ensures the dropdown and the card can never disagree about which accounts
 * are rotating in round-robin mode.
 */
export type AccountStatus = 'active' | 'excluded' | 'inactive';

export function getAccountStatus(params: {
  isActive: boolean;
  switchingMode: SwitchingMode;
  inPool: boolean;
}): AccountStatus {
  if (params.switchingMode === 'round-robin') {
    return params.inPool ? 'active' : 'excluded';
  }
  return params.isActive ? 'active' : 'inactive';
}
