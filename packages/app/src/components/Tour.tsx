import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowLeft, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { TOUR_STEPS, type TourStep } from '../lib/tourSteps.js';
import { DUR, EASE_OUT } from '../lib/motion.js';

interface TourProps {
  /** Called when the user completes, skips, or dismisses the tour. Should
   *  flip `settings.tourCompleted` to true (only for first-run path;
   *  replay flow passes a no-op that just closes). */
  onFinish: () => void;
  /** Invoked before each step renders so the parent can switch tabs when a
   *  step requires it. */
  onStepEnter?: (step: TourStep) => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const HOLE_PADDING = 6;
const HOLE_RADIUS = 10;
const CARD_WIDTH = 300;
const CARD_GAP = 10;

export default function Tour({ onFinish, onStepEnter }: TourProps): React.ReactElement | null {
  const [index, setIndex] = useState(0);
  const step = TOUR_STEPS[index];
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [cardHeight, setCardHeight] = useState<number | null>(null);

  // Fire the step-enter callback on every index change. Intentionally
  // excludes onStepEnter from deps — it may be redefined on every parent
  // render and we only want to fire when the step actually changes.
  useEffect(() => {
    if (!step) return;
    onStepEnter?.(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Track the target element's rect. We poll via requestAnimationFrame
  // while the step is active so spotlight follows layout changes (tab
  // switch animations, window resize, auto-resize hook).
  useEffect(() => {
    if (!step || !step.targetId) {
      setRect(null);
      return;
    }
    let frame = 0;
    const tick = (): void => {
      const el = document.querySelector<HTMLElement>(`[data-tour-id="${step.targetId}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect((prev) => {
          if (
            prev &&
            prev.top === r.top &&
            prev.left === r.left &&
            prev.width === r.width &&
            prev.height === r.height
          ) {
            return prev;
          }
          return { top: r.top, left: r.left, width: r.width, height: r.height };
        });
      } else {
        setRect(null);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [step]);

  // Viewport size for mask dimensions.
  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const next = useCallback((): void => {
    if (index >= TOUR_STEPS.length - 1) {
      onFinish();
      return;
    }
    setIndex((i) => i + 1);
  }, [index, onFinish]);

  const back = useCallback((): void => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const skip = useCallback((): void => {
    onFinish();
  }, [onFinish]);

  // Escape dismisses, arrow keys advance/retreat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        skip();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, skip]);

  const cardPosition = useMemo(
    () => computeCardPosition(step, rect, viewport, cardHeight),
    [step, rect, viewport, cardHeight],
  );

  if (!step) return null;

  const hasTarget = !!rect;
  const safeRect: Rect = rect ?? { top: 0, left: 0, width: 0, height: 0 };

  return (
    <AnimatePresence>
      <motion.div
        key="tour-overlay"
        className="fixed inset-0 z-50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: DUR.fast, ease: EASE_OUT }}
      >
        {/* SVG overlay with a spotlight hole punched out and a bright
            ring drawn around it so the highlighted element reads clearly
            against the dim background. Always rendered so the backdrop
            fades consistently — when there's no target we simply render a
            full-screen dimmer with no hole. */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-auto"
          onClick={skip}
          role="presentation"
        >
          <defs>
            <mask id="tour-mask">
              <rect width="100%" height="100%" fill="white" />
              {hasTarget && (
                <rect
                  x={safeRect.left - HOLE_PADDING}
                  y={safeRect.top - HOLE_PADDING}
                  width={safeRect.width + HOLE_PADDING * 2}
                  height={safeRect.height + HOLE_PADDING * 2}
                  rx={HOLE_RADIUS}
                  ry={HOLE_RADIUS}
                  fill="black"
                />
              )}
            </mask>
            {/* Soft blue glow applied to the spotlight ring. Keeps the
                highlight legible against both light and dark app themes. */}
            <filter id="tour-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </defs>
          {/* Much darker backdrop than v1 (0.55 → 0.78) so the spotlight
              hole stands out even when the target sits against a light
              iOS-style app surface. */}
          <rect width="100%" height="100%" fill="rgba(0,0,0,0.78)" mask="url(#tour-mask)" />
          {hasTarget && (
            <>
              {/* Outer blue glow — soft, diffuse, catches the eye. */}
              <rect
                x={safeRect.left - HOLE_PADDING}
                y={safeRect.top - HOLE_PADDING}
                width={safeRect.width + HOLE_PADDING * 2}
                height={safeRect.height + HOLE_PADDING * 2}
                rx={HOLE_RADIUS}
                ry={HOLE_RADIUS}
                fill="none"
                stroke="#0A84FF"
                strokeWidth={4}
                opacity={0.55}
                filter="url(#tour-glow)"
                pointerEvents="none"
              />
              {/* Crisp inner ring — defines the edge precisely so the user
                  can tell exactly which element is being pointed to. */}
              <rect
                x={safeRect.left - HOLE_PADDING}
                y={safeRect.top - HOLE_PADDING}
                width={safeRect.width + HOLE_PADDING * 2}
                height={safeRect.height + HOLE_PADDING * 2}
                rx={HOLE_RADIUS}
                ry={HOLE_RADIUS}
                fill="none"
                stroke="#0A84FF"
                strokeWidth={2}
                pointerEvents="none"
              />
            </>
          )}
        </svg>

        {/* Coach mark card. motion animates position via key so each step
            flies in fresh. */}
        <motion.div
          key={`card-${index}`}
          className="absolute pointer-events-auto"
          ref={(el) => {
            // Measured height replaces the 150px fallback in computeCardPosition
            // so the clamp and placement-flip logic reason about the real card
            // (the long round-robin step renders ~270px, not 150). The window
            // itself is held at max via App's data-expand-max while the tour
            // is running, which is what guarantees the card always has room.
            if (el) setCardHeight(el.offsetHeight);
          }}
          style={{
            top: cardPosition.top,
            left: cardPosition.left,
            width: CARD_WIDTH,
          }}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: DUR.med, ease: EASE_OUT }}
        >
          <div className="bg-white dark:bg-[#1E1E1E] rounded-2xl shadow-card p-3 border border-black/5 dark:border-white/10">
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <span className="text-[10px] font-semibold text-[#8E8E93] uppercase tracking-wider">
                Step {index + 1} of {TOUR_STEPS.length}
              </span>
              <button
                onClick={skip}
                className="w-5 h-5 -m-0.5 rounded-full hover:bg-[#8E8E93]/10 flex items-center justify-center"
                title="Skip tour"
                aria-label="Skip tour"
              >
                <X size={11} className="text-[#8E8E93]" />
              </button>
            </div>
            <h3 className="text-[13px] font-semibold text-black dark:text-white mb-1">
              {step.title}
            </h3>
            <p className="text-[11px] text-[#8E8E93] leading-snug">{step.body}</p>
            <div className="flex items-center justify-between gap-2 mt-3">
              <button
                onClick={back}
                disabled={index === 0}
                className="text-[11px] font-medium text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors disabled:opacity-30 inline-flex items-center gap-1"
              >
                <ArrowLeft size={11} strokeWidth={2.4} />
                Back
              </button>
              <button
                onClick={next}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all inline-flex items-center gap-1"
              >
                {index >= TOUR_STEPS.length - 1 ? 'Done' : 'Next'}
                {index < TOUR_STEPS.length - 1 && <ArrowRight size={11} strokeWidth={2.4} />}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/** Choose a coordinate for the coach-mark card. When there's no target
 *  (welcome/finale) we center it. Otherwise pick top or bottom of the
 *  target based on available viewport space. */
function computeCardPosition(
  step: TourStep | undefined,
  rect: Rect | null,
  viewport: { w: number; h: number },
  measuredCardHeight: number | null,
): { top: number; left: number } {
  // Use the measured height once the card has rendered. The 150 fallback
  // only applies on the very first paint of each step, before the callback
  // ref fires — the subsequent state update re-runs this with the real
  // height and the card repositions in the same frame.
  const cardHeight = measuredCardHeight ?? 150;
  if (!step || !rect) {
    return {
      top: Math.max(40, viewport.h / 2 - cardHeight / 2),
      left: Math.max(12, viewport.w / 2 - CARD_WIDTH / 2),
    };
  }

  // Horizontal: anchor to target's horizontal center, clamp to viewport.
  const centerX = rect.left + rect.width / 2;
  let left = centerX - CARD_WIDTH / 2;
  left = Math.max(12, Math.min(viewport.w - CARD_WIDTH - 12, left));

  // Vertical: prefer user-requested placement, then auto-flip if it would
  // clip off the viewport.
  const spaceAbove = rect.top;
  const spaceBelow = viewport.h - (rect.top + rect.height);
  let placement = step.placement;
  if (placement === 'auto') {
    placement = spaceBelow >= cardHeight + CARD_GAP ? 'bottom' : 'top';
  }
  if (placement === 'top' && spaceAbove < cardHeight + CARD_GAP) {
    placement = 'bottom';
  }
  if (placement === 'bottom' && spaceBelow < cardHeight + CARD_GAP) {
    placement = 'top';
  }

  const top =
    placement === 'top'
      ? Math.max(12, rect.top - cardHeight - CARD_GAP)
      : Math.min(viewport.h - cardHeight - 12, rect.top + rect.height + CARD_GAP);

  return { top, left };
}
