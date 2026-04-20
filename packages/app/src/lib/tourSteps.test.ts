import { describe, expect, it } from 'vitest';
import { TOUR_STEPS } from './tourSteps.js';

describe('TOUR_STEPS', () => {
  it('starts with a welcome step that has no target', () => {
    expect(TOUR_STEPS[0]?.targetId).toBeNull();
    expect(TOUR_STEPS[0]?.title.toLowerCase()).toMatch(/welcome/);
  });

  it('covers the features called out in README: round-robin, security, alerts', () => {
    const ids = TOUR_STEPS.map((s) => s.targetId);
    expect(ids).toContain('switching-mode');
    expect(ids).toContain('tab-security');
    expect(ids).toContain('tab-notifications');
  });

  it('ends with a replay hint that points at the help icon', () => {
    const last = TOUR_STEPS[TOUR_STEPS.length - 1];
    expect(last?.targetId).toBe('tour-replay');
  });

  it('declares placement for every step', () => {
    for (const step of TOUR_STEPS) {
      expect(['auto', 'top', 'bottom']).toContain(step.placement);
    }
  });
});
