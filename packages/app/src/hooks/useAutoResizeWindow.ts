import { useCallback, useEffect, useRef, useState } from 'react';
import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

const WIDTH = 500;
// Footer (~28px) is a sibling of <main>, so the window gets that much taller
// without stealing from page content.
const MIN_HEIGHT = 288;
const MAX_HEIGHT = 628;

export interface AutoResizeRefs {
  rootRef: (el: HTMLDivElement | null) => void;
  contentRef: (el: HTMLDivElement | null) => void;
  /** Attach to a full-surface overlay (e.g. SettingsPanel) so its scroll
   *  height drives the window when it's mounted. Optional. */
  overlayRef: (el: HTMLElement | null) => void;
  /** Attach to a floating element anchored inside the window (e.g. the
   *  HeaderMenu dropdown). Unlike `overlayRef`, this measures the element's
   *  bottom edge relative to the root, so the window grows to reveal a
   *  popover that expands beyond the current viewport. */
  popoverRef: (el: HTMLElement | null) => void;
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
  const [popover, setPopover] = useState<HTMLElement | null>(null);

  const rootRef    = useCallback((el: HTMLDivElement | null) => { setRoot(el); }, []);
  const contentRef = useCallback((el: HTMLDivElement | null) => { setContent(el); }, []);
  const overlayRef = useCallback((el: HTMLElement | null)    => { setOverlay(el); }, []);
  const popoverRef = useCallback((el: HTMLElement | null)    => { setPopover(el); }, []);

  // DevTools open/close state — stored in a ref (not the main effect's
  // closure) so it survives effect re-runs triggered by `popover` /
  // `overlay` changes. Previously this lived as a plain `let` inside the
  // resize effect, which meant opening the HeaderMenu popover while
  // DevTools was open re-ran the effect with `devtoolsOpen = false`, and
  // the next apply() shrank the window back down mid-debug.
  const devtoolsOpenRef = useRef(false);

  // Subscribe to `devtools_state_changed` once per component lifetime.
  // On close, flip the ref AND flag the "please recalibrate" state via
  // a version bump so the main effect re-measures against the restored
  // tray size instead of using the cached 1280×900 chromeOverhead.
  const [recalibVersion, setRecalibVersion] = useState(0);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<{ open: boolean }>('devtools_state_changed', (event) => {
      devtoolsOpenRef.current = event.payload.open;
      if (!event.payload.open) {
        setRecalibVersion((v) => v + 1);
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, []);

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
      const rootTop = root.getBoundingClientRect().top;
      let needed: number;
      if (overlay) {
        // Overlay is a full-surface panel (e.g. SettingsPanel) that
        // visually replaces the main app. Its own content size drives
        // the window — the main-app tab rendered behind it is irrelevant.
        // Without this override, opening Settings from Metrics (tall) would
        // peg the window to Metrics' height regardless of which Settings
        // tab is active.
        needed = overlay.scrollHeight;
      } else {
        // Everything inside root but outside main — header, banners, tab
        // control, AND the footer below main. Stable across window resizes
        // because main absorbs all flex-1 space while the siblings have
        // content-based heights. Using the arithmetic diff avoids needing
        // an explicit ref per sibling.
        const chromeAndFooter = root.offsetHeight - main.offsetHeight;
        // Measure the inner wrapper's natural height — `main.scrollHeight`
        // collapses to clientHeight when content fits, which would prevent the
        // window from ever shrinking back down.
        const mainPadBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
        needed = chromeAndFooter + content.offsetHeight + mainPadBottom;
      }
      if (popover) {
        // The popover is anchored inside the window (e.g. a header dropdown),
        // so its scrollHeight tells us nothing about where it ends visually.
        // Use its bottom edge relative to the root, plus a little breathing
        // room, so the window grows just enough to reveal the whole thing.
        const popoverBottom = popover.getBoundingClientRect().bottom;
        needed = Math.max(needed, popoverBottom - rootTop + 8);
      }
      return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(needed)));
    };

    const apply = async (): Promise<void> => {
      rafId = null;
      if (inFlight) return; // don't stack setSize calls
      // Rust owns the window size while the inspector is docked. Read
      // from the ref (not a closure-local) so popover / overlay-driven
      // effect re-runs don't reset this to false mid-debug.
      if (devtoolsOpenRef.current) return;
      const targetInner = computeInner();
      const target = targetInner + chromeOverhead;

      // Recalibration trigger: if the window isn't rendering at the size we
      // last asked for, the baseline assumption behind `chromeOverhead` is
      // stale. This happens any time something OUTSIDE our control resizes
      // the window — most commonly DevTools docking in or out, but also a
      // user-initiated drag on the window edge. Without this, closing
      // DevTools leaves the hook thinking it's already at the right size
      // (`target === lastTarget`) and the window stays whatever size the
      // teardown left it at.
      const actualInner = window.innerHeight;
      const baselineDrift = lastTarget > 0 && Math.abs((lastTarget - chromeOverhead) - actualInner) > 4;
      if (baselineDrift) {
        calibrated = false;
        lastTarget = 0;
      }

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
          const measured = window.innerHeight;
          const deficit = targetInner - measured;
          if (deficit > 1) {
            chromeOverhead = deficit;
            lastTarget = targetInner + chromeOverhead;
            await appWindow.setSize(new LogicalSize(WIDTH, lastTarget));
          } else if (deficit < -1) {
            // Overshoot (webview ended up LARGER than target). Happens when
            // a prior calibration was polluted by DevTools docking — the
            // cached `chromeOverhead` overstated the chrome. Clamp back to
            // zero so subsequent setSize calls don't keep growing the
            // window past its intended size.
            chromeOverhead = 0;
            lastTarget = targetInner;
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
    if (popover) ro.observe(popover);

    // When DevTools closes (recalibVersion bumps), force a fresh
    // measurement so the tray window snaps back to its content size
    // — otherwise a stale chromeOverhead from the expanded state would
    // make the window an inspector-sized 1280×900 ghost.
    if (recalibVersion > 0) {
      calibrated = false;
      lastTarget = 0;
    }

    schedule();

    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [root, content, overlay, popover, recalibVersion]);

  return { rootRef, contentRef, overlayRef, popoverRef };
}
