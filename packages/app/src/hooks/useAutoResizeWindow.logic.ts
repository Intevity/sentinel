/**
 * Pure, DOM-free size computation + overlay reconciliation extracted
 * from useAutoResizeWindow. Kept out of the hook so both can be
 * unit-tested without jsdom or Tauri. The hook is responsible for
 * reading DOM measurements and invoking Tauri's setSize; the math and
 * the reconciliation logic live here.
 */

export const TRAY_WIDTH = 540;
export const TRAY_MIN_HEIGHT = 288;
export const TRAY_MAX_HEIGHT = 628;

export interface ComputeTargetInputs {
  /** True when the active overlay opts into a fixed max-height window
   *  (via `data-expand-max`). The security setup wizard uses this so
   *  the window doesn't shrink as the user advances between steps. */
  overlayExpandMax: boolean;
  /** `overlay.scrollHeight` when an overlay is mounted. null when no
   *  overlay is present (main-app path). */
  overlayScrollHeight: number | null;
  /** `rootOffsetHeight - mainOffsetHeight` — the vertical space taken
   *  by header/banners/tab bar/footer combined. Used on the main path. */
  chromeAndFooter: number;
  /** `content.offsetHeight` on the main-app path. */
  contentOffsetHeight: number;
  /** Padding-bottom on `main`, parsed to pixels. */
  mainPaddingBottomPx: number;
  /** Popover bottom edge in page coordinates, minus the root's top edge.
   *  null when no popover is mounted. Includes the 8px breathing room. */
  popoverBottomRelativeToRoot: number | null;
  /** True when the main-content wrapper opts into a fixed max-height
   *  window (via `data-expand-max` on the contentRef element). The Logs
   *  tab uses this because its internal scroll container is bounded by
   *  the window — measured `contentOffsetHeight` always matches the
   *  current window size, so a natural-height calculation can't grow
   *  the window on tab entry. */
  contentExpandMax: boolean;
}

/**
 * Compute the target inner viewport height for the tray window.
 *
 * Resolution order:
 *   1. Overlay opt-in `expandMax` → TRAY_MAX_HEIGHT, bypassing scroll height.
 *   2. Overlay present → its `scrollHeight`.
 *   3. No overlay → chrome + content + padding.
 *   4. Popover anchored inside the window extends `needed` to reveal it.
 *
 * The result is clamped to [TRAY_MIN_HEIGHT, TRAY_MAX_HEIGHT].
 */
export function computeTargetInner(inputs: ComputeTargetInputs): number {
  let needed: number;
  if (inputs.overlayScrollHeight !== null) {
    needed = inputs.overlayExpandMax ? TRAY_MAX_HEIGHT : inputs.overlayScrollHeight;
  } else if (inputs.contentExpandMax) {
    needed = TRAY_MAX_HEIGHT;
  } else {
    needed = inputs.chromeAndFooter + inputs.contentOffsetHeight + inputs.mainPaddingBottomPx;
  }
  if (inputs.popoverBottomRelativeToRoot !== null) {
    needed = Math.max(needed, inputs.popoverBottomRelativeToRoot);
  }
  return Math.min(TRAY_MAX_HEIGHT, Math.max(TRAY_MIN_HEIGHT, Math.ceil(needed)));
}

/**
 * Reconcile a callback-ref invocation against the currently-tracked
 * overlay element.
 *
 * The problem: `overlayRef` is shared across SettingsPanel and
 * SecuritySetupWizard. `AnimatePresence`
 * defers unmount of the exiting overlay by ~300ms, so when a user
 * clicks "Run setup wizard" from Settings:
 *   1. Wizard mounts → its ref fires with `wizardCard` → we set
 *      overlay to `wizardCard`. Good — window should resize to max.
 *   2. ~300ms later, Settings exit animation finishes → Settings'
 *      ref fires with `null` → naive impl does `setOverlay(null)`,
 *      clobbering the wizard's registration and reverting window to
 *      main-content size. That's the bug the user keeps hitting.
 *
 * Fix: when a ref fires with `null`, only clear the tracked overlay
 * if the currently-tracked element is no longer in the DOM. Otherwise
 * the null is for a different component and we ignore it.
 */
export interface OverlayReconciliation {
  next: HTMLElement | null;
  changed: boolean;
}

export function reconcileOverlayRef(
  current: HTMLElement | null,
  incoming: HTMLElement | null,
  isStillInDom: (el: HTMLElement) => boolean,
): OverlayReconciliation {
  if (incoming) {
    return { next: incoming, changed: incoming !== current };
  }
  // null call: only clear when the currently-tracked element is
  // actually gone. If it's still in the DOM, this null is from a
  // sibling overlay unmounting and must NOT clobber our tracking.
  if (current && !isStillInDom(current)) {
    return { next: null, changed: true };
  }
  return { next: current, changed: false };
}
