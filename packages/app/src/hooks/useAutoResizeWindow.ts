import { useCallback, useEffect, useRef, useState } from 'react';
import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import {
  computeTargetInner,
  reconcileOverlayRef,
  TRAY_WIDTH,
} from './useAutoResizeWindow.logic.js';

const WIDTH = TRAY_WIDTH;

/** Flip to true when debugging resize behavior. Tags every frame with
 *  what it read from the DOM and what it asked Tauri to do — the only
 *  way to tell whether a fix actually ran in the webview. Cheap enough
 *  to leave on during targeted verification; clear when shipping. */
const AUTO_RESIZE_DEBUG = true;

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

  const rootRef = useCallback((el: HTMLDivElement | null) => {
    setRoot(el);
  }, []);
  const contentRef = useCallback((el: HTMLDivElement | null) => {
    setContent(el);
  }, []);
  // Overlay ref is SHARED across Settings / Rules / Wizard. Two races
  // matter here:
  //   (A) Open wizard from Settings: Settings stays mounted during its
  //       AnimatePresence exit (~300ms), then unmounts and fires null.
  //       Naive `setOverlay(null)` would clobber the wizard's active
  //       registration. Solution: ignore null if the tracked element
  //       is still in the DOM.
  //   (B) Close the wizard: React calls the ref with null BEFORE
  //       detaching the element, so `document.body.contains` still
  //       returns true at callback time. If we trust that check at
  //       the null callback moment, we never clear — so overlay stays
  //       pinned to a detached wizardCard forever, freezing the
  //       window at MAX. Solution: defer the DOM check to the next
  //       animation frame. By then React has finished the commit and
  //       the DOM reflects reality.
  //
  // Incoming-element calls are applied immediately and cancel any
  // pending null-check, so the sibling-null case (A) still resolves
  // correctly without a frame delay.
  const overlayElRef = useRef<HTMLElement | null>(null);
  const pendingNullCheckRef = useRef<number | null>(null);
  const overlayRef = useCallback((el: HTMLElement | null) => {
    const current = overlayElRef.current;
    if (AUTO_RESIZE_DEBUG) {
      console.info('[AutoResize] overlayRef called', {
        incoming: el ? `<${el.tagName.toLowerCase()}>` : null,
        current: current ? `<${current.tagName.toLowerCase()}>` : null,
        currentStillInDom: current ? document.body.contains(current) : null,
        deferredCheckPending: pendingNullCheckRef.current !== null,
      });
    }
    if (el) {
      // New element arrived — cancel any pending null-reconcile from
      // a sibling's earlier unmount. It's stale now.
      if (pendingNullCheckRef.current !== null) {
        cancelAnimationFrame(pendingNullCheckRef.current);
        pendingNullCheckRef.current = null;
      }
      if (el !== current) {
        overlayElRef.current = el;
        setOverlay(el);
      }
      return;
    }
    // Null call. Don't trust `document.body.contains` now because
    // React may call us before the element is detached. Defer one
    // frame, then reconcile against the post-commit DOM state.
    if (pendingNullCheckRef.current !== null) return; // already queued
    pendingNullCheckRef.current = requestAnimationFrame(() => {
      pendingNullCheckRef.current = null;
      const result = reconcileOverlayRef(overlayElRef.current, null, (x) =>
        document.body.contains(x),
      );
      if (AUTO_RESIZE_DEBUG) {
        console.info('[AutoResize] overlayRef deferred reconcile', {
          tracked: overlayElRef.current ? `<${overlayElRef.current.tagName.toLowerCase()}>` : null,
          stillInDom: overlayElRef.current ? document.body.contains(overlayElRef.current) : null,
          changed: result.changed,
        });
      }
      if (result.changed) {
        overlayElRef.current = result.next;
        setOverlay(result.next);
      }
    });
  }, []);
  const popoverRef = useCallback((el: HTMLElement | null) => {
    setPopover(el);
  }, []);

  // DevTools open/close state — stored in a ref (not the main effect's
  // closure) so it survives effect re-runs triggered by `popover` /
  // `overlay` changes. Previously this lived as a plain `let` inside the
  // resize effect, which meant opening the HeaderMenu popover while
  // DevTools was open re-ran the effect with `devtoolsOpen = false`, and
  // the next apply() shrank the window back down mid-debug.
  const devtoolsOpenRef = useRef(false);

  // Chrome overhead (title bar + decorations) and the "have we calibrated
  // yet" flag must survive effect re-runs. Without this, switching from
  // one overlay to another (Settings → Wizard) resets chromeOverhead to 0,
  // so the first setSize of the new effect under-counts by ~32px and the
  // window visibly shrinks before calibrate re-grows it. Persisting
  // across re-runs lets the first frame of the new overlay ask for the
  // right size immediately. `lastTargetRef` sticks for the same reason —
  // it's the anti-thrash guard, and losing it on every overlay change
  // guarantees a redundant setSize on every mount.
  const chromeOverheadRef = useRef(0);
  const calibratedRef = useRef(false);
  const lastTargetRef = useRef(0);

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
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!root || !content) return;
    const main = content.parentElement;
    if (!main) return;

    const appWindow = getCurrentWindow();
    let rafId: number | null = null;
    let inFlight = false;
    if (AUTO_RESIZE_DEBUG) {
      console.info('[AutoResize] effect setup', {
        overlayPresent: overlay != null,
        chromeOverhead: chromeOverheadRef.current,
        calibrated: calibratedRef.current,
        lastTarget: lastTargetRef.current,
      });
    }

    const computeInner = (): number => {
      const rootTop = root.getBoundingClientRect().top;
      // Safety net: if overlay state is set but the element was
      // detached from the DOM (can happen in the ~1 frame gap between
      // the ref null-callback and the deferred reconcile), don't trust
      // it — fall through to the main-content path so we don't size
      // against a dead element's stale scrollHeight/attributes.
      const overlayAttached = overlay != null && overlay.isConnected;
      const overlayExpandMax = overlayAttached && overlay.dataset.expandMax != null;
      const overlayScrollHeight = overlayAttached ? overlay.scrollHeight : null;
      const chromeAndFooter = root.offsetHeight - main.offsetHeight;
      const mainPadBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
      const popoverBottomRelativeToRoot = popover
        ? popover.getBoundingClientRect().bottom - rootTop + 8
        : null;
      const target = computeTargetInner({
        overlayExpandMax,
        overlayScrollHeight,
        chromeAndFooter,
        contentOffsetHeight: content.offsetHeight,
        mainPaddingBottomPx: mainPadBottom,
        popoverBottomRelativeToRoot,
      });
      if (AUTO_RESIZE_DEBUG) {
        console.info(
          '[AutoResize] compute',
          JSON.stringify({
            overlayPresent: overlay != null,
            overlayAttached,
            overlayExpandMax,
            overlayScrollHeight,
            chromeAndFooter,
            contentOffsetHeight: content.offsetHeight,
            mainPadBottom,
            popoverBottomRelativeToRoot,
            target,
          }),
        );
      }
      return target;
    };

    const apply = async (): Promise<void> => {
      rafId = null;
      if (AUTO_RESIZE_DEBUG) {
        console.info('[AutoResize] apply() entered', {
          inFlight,
          devtoolsOpen: devtoolsOpenRef.current,
          overlayPresent: overlay != null,
          lastTarget: lastTargetRef.current,
          chromeOverhead: chromeOverheadRef.current,
        });
      }
      if (inFlight) {
        if (AUTO_RESIZE_DEBUG) console.info('[AutoResize] apply() early-return: inFlight');
        return;
      }
      // Rust owns the window size while the inspector is docked. Read
      // from the ref (not a closure-local) so popover / overlay-driven
      // effect re-runs don't reset this to false mid-debug.
      if (devtoolsOpenRef.current) {
        if (AUTO_RESIZE_DEBUG) console.info('[AutoResize] apply() early-return: devtoolsOpen');
        return;
      }
      const targetInner = computeInner();
      const target = targetInner + chromeOverheadRef.current;

      // Recalibration trigger: if the window isn't rendering at the size we
      // last asked for, the baseline assumption behind `chromeOverhead` is
      // stale. This happens any time something OUTSIDE our control resizes
      // the window — most commonly DevTools docking in or out, but also a
      // user-initiated drag on the window edge. Without this, closing
      // DevTools leaves the hook thinking it's already at the right size
      // (`target === lastTarget`) and the window stays whatever size the
      // teardown left it at.
      const actualInner = window.innerHeight;
      const baselineDrift =
        lastTargetRef.current > 0 &&
        Math.abs(lastTargetRef.current - chromeOverheadRef.current - actualInner) > 4;
      if (baselineDrift) {
        calibratedRef.current = false;
        lastTargetRef.current = 0;
      }

      if (target === lastTargetRef.current) {
        if (AUTO_RESIZE_DEBUG)
          console.info('[AutoResize] apply() early-return: target matches lastTarget', { target });
        return;
      }
      lastTargetRef.current = target;
      inFlight = true;
      try {
        if (AUTO_RESIZE_DEBUG) {
          console.info('[AutoResize] setSize → requesting', {
            width: WIDTH,
            height: target,
            targetInner,
            chromeOverhead: chromeOverheadRef.current,
          });
        }
        try {
          await appWindow.setSize(new LogicalSize(WIDTH, target));
        } catch (err) {
          console.error('[AutoResize] setSize #1 threw', err);
          return;
        }
        if (AUTO_RESIZE_DEBUG) {
          console.info(
            '[AutoResize] setSize #1 → actual innerHeight',
            window.innerHeight,
            'outerHeight',
            window.outerHeight,
          );
        }
        if (!calibratedRef.current) {
          // Empirically measure: did setSize give us targetInner pixels of
          // viewport height, or did it include the title bar in the total?
          // window.innerHeight is the layout viewport — what CSS sees as
          // 100vh — which is what we actually care about for our content.
          const measured = window.innerHeight;
          const deficit = targetInner - measured;
          if (AUTO_RESIZE_DEBUG) {
            console.info('[AutoResize] calibrate', { measured, targetInner, deficit });
          }
          if (deficit > 1) {
            chromeOverheadRef.current = deficit;
            lastTargetRef.current = targetInner + chromeOverheadRef.current;
            try {
              await appWindow.setSize(new LogicalSize(WIDTH, lastTargetRef.current));
            } catch (err) {
              console.error('[AutoResize] setSize #2 (grow) threw', err);
              return;
            }
            if (AUTO_RESIZE_DEBUG) {
              console.info(
                '[AutoResize] setSize #2 (grow) → actual innerHeight',
                window.innerHeight,
                'outerHeight',
                window.outerHeight,
                'asked for',
                lastTargetRef.current,
              );
            }
          } else if (deficit < -1) {
            // Overshoot (webview ended up LARGER than target). Happens when
            // a prior calibration was polluted by DevTools docking — the
            // cached `chromeOverhead` overstated the chrome. Clamp back to
            // zero so subsequent setSize calls don't keep growing the
            // window past its intended size.
            chromeOverheadRef.current = 0;
            lastTargetRef.current = targetInner;
            try {
              await appWindow.setSize(new LogicalSize(WIDTH, lastTargetRef.current));
            } catch (err) {
              console.error('[AutoResize] setSize #2 (shrink) threw', err);
              return;
            }
            if (AUTO_RESIZE_DEBUG) {
              console.info(
                '[AutoResize] setSize #2 (shrink) → actual innerHeight',
                window.innerHeight,
                'outerHeight',
                window.outerHeight,
                'asked for',
                lastTargetRef.current,
              );
            }
          }
          calibratedRef.current = true;
        }
      } finally {
        inFlight = false;
      }
    };

    const schedule = (): void => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        void apply();
      });
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
      calibratedRef.current = false;
      lastTargetRef.current = 0;
    }

    schedule();

    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [root, content, overlay, popover, recalibVersion]);

  return { rootRef, contentRef, overlayRef, popoverRef };
}
