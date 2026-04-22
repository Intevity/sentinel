import { describe, expect, it } from 'vitest';
import {
  computeTargetInner,
  reconcileOverlayRef,
  TRAY_MIN_HEIGHT,
  TRAY_MAX_HEIGHT,
} from './useAutoResizeWindow.logic.js';

const base = {
  overlayExpandMax: false,
  overlayScrollHeight: null as number | null,
  chromeAndFooter: 100,
  contentOffsetHeight: 300,
  mainPaddingBottomPx: 8,
  popoverBottomRelativeToRoot: null as number | null,
  contentExpandMax: false,
};

describe('computeTargetInner', () => {
  describe('main-app path (no overlay)', () => {
    it('returns chrome + content + padding when inside bounds', () => {
      expect(computeTargetInner(base)).toBe(100 + 300 + 8);
    });

    it('clamps to TRAY_MIN_HEIGHT when too small', () => {
      expect(computeTargetInner({ ...base, contentOffsetHeight: 50 })).toBe(TRAY_MIN_HEIGHT);
    });

    it('clamps to TRAY_MAX_HEIGHT when too large', () => {
      expect(computeTargetInner({ ...base, contentOffsetHeight: 5000 })).toBe(TRAY_MAX_HEIGHT);
    });

    it('rounds up a fractional result', () => {
      expect(computeTargetInner({ ...base, contentOffsetHeight: 300.4 })).toBe(409);
    });
  });

  describe('overlay path (overlayScrollHeight !== null)', () => {
    it('uses overlay.scrollHeight when expandMax is off', () => {
      expect(
        computeTargetInner({
          ...base,
          overlayScrollHeight: 450,
        }),
      ).toBe(450);
    });

    it('pegs to TRAY_MAX_HEIGHT when expandMax is on, regardless of scrollHeight', () => {
      expect(
        computeTargetInner({
          ...base,
          overlayScrollHeight: 120,
          overlayExpandMax: true,
        }),
      ).toBe(TRAY_MAX_HEIGHT);
    });

    it('expandMax overrides a short overlay (regression: wizard select step)', () => {
      // The wizard's "select" step is ~420px tall. Without the opt-in
      // the window would size to 420 and hide content on taller steps;
      // with the opt-in it sits at MAX.
      expect(
        computeTargetInner({
          ...base,
          overlayScrollHeight: 420,
          overlayExpandMax: true,
        }),
      ).toBe(TRAY_MAX_HEIGHT);
    });

    it('expandMax still clamps within bounds if MAX were ever exceeded', () => {
      // Defensive: overlayExpandMax should never exceed TRAY_MAX_HEIGHT
      // even through the popover path.
      expect(
        computeTargetInner({
          ...base,
          overlayScrollHeight: 9999,
          overlayExpandMax: true,
          popoverBottomRelativeToRoot: 800,
        }),
      ).toBe(TRAY_MAX_HEIGHT);
    });

    it('ignores main-path inputs when overlay is present', () => {
      expect(
        computeTargetInner({
          ...base,
          overlayScrollHeight: 400,
          chromeAndFooter: 9999, // should be ignored
          contentOffsetHeight: 9999, // should be ignored
        }),
      ).toBe(400);
    });
  });

  describe('content expandMax (main-path opt-in)', () => {
    it('pegs to TRAY_MAX_HEIGHT when contentExpandMax is on, ignoring measured content', () => {
      // Regression: Logs tab. Its internal scroll container is bounded
      // by the window so contentOffsetHeight matches the current window
      // size; without this opt-in the window can never grow on entry.
      expect(
        computeTargetInner({
          ...base,
          contentOffsetHeight: 200,
          contentExpandMax: true,
        }),
      ).toBe(TRAY_MAX_HEIGHT);
    });

    it('ignores chromeAndFooter / padding when contentExpandMax is on', () => {
      expect(
        computeTargetInner({
          ...base,
          chromeAndFooter: 9999,
          contentOffsetHeight: 9999,
          mainPaddingBottomPx: 9999,
          contentExpandMax: true,
        }),
      ).toBe(TRAY_MAX_HEIGHT);
    });

    it('still clamps within bounds when popover extends past MAX', () => {
      expect(
        computeTargetInner({
          ...base,
          contentExpandMax: true,
          popoverBottomRelativeToRoot: 900,
        }),
      ).toBe(TRAY_MAX_HEIGHT);
    });

    it('defers to overlay when both overlay and contentExpandMax are present', () => {
      // Overlay takes priority: if Settings is open on the Logs tab, the
      // overlay's own scrollHeight governs, not the tab's expand-max.
      expect(
        computeTargetInner({
          ...base,
          overlayScrollHeight: 400,
          contentExpandMax: true,
        }),
      ).toBe(400);
    });
  });

  describe('popover extension', () => {
    it('extends needed to popover bottom when larger than content', () => {
      expect(
        computeTargetInner({
          ...base,
          contentOffsetHeight: 200,
          popoverBottomRelativeToRoot: 500,
        }),
      ).toBe(500);
    });

    it('does not shrink below content when popover is smaller', () => {
      expect(
        computeTargetInner({
          ...base,
          chromeAndFooter: 100,
          contentOffsetHeight: 400,
          popoverBottomRelativeToRoot: 200,
        }),
      ).toBe(100 + 400 + 8);
    });
  });
});

describe('reconcileOverlayRef', () => {
  // Helpers to simulate elements and DOM membership without jsdom.
  const mkEl = (tag = 'div'): HTMLElement => ({ tagName: tag }) as unknown as HTMLElement;
  const inDom = (_: HTMLElement) => true;
  const notInDom = (_: HTMLElement) => false;

  it('sets the overlay when called with an element for the first time', () => {
    const el = mkEl();
    expect(reconcileOverlayRef(null, el, inDom)).toEqual({ next: el, changed: true });
  });

  it('replaces the overlay when a new element is registered', () => {
    const old = mkEl();
    const next = mkEl();
    expect(reconcileOverlayRef(old, next, inDom)).toEqual({ next, changed: true });
  });

  it('reports no change when the same element is re-registered', () => {
    const el = mkEl();
    expect(reconcileOverlayRef(el, el, inDom)).toEqual({ next: el, changed: false });
  });

  it('clears when null fires and the tracked element has left the DOM', () => {
    const el = mkEl();
    expect(reconcileOverlayRef(el, null, notInDom)).toEqual({ next: null, changed: true });
  });

  it('IGNORES a null call when tracked element is still in the DOM (regression: wizard-from-settings)', () => {
    // The scenario: wizard is tracked as overlay. Settings panel (a
    // sibling overlay) finishes its exit animation and unmounts,
    // firing the shared callback-ref with null. We must NOT clobber
    // the wizard's registration.
    const wizardCard = mkEl('div');
    const isWizardStillInDom = (el: HTMLElement) => el === wizardCard;
    expect(reconcileOverlayRef(wizardCard, null, isWizardStillInDom)).toEqual({
      next: wizardCard,
      changed: false,
    });
  });

  it('does nothing when current is null and incoming is null', () => {
    expect(reconcileOverlayRef(null, null, inDom)).toEqual({ next: null, changed: false });
  });

  it('sets a new overlay even if a stale current is still considered in-DOM', () => {
    // Two sibling overlays: stale is still attached (AnimatePresence
    // exit in flight), fresh mounts. Fresh wins.
    const stale = mkEl();
    const fresh = mkEl();
    expect(reconcileOverlayRef(stale, fresh, inDom)).toEqual({ next: fresh, changed: true });
  });
});
