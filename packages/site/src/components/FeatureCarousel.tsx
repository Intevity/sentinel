import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Feature } from '../data/features';

interface Props {
  features: Feature[];
  /** import.meta.env.BASE_URL passed from the Astro page (has a trailing slash). */
  base: string;
}

const AUTOPLAY_MS = 7000;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function FeatureCarousel({ features, base }: Props) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useMemo(prefersReducedMotion, []);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const asset = useCallback(
    (p: string) => `${base.replace(/\/$/, '')}/videos/${p.replace(/^\//, '')}`,
    [base],
  );

  useEffect(() => {
    if (reduced || paused || features.length <= 1) return;
    timer.current = setInterval(() => {
      setActive((i) => (i + 1) % features.length);
    }, AUTOPLAY_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [reduced, paused, features.length]);

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

      {/* Media frame */}
      <div className="glass-card relative overflow-hidden rounded-3xl">
        <div className="relative aspect-video w-full bg-[#0c0c0c]">
          {current.hasVideo ? (
            <video
              key={current.slug}
              className="h-full w-full object-cover"
              src={asset(current.video)}
              poster={asset(current.poster)}
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
            />
          ) : (
            <>
              <img
                key={current.slug}
                src={asset(current.poster)}
                alt={`${current.title} preview`}
                className="h-full w-full object-cover"
              />
              <span className="absolute right-3 top-3 rounded-full bg-surface-overlay/40 px-3 py-1 text-2xs font-semibold uppercase tracking-widest text-white backdrop-blur-xs">
                Demo video coming soon
              </span>
            </>
          )}

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
