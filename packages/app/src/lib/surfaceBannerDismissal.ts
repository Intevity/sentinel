/**
 * Remembers which "Route <surface> through Sentinel" cards the user dismissed.
 *
 * The cards offer to route an optional surface (Claude Desktop, opencode)
 * through the proxy. A user who does not want that needs a way to stop being
 * asked; the same choice stays available as a toggle in Settings → General, so
 * hiding the card loses nothing.
 *
 * A dismissal lasts until the surface is routed through Sentinel. Routing it
 * (from Settings) clears the flag, so a later problem with that routing (the
 * desktop app pointed at another gateway, an opencode plugin overriding the
 * base URL) surfaces its warning again rather than staying silenced by an
 * old "not interested".
 *
 * Persisted in localStorage like PersistenceBanner's flag. Every access is
 * guarded: storage can be unavailable in some WebView contexts, and then the
 * card fails open (shown, dismissible for the session).
 */

export type DismissibleSurface = 'desktop' | 'opencode';

const keyFor = (surface: DismissibleSurface): string =>
  `sentinel.surfaceBannerDismissed.${surface}.v1`;

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function isSurfaceBannerDismissed(
  surface: DismissibleSurface,
  storage: KeyValueStorage | null = defaultStorage(),
): boolean {
  try {
    return storage?.getItem(keyFor(surface)) === '1';
  } catch {
    return false;
  }
}

export function dismissSurfaceBanner(
  surface: DismissibleSurface,
  storage: KeyValueStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(keyFor(surface), '1');
  } catch {
    /* no-op: the caller still hides the card for this session */
  }
}

export function clearSurfaceBannerDismissal(
  surface: DismissibleSurface,
  storage: KeyValueStorage | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(keyFor(surface));
  } catch {
    /* no-op */
  }
}
