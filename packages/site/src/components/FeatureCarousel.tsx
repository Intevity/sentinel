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
  // The feature whose clip is open full-size in the lightbox, or null.
  const [lightbox, setLightbox] = useState<Feature | null>(null);
  const reduced = useMemo(prefersReducedMotion, []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // All clips stay mounted (stacked) so switching is instant; this frame holds
  // them and we drive play/pause imperatively rather than via remounts.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const prevActive = useRef(active);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  const asset = useCallback(
    (p: string) => `${base.replace(/\/$/, '')}/videos/${p.replace(/^\//, '')}`,
    [base],
  );

  const advance = useCallback(() => {
    setActive((i) => (i + 1) % features.length);
  }, [features.length]);

  const openLightbox = useCallback(() => {
    const f = features[active];
    if (f?.hasVideo) setLightbox(f);
  }, [features, active]);

  // Poster-only slides advance on the fixed timer; video slides advance on
  // their own `ended` event and use only a long fallback so a stalled clip
  // can't freeze the carousel. Resets whenever the active slide changes.
  // The lightbox holds the carousel in place while it is open.
  useEffect(() => {
    if (reduced || paused || lightbox || features.length <= 1) return;
    const ms = features[active]?.hasVideo ? VIDEO_FALLBACK_MS : AUTOPLAY_MS;
    timer.current = setTimeout(advance, ms);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reduced, paused, lightbox, features.length, active, advance]);

  // The active clip always plays (so a click never lands on a frozen frame);
  // hover only HOLDS it — we loop the active clip while hovered so it keeps
  // playing without auto-advancing, and it restarts from its intro on a real
  // activation (not on a hover toggle). All other clips are paused. While the
  // lightbox is open, every inline clip pauses so only the modal plays.
  useEffect(() => {
    const root = frameRef.current;
    if (!root) return;
    const becameActive = prevActive.current !== active;
    root.querySelectorAll('video').forEach((v) => {
      const isActive = Number(v.dataset.idx) === active;
      if (isActive && !lightbox) {
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
  }, [active, paused, reduced, lightbox]);

  // Lightbox: close on Escape, lock body scroll, and move focus to the close
  // button so keyboard users land inside the dialog.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [lightbox]);

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
          smooth instead of a remount-and-reload cut. Clicking opens the active
          clip full-size in the lightbox. */}
      <div className="glass-card relative overflow-hidden rounded-3xl">
        <div
          ref={frameRef}
          className={[
            'group relative aspect-video w-full bg-[#0c0c0c]',
            current.hasVideo ? 'cursor-pointer' : '',
          ].join(' ')}
          {...(current.hasVideo
            ? {
                role: 'button',
                tabIndex: 0,
                'aria-label': `Play the ${current.title} demo at full size`,
                onClick: openLightbox,
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openLightbox();
                  }
                },
              }
            : {})}
        >
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

          {/* Expand affordance: a dim + glyph on hover/focus signalling the
              clip opens full size on click. */}
          {current.hasVideo && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/20 group-hover:opacity-100 group-focus:bg-black/20 group-focus:opacity-100">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/30 backdrop-blur-sm">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              </span>
            </span>
          )}

          {/* Caption */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-5">
            <h3 className="text-base font-semibold text-white sm:text-lg">{current.title}</h3>
            <p className="mt-1 max-w-2xl text-sm text-white/70">{current.tagline}</p>
          </div>
        </div>
      </div>

      {/* Lightbox: one large, centered player for the active clip. Closes on
          backdrop click, the X button, or Escape. */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={`${lightbox.title} demo`}
        >
          <button
            type="button"
            aria-label="Close demo"
            onClick={() => setLightbox(null)}
            className="absolute inset-0 cursor-default bg-black/75 backdrop-blur-sm"
          />
          <div className="relative flex w-[min(1100px,94vw)] flex-col items-center">
            <button
              ref={closeBtnRef}
              type="button"
              aria-label="Close demo"
              onClick={() => setLightbox(null)}
              className="absolute -top-11 right-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 sm:-top-12"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
            <video
              key={lightbox.slug}
              className="max-h-[82vh] w-full rounded-2xl bg-black shadow-2xl"
              src={asset(lightbox.video)}
              poster={asset(lightbox.poster)}
              controls
              autoPlay
              muted
              loop
              playsInline
            />
            <p className="mt-3 text-center text-sm font-semibold text-white/85">{lightbox.title}</p>
          </div>
        </div>
      )}
    </div>
  );
}
