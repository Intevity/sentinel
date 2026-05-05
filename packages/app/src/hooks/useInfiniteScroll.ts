import { useCallback, useEffect, useRef } from 'react';

/**
 * IntersectionObserver helper for "load more" sentinels in scroll
 * containers. The tray window's main scroll container is `<main>`
 * (App.tsx:504, `overflow-y-scroll`); a default observer rooted on the
 * document viewport would never fire because `<main>` clips the
 * sentinel out of the viewport before it can intersect. So we walk the
 * sentinel's ancestor chain to find the nearest scroll container and
 * pass it as `root`.
 *
 * The callback fires whenever the sentinel becomes intersecting AND
 * `hasMore` is true AND we're not already loading. Callers should pass
 * a stable `loadMore` (typically wrapped in useCallback) so the
 * observer isn't re-created on every render.
 */
export function useInfiniteScroll(opts: {
  hasMore: boolean;
  loading: boolean;
  loadMore: () => void;
  /** Pixels of margin around the scroll root that count as "intersecting".
   *  A positive value triggers loadMore before the user reaches the
   *  literal bottom — feels snappier and avoids a visible empty gap. */
  rootMargin?: string;
}): (el: HTMLElement | null) => void {
  const { hasMore, loading, loadMore, rootMargin = '200px' } = opts;
  const sentinelRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Mirror props in refs so the observer callback always sees the
  // latest values without us tearing down + re-creating the observer
  // on every state change. The observer itself is created once when
  // the sentinel attaches.
  const hasMoreRef = useRef(hasMore);
  const loadingRef = useRef(loading);
  const loadMoreRef = useRef(loadMore);
  hasMoreRef.current = hasMore;
  loadingRef.current = loading;
  loadMoreRef.current = loadMore;

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  return useCallback(
    (el: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      sentinelRef.current = el;
      if (!el) return;

      const root = findScrollRoot(el);
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && hasMoreRef.current && !loadingRef.current) {
              loadMoreRef.current();
            }
          }
        },
        { root, rootMargin, threshold: 0 },
      );
      observer.observe(el);
      observerRef.current = observer;
    },
    [rootMargin],
  );
}

/** Walk ancestors looking for the nearest element that actually scrolls
 *  on the y-axis. Falls back to `null` (= document viewport) if nothing
 *  scrollable is found, which is the right default when the component
 *  is rendered outside the tray's normal scroll chrome. */
function findScrollRoot(start: HTMLElement): Element | null {
  let node: HTMLElement | null = start.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    const overflowY = style.overflowY;
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}
