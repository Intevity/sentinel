import { describe, expect, it } from 'vitest';
import { TOUR_STEPS, CORE_STEP_COUNT, type TourAccent } from './tourSteps.js';

const VALID_ACCENTS: TourAccent[] = [
  'indigo',
  'blue',
  'teal',
  'red',
  'orange',
  'violet',
  'green',
  'sky',
  'gray',
];

describe('TOUR_STEPS', () => {
  it('starts with a welcome step that has no target', () => {
    expect(TOUR_STEPS[0]?.targetId).toBeNull();
    expect(TOUR_STEPS[0]?.title.toLowerCase()).toMatch(/welcome/);
  });

  it('declares a 5-step core track ahead of the power-user track', () => {
    expect(CORE_STEP_COUNT).toBe(5);
    for (let i = 0; i < CORE_STEP_COUNT; i++) {
      expect(TOUR_STEPS[i]?.track).toBe('core');
    }
    for (let i = CORE_STEP_COUNT; i < TOUR_STEPS.length; i++) {
      expect(TOUR_STEPS[i]?.track).toBe('power');
    }
  });

  it('covers the core feature pillars: accounts, round-robin, security, alerts', () => {
    const coreIds = TOUR_STEPS.slice(0, CORE_STEP_COUNT).map((s) => s.targetId);
    expect(coreIds).toContain('add-account');
    expect(coreIds).toContain('switching-mode');
    expect(coreIds).toContain('tab-security');
    expect(coreIds).toContain('tab-notifications');
  });

  it('includes power-user steps for permissions, budget, metrics, and replay', () => {
    const powerSteps = TOUR_STEPS.filter((s) => s.track === 'power');
    expect(powerSteps.length).toBe(4);
    const powerTitles = powerSteps.map((s) => s.title.toLowerCase()).join(' | ');
    expect(powerTitles).toMatch(/permission/);
    expect(powerTitles).toMatch(/budget/);
    expect(powerTitles).toMatch(/metric/);
    expect(powerTitles).toMatch(/replay/);
  });

  it('targets the header shield for permissions and the metrics tab for telemetry', () => {
    const ids = TOUR_STEPS.map((s) => s.targetId);
    expect(ids).toContain('tour-permissions');
    expect(ids).toContain('tab-metrics');
  });

  it('ends with a replay hint that points at the help icon', () => {
    const last = TOUR_STEPS[TOUR_STEPS.length - 1];
    expect(last?.targetId).toBe('tour-replay');
  });

  it('declares placement, icon, accent, illustration, and track for every step', () => {
    for (const step of TOUR_STEPS) {
      expect(['auto', 'top', 'bottom']).toContain(step.placement);
      expect(step.icon).toBeTypeOf('object');
      expect(VALID_ACCENTS).toContain(step.accent);
      expect(step.illustration).toBeTypeOf('function');
      expect(['core', 'power']).toContain(step.track);
    }
  });

  it('uses a unique accent for each step so the visual rhythm changes', () => {
    const accents = new Set(TOUR_STEPS.map((s) => s.accent));
    expect(accents.size).toBe(TOUR_STEPS.length);
  });

  it('keeps the tab-switcher steps on the accounts tab', () => {
    const tabbedSteps = TOUR_STEPS.filter((s) => s.tab === 'accounts');
    expect(tabbedSteps.length).toBeGreaterThanOrEqual(2);
    expect(tabbedSteps.every((s) => s.targetId !== null)).toBe(true);
  });

  it('forbids em dashes in user-facing copy (uses colons or semicolons instead)', () => {
    for (const step of TOUR_STEPS) {
      expect(step.title).not.toMatch(/—/);
      expect(step.body).not.toMatch(/—/);
    }
  });
});
