import { describe, it, expect } from 'vitest';
import { detectPlugins } from './plugin-detector.js';

describe('detectPlugins', () => {
  it('returns [] for non-object inputs', () => {
    expect(detectPlugins(null)).toEqual([]);
    expect(detectPlugins(42)).toEqual([]);
  });

  it('returns [] when enabledPlugins is missing or empty', () => {
    expect(detectPlugins({})).toEqual([]);
    expect(detectPlugins({ enabledPlugins: {} })).toEqual([]);
  });

  it('returns plugin names whose value is truthy', () => {
    const out = detectPlugins({
      enabledPlugins: {
        'figma@1.0': true,
        'frontend-design@2': true,
        'review-tools@3': false,
      },
    });
    expect(out.map((p) => p.name).sort()).toEqual(['figma@1.0', 'frontend-design@2']);
  });

  it('skips falsy values (Claude Code stores `false` for disabled plugins)', () => {
    const out = detectPlugins({
      enabledPlugins: { a: true, b: false, c: 0, d: null, e: '' },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('a');
  });
});
