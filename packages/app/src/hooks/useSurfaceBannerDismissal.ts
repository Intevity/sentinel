import { useEffect, useState } from 'react';
import {
  clearSurfaceBannerDismissal,
  dismissSurfaceBanner,
  isSurfaceBannerDismissed,
  type DismissibleSurface,
} from '../lib/surfaceBannerDismissal.js';

/**
 * Dismissal state for a "Route <surface> through Sentinel" card. `routed` is
 * whether the surface currently goes through Sentinel; once it does, the
 * stored dismissal is cleared (see surfaceBannerDismissal.ts for why).
 */
export function useSurfaceBannerDismissal(
  surface: DismissibleSurface,
  routed: boolean,
): { dismissed: boolean; dismiss: () => void } {
  const [dismissed, setDismissed] = useState(() => isSurfaceBannerDismissed(surface));

  useEffect(() => {
    if (!routed) return;
    clearSurfaceBannerDismissal(surface);
    setDismissed(false);
  }, [surface, routed]);

  const dismiss = (): void => {
    dismissSurfaceBanner(surface);
    setDismissed(true);
  };

  return { dismissed, dismiss };
}
