import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Feature } from '../data/features';

interface Props {
  features: Feature[];
  /** import.meta.env.BASE_URL passed from the Astro page (has a trailing slash). */
  base: string;
}

const AUTOPLAY_MS = 7000;
// Video slides advance when the clip's `ended` event fires; this is only a
// safety net so a clip that fails to load can't stall the carousel forever.
const VIDEO_FALLBACK_MS = 40000;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function FeatureCarousel({ features, base }: Props) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useMemo(prefersReducedMotion, []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // All clips stay mounted (stacked) so switching is instant; this frame holds
  // them and we drive play/pause imperatively rather than via remounts.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const prevActive = useRef(active);

  const asset = useCallback(
    (p: string) => `${base.replace(/\/$/, '')}/videos/${p.replace(/^\//, '')}`,
    [base],
  );

  const advance = useCallback(() => {
    setActive((i) => (i + 1) % features.length);
  }, [features.length]);

  // Poster-only slides advance on the fixed timer; video slides advance on
  // their own `ended` event and use only a long fallback so a stalled clip
  // can't freeze the carousel. Resets whenever the active slide changes.
  useEffect(() => {
    if (reduced || paused || features.length <= 1) return;
    const ms = features[active]?.hasVideo ? VIDEO_FALLBACK_MS : AUTOPLAY_MS;
    timer.current = setTimeout(advance, ms);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reduced, paused, features.length, active, advance]);

  // The active clip always plays (so a click never lands on a frozen frame);
  // hover only HOLDS it — we loop the active clip while hovered so it keeps
  // playing without auto-advancing, and it restarts from its intro on a real
  // activation (not on a hover toggle). All other clips are paused.
  useEffect(() => {
    const root = frameRef.current;
    if (!root) return;
    const becameActive = prevActive.current !== active;
    root.querySelectorAll('video').forEach((v) => {
      const isActive = Number(v.dataset.idx) === active;
      if (isActive) {
        v.loop = paused;
        if (becameActive) {
          try {
            v.currentTime = 0;
          } catch {
            /* not seekable yet */
          }
        }
        if (!reduced) void v.play().catch(() => {});
      } else {
        v.pause();
      }
    });
    prevActive.current = active;
  }, [active, paused, reduced]);

  const current = features[active];
  if (!current) return null;

  return (
    <div
      className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_1fr]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {/* Tab rail */}
      <div
        className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible"
        role="tablist"
        aria-label="Feature demos"
      >
        {features.map((f, i) => {
          const selected = i === active;
          return (
            <button
              key={f.slug}
              role="tab"
              aria-selected={selected}
              type="button"
              onClick={() => setActive(i)}
              className={[
                'shrink-0 rounded-2xl px-4 py-3 text-left transition-all lg:shrink',
                selected
                  ? 'bg-ios-blue/10 text-foreground shadow-card'
                  : 'text-foreground/55 hover:bg-foreground/5 hover:text-foreground/80',
              ].join(' ')}
            >
              <span
                className={['block text-sm font-semibold', selected ? 'text-ios-blue' : ''].join(
                  ' ',
                )}
              >
                {f.label}
              </span>
              <span className="mt-0.5 hidden text-xs leading-snug text-foreground/50 lg:block">
                {f.tagline}
              </span>
            </button>
          );
        })}
      </div>

      {/* Media frame — every clip stays mounted and stacked; only the active
          one is visible (crossfaded) and playing, so switching is instant and
          smooth instead of a remount-and-reload cut. */}
      <div className="glass-card relative overflow-hidden rounded-3xl">
        <div ref={frameRef} className="relative aspect-video w-full bg-[#0c0c0c]">
          {features.map((f, i) => {
            const isActive = i === active;
            const layer = `absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-out ${
              isActive ? 'opacity-100' : 'opacity-0'
            }`;
            return f.hasVideo ? (
              <video
                key={f.slug}
                data-idx={i}
                className={layer}
                src={asset(f.video)}
                poster={asset(f.poster)}
                muted
                playsInline
                preload="auto"
                autoPlay={i === 0 && !reduced}
                aria-hidden={!isActive}
                onEnded={() => {
                  if (i === active) advance();
                }}
              />
            ) : (
              <div key={f.slug} className={layer} aria-hidden={!isActive}>
                <img
                  src={asset(f.poster)}
                  alt={`${f.title} preview`}
                  className="h-full w-full object-cover"
                />
                <span className="absolute right-3 top-3 rounded-full bg-surface-overlay/40 px-3 py-1 text-2xs font-semibold uppercase tracking-widest text-white backdrop-blur-xs">
                  Demo video coming soon
                </span>
              </div>
            );
          })}

          {/* Caption */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-5">
            <h3 className="text-base font-semibold text-white sm:text-lg">{current.title}</h3>
            <p className="mt-1 max-w-2xl text-sm text-white/70">{current.tagline}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
