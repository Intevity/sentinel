import { useCallback, useEffect, useState } from 'react';
import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window';

const WIDTH = 480;
const MIN_HEIGHT = 260;
const MAX_HEIGHT = 600;

export interface AutoResizeRefs {
  rootRef: (el: HTMLDivElement | null) => void;
  contentRef: (el: HTMLDivElement | null) => void;
  /** Attach to a full-surface overlay (e.g. SettingsPanel) so its scroll
   *  height drives the window when it's mounted. Optional. */
  overlayRef: (el: HTMLElement | null) => void;
}

/**
 * Size the Tauri window to fit content: shrinks on light tabs (few accounts,
 * short Overage timeline) and grows up to MAX_HEIGHT on content-heavy tabs
 * (Metrics), where `<main>`'s own overflow-y-auto takes over.
 *
 * Two subtleties:
 *  1. Tauri 2's setSize on macOS does not always yield the inner-content size
 *     you asked for — the title bar can be left out of the accounting. After
 *     the first setSize we read innerSize back and, if the viewport came up
 *     short, record the deficit and add it to every subsequent call. This
 *     self-calibration is robust across Tauri versions and window decoration
 *     configurations.
 *  2. Full-surface overlays (SettingsPanel) are absolute-positioned, so the
 *     main-content measurement misses them. The optional overlayRef plugs
 *     them into the resize loop while they're mounted.
 *
 * Uses callback refs so the effect re-installs when elements attach lazily —
 * e.g. the content wrapper mounts after the startup splash clears, or the
 * overlay mounts when the user opens Settings.
 */
export function useAutoResizeWindow(): AutoResizeRefs {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState<HTMLElement | null>(null);

  const rootRef    = useCallback((el: HTMLDivElement | null) => { setRoot(el); }, []);
  const contentRef = useCallback((el: HTMLDivElement | null) => { setContent(el); }, []);
  const overlayRef = useCallback((el: HTMLElement | null)    => { setOverlay(el); }, []);

  useEffect(() => {
    if (!root || !content) return;
    const main = content.parentElement;
    if (!main) return;

    const appWindow = getCurrentWindow();
    let rafId: number | null = null;
    let lastTarget = 0;
    let chromeOverhead = 0;
    let calibrated = false;
    let inFlight = false;

    const computeInner = (): number => {
      const chrome = main.getBoundingClientRect().top - root.getBoundingClientRect().top;
      // Measure the inner wrapper's natural height — `main.scrollHeight`
      // collapses to clientHeight when content fits, which would prevent the
      // window from ever shrinking back down.
      const mainPadBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
      let needed = chrome + content.offsetHeight + mainPadBottom;
      if (overlay) needed = Math.max(needed, overlay.scrollHeight);
      return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(needed)));
    };

    const apply = async (): Promise<void> => {
      rafId = null;
      if (inFlight) return; // don't stack setSize calls
      const targetInner = computeInner();
      const target = targetInner + chromeOverhead;
      if (target === lastTarget) return;
      lastTarget = target;
      inFlight = true;
      try {
        await appWindow.setSize(new LogicalSize(WIDTH, target));
        if (!calibrated) {
          // Empirically measure: did setSize give us targetInner pixels of
          // viewport height, or did it include the title bar in the total?
          // window.innerHeight is the layout viewport — what CSS sees as
          // 100vh — which is what we actually care about for our content.
          const actualInner = window.innerHeight;
          const deficit = targetInner - actualInner;
          if (deficit > 1) {
            chromeOverhead = deficit;
            lastTarget = targetInner + chromeOverhead;
            await appWindow.setSize(new LogicalSize(WIDTH, lastTarget));
          }
          calibrated = true;
        }
      } finally {
        inFlight = false;
      }
    };

    const schedule = (): void => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => { void apply(); });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(content);
    ro.observe(main);
    ro.observe(root);
    if (overlay) ro.observe(overlay);

    schedule();

    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [root, content, overlay]);

  return { rootRef, contentRef, overlayRef };
}
