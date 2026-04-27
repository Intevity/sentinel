import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowLeft, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { TOUR_STEPS, CORE_STEP_COUNT, type TourStep, type TourAccent } from '../lib/tourSteps.js';
import { DUR, EASE_OUT } from '../lib/motion.js';

interface TourProps {
  /** Called when the user completes, skips, or dismisses the tour. Should
   *  flip `settings.tourCompleted` to true (only for first-run path;
   *  replay flow passes a no-op that just closes). */
  onFinish: () => void;
  /** Invoked before each step renders so the parent can switch tabs when a
   *  step requires it. */
  onStepEnter?: (step: TourStep) => void;
  /** When true, the tour runs all steps continuously (user explicitly asked
   *  to replay). When false (default, first-run), the last core step shows
   *  a "See more" CTA that branches into the power-user track. */
  replayMode?: boolean;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const HOLE_PADDING = 6;
const HOLE_RADIUS = 10;
const CARD_WIDTH = 340;
const CARD_GAP = 10;
const HERO_HEIGHT = 80;

/** Resolves the per-step accent into the colors used by the hero gradient,
 *  the icon badge tint, and the illustration `currentColor`. Hex values
 *  rather than Tailwind classes because the project's tailwind.config only
 *  ships the `ios.*` palette by default — adding a full color palette just
 *  for the tour would bloat the global theme. */
const ACCENTS: Record<TourAccent, { hex: string; soft: string }> = {
  indigo: { hex: '#5E5CE6', soft: 'rgba(94, 92, 230, 0.18)' },
  blue: { hex: '#0A84FF', soft: 'rgba(10, 132, 255, 0.18)' },
  teal: { hex: '#30B0C7', soft: 'rgba(48, 176, 199, 0.20)' },
  red: { hex: '#FF453A', soft: 'rgba(255, 69, 58, 0.18)' },
  orange: { hex: '#FF9F0A', soft: 'rgba(255, 159, 10, 0.20)' },
  violet: { hex: '#BF5AF2', soft: 'rgba(191, 90, 242, 0.18)' },
  green: { hex: '#32D74B', soft: 'rgba(50, 215, 75, 0.20)' },
  sky: { hex: '#64D2FF', soft: 'rgba(100, 210, 255, 0.22)' },
  gray: { hex: '#8E8E93', soft: 'rgba(142, 142, 147, 0.20)' },
};

export default function Tour({
  onFinish,
  onStepEnter,
  replayMode = false,
}: TourProps): React.ReactElement | null {
  const [index, setIndex] = useState(0);
  // Effective length depends on replay vs first-run: first-run stops at the
  // core track unless the user opts in via "See more"; replay shows everything.
  // `expanded` flips to true the moment the user clicks "See more" so the dot
  // row, the Next button, and the keyboard nav all start treating the power
  // steps as in-scope.
  const [expanded, setExpanded] = useState(replayMode);
  useEffect(() => {
    setExpanded(replayMode);
  }, [replayMode]);

  const effectiveLength = expanded ? TOUR_STEPS.length : CORE_STEP_COUNT;
  const step = TOUR_STEPS[index];
  const accent = step ? ACCENTS[step.accent] : ACCENTS.gray;
  const Icon = step?.icon;
  const Illustration = step?.illustration;

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

  const isLastInScope = index >= effectiveLength - 1;
  // The "See more" CTA only appears on the very last core step in first-run
  // mode (i.e. user has not yet expanded into the power track).
  const showSeeMore = !replayMode && !expanded && index === CORE_STEP_COUNT - 1;

  const next = useCallback((): void => {
    if (isLastInScope) {
      onFinish();
      return;
    }
    setIndex((i) => i + 1);
  }, [isLastInScope, onFinish]);

  const back = useCallback((): void => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const skip = useCallback((): void => {
    onFinish();
  }, [onFinish]);

  const expandIntoPower = useCallback((): void => {
    setExpanded(true);
    setIndex((i) => i + 1);
  }, []);

  // Click a dot to jump. Clicking a power-track dot in first-run mode
  // implicitly opts the user in (same effect as See more).
  const jumpTo = useCallback(
    (i: number): void => {
      if (i >= CORE_STEP_COUNT && !expanded) setExpanded(true);
      setIndex(i);
    },
    [expanded],
  );

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

  if (!step || !Icon || !Illustration) return null;

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
            {/* Soft glow applied to the spotlight ring. Tinted with the
                step's accent so the highlight subtly cues the topic. */}
            <filter id="tour-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" />
            </filter>
          </defs>
          <rect width="100%" height="100%" fill="rgba(0,0,0,0.78)" mask="url(#tour-mask)" />
          {hasTarget && (
            <>
              {/* Outer accent-tinted glow */}
              <rect
                x={safeRect.left - HOLE_PADDING}
                y={safeRect.top - HOLE_PADDING}
                width={safeRect.width + HOLE_PADDING * 2}
                height={safeRect.height + HOLE_PADDING * 2}
                rx={HOLE_RADIUS}
                ry={HOLE_RADIUS}
                fill="none"
                stroke={accent.hex}
                strokeWidth={4}
                opacity={0.55}
                filter="url(#tour-glow)"
                pointerEvents="none"
              />
              {/* Crisp inner ring with a subtle breathing pulse so the
                  spotlight stays alive even when the user is reading. */}
              <motion.rect
                x={safeRect.left - HOLE_PADDING}
                y={safeRect.top - HOLE_PADDING}
                width={safeRect.width + HOLE_PADDING * 2}
                height={safeRect.height + HOLE_PADDING * 2}
                rx={HOLE_RADIUS}
                ry={HOLE_RADIUS}
                fill="none"
                stroke={accent.hex}
                strokeWidth={2}
                pointerEvents="none"
                animate={{ opacity: [0.85, 1, 0.85] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
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
            // Measured height replaces the fallback in computeCardPosition
            // so the clamp and placement-flip logic reason about the real
            // card. The window itself is held at max via App's
            // data-expand-max while the tour is running.
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
          <div className="bg-white dark:bg-[#1E1E1E] rounded-2xl shadow-card border border-black/5 dark:border-white/10 overflow-hidden">
            {/* ── Hero illustration ───────────────────────────── */}
            <div
              className="relative"
              style={{
                height: HERO_HEIGHT,
                background: `linear-gradient(135deg, ${accent.soft} 0%, rgba(255,255,255,0) 100%)`,
                color: accent.hex,
              }}
            >
              <Illustration className="w-full h-full" />
              <button
                onClick={skip}
                className="absolute top-2 right-2 w-6 h-6 rounded-full bg-white/80 dark:bg-black/40 backdrop-blur-xs hover:bg-white dark:hover:bg-black/60 flex items-center justify-center"
                title="Skip tour"
                aria-label="Skip tour"
              >
                <X size={11} className="text-[#8E8E93]" strokeWidth={2.4} />
              </button>
              {/* Icon badge straddling the hero/body boundary */}
              <motion.div
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{
                  duration: 0.32,
                  delay: 0.08,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className="absolute -bottom-4 left-3 w-9 h-9 rounded-full bg-white dark:bg-[#2C2C2E] shadow-card flex items-center justify-center"
                style={{ color: accent.hex }}
              >
                <Icon size={16} strokeWidth={2.2} />
              </motion.div>
            </div>

            {/* ── Body ────────────────────────────────────────── */}
            <div className="px-3.5 pt-6 pb-3">
              <h3 className="text-[14px] font-semibold text-black dark:text-white mb-1 leading-tight">
                {step.title}
              </h3>
              <p className="text-[11.5px] text-[#8E8E93] leading-snug">{step.body}</p>

              {/* ── Footer: dots + nav buttons ─────────────────── */}
              <div className="flex items-center justify-between gap-2 mt-3">
                <ProgressDots
                  current={index}
                  expanded={expanded}
                  accent={accent.hex}
                  onJump={jumpTo}
                />
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={back}
                    disabled={index === 0}
                    className="text-[11px] font-medium text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors disabled:opacity-30 inline-flex items-center gap-1 px-1.5 py-1"
                  >
                    <ArrowLeft size={11} strokeWidth={2.4} />
                    Back
                  </button>
                  {showSeeMore ? (
                    <>
                      <button
                        onClick={() => onFinish()}
                        className="text-[11px] font-medium px-2.5 py-1.5 rounded-lg text-[#8E8E93] hover:text-black dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                      >
                        Done
                      </button>
                      <button
                        onClick={expandIntoPower}
                        className="text-[11px] font-semibold px-3 py-1.5 rounded-lg text-white active:scale-95 transition-all inline-flex items-center gap-1"
                        style={{ background: accent.hex }}
                      >
                        See more
                        <ArrowRight size={11} strokeWidth={2.4} />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={next}
                      className="text-[11px] font-semibold px-3 py-1.5 rounded-lg text-white active:scale-95 transition-all inline-flex items-center gap-1"
                      style={{ background: accent.hex }}
                    >
                      {isLastInScope ? 'Done' : 'Next'}
                      {!isLastInScope && <ArrowRight size={11} strokeWidth={2.4} />}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/** Row of dots showing progress through the tour. Core dots and power
 *  dots are rendered in two visually-separated groups so users can see
 *  at a glance that the "extras" are an opt-in deep dive. In first-run
 *  mode the power dots render as faint placeholders; clicking one
 *  expands the tour and jumps to it. */
function ProgressDots({
  current,
  expanded,
  accent,
  onJump,
}: {
  current: number;
  expanded: boolean;
  accent: string;
  onJump: (i: number) => void;
}): React.ReactElement {
  const total = TOUR_STEPS.length;
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
      {Array.from({ length: total }, (_, i) => {
        const isCurrent = i === current;
        const isCompleted = i < current;
        const isPower = i >= CORE_STEP_COUNT;
        // Visual treatment:
        //  - current: filled with accent
        //  - completed: filled with low-opacity accent
        //  - upcoming core: hollow ring
        //  - upcoming power (first-run, not yet expanded): faint dot
        let bg = 'transparent';
        let border = '#8E8E93';
        let opacity = 1;
        if (isCurrent) {
          bg = accent;
          border = accent;
        } else if (isCompleted) {
          bg = accent;
          border = accent;
          opacity = 0.45;
        } else if (isPower && !expanded) {
          bg = '#8E8E93';
          border = '#8E8E93';
          opacity = 0.25;
        }
        return (
          <React.Fragment key={i}>
            {i === CORE_STEP_COUNT && <span className="w-1.5" aria-hidden />}
            <button
              type="button"
              onClick={() => onJump(i)}
              aria-label={`Jump to step ${i + 1}`}
              className="rounded-full transition-all"
              style={{
                width: isCurrent ? 16 : 6,
                height: 6,
                background: bg,
                border: `1px solid ${border}`,
                opacity,
              }}
            />
          </React.Fragment>
        );
      })}
    </div>
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
  // Use the measured height once the card has rendered. The fallback only
  // applies on the very first paint of each step; the subsequent state
  // update re-runs this with the real height and the card repositions.
  const cardHeight = measuredCardHeight ?? 200;
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
