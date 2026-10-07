import { describe, it, expect } from 'vitest';
import {
  clearSurfaceBannerDismissal,
  dismissSurfaceBanner,
  isSurfaceBannerDismissed,
} from './surfaceBannerDismissal.js';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe('surface banner dismissal', () => {
  it('remembers a dismissal per surface', () => {
    const s = memoryStorage();
    expect(isSurfaceBannerDismissed('opencode', s)).toBe(false);
    dismissSurfaceBanner('opencode', s);
    expect(isSurfaceBannerDismissed('opencode', s)).toBe(true);
    expect(isSurfaceBannerDismissed('desktop', s)).toBe(false);
  });

  it('forgets a dismissal once cleared (the surface got routed)', () => {
    const s = memoryStorage();
    dismissSurfaceBanner('desktop', s);
    clearSurfaceBannerDismissal('desktop', s);
    expect(isSurfaceBannerDismissed('desktop', s)).toBe(false);
  });

  it('fails open when storage is missing or throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(isSurfaceBannerDismissed('opencode', throwing)).toBe(false);
    expect(() => dismissSurfaceBanner('opencode', throwing)).not.toThrow();
    expect(() => clearSurfaceBannerDismissal('opencode', throwing)).not.toThrow();
    expect(isSurfaceBannerDismissed('opencode', null)).toBe(false);
  });
});
