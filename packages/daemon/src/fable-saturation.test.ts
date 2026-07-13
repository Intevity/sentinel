import { describe, it, expect, beforeEach } from 'vitest';
import {
  FableSaturationMachine,
  buildFableSaturationBody,
  type FableSaturationEvent,
} from './fable-saturation.js';

describe('FableSaturationMachine', () => {
  let machine: FableSaturationMachine;

  beforeEach(() => {
    machine = new FableSaturationMachine();
  });

  it('emits entered when utilization first crosses the threshold', () => {
    const events: FableSaturationEvent[] = [];
    machine.onTransition((e) => events.push(e));

    const out = machine.update('acct', 0.97, 9_000, 95);
    expect(out?.transition).toBe('entered');
    expect(out?.utilization).toBe(0.97);
    expect(events).toHaveLength(1);
    expect(events[0]?.transition).toBe('entered');
    expect(machine.isSaturated('acct')).toBe(true);
  });

  it('does not emit entered twice for the same reset window', () => {
    machine.update('acct', 0.97, 9_000, 95);
    const second = machine.update('acct', 0.98, 9_000, 95);
    expect(second).toBeNull();
  });

  it('emits exited when utilization falls back below the threshold', () => {
    const events: FableSaturationEvent[] = [];
    machine.onTransition((e) => events.push(e));
    machine.update('acct', 0.97, 9_000, 95);
    const exit = machine.update('acct', 0.5, 9_000, 95);
    expect(exit?.transition).toBe('exited');
    expect(events.map((e) => e.transition)).toEqual(['entered', 'exited']);
    expect(machine.isSaturated('acct')).toBe(false);
  });

  it('re-arms for a new window when resetsAt changes', () => {
    machine.update('acct', 0.97, 9_000, 95);
    // Stays saturated but the window rolled over — should emit a fresh
    // `entered` so the new window gets its own timeline entry.
    const rolled = machine.update('acct', 0.97, 20_000, 95);
    expect(rolled?.transition).toBe('entered');
    expect(rolled?.resetsAt).toBe(20_000);
  });

  it('returns null when utilization is unknown (null)', () => {
    expect(machine.update('acct', null, 9_000, 95)).toBeNull();
    expect(machine.isSaturated('acct')).toBe(false);
  });

  it('clamps negative threshold to 0 and out-of-range to 100', () => {
    // threshold=-5 → clamp to 0; utilization=0.0 ≥ 0 → saturated
    expect(machine.update('a', 0.0, 100, -5)?.transition).toBe('entered');
    // threshold=999 → clamp to 100; utilization=0.99 < 1.0 → not saturated
    expect(machine.update('b', 0.99, 100, 999)).toBeNull();
  });

  it('rehydrate suppresses re-emit of already-persisted entered', () => {
    const events: FableSaturationEvent[] = [];
    machine.onTransition((e) => events.push(e));
    // Simulate restart with entered already persisted for this window.
    machine.rehydrate('acct', { isSaturated: true, resetsAt: 9_000 }, ['entered']);
    // Same-window update with same-or-higher util must not re-emit entered.
    const out = machine.update('acct', 0.99, 9_000, 95);
    expect(out).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('resetState clears saturation state for an account', () => {
    machine.update('acct', 0.97, 9_000, 95);
    expect(machine.isSaturated('acct')).toBe(true);
    machine.resetState('acct');
    expect(machine.isSaturated('acct')).toBe(false);
    // After reset, a subsequent update fires a fresh entered.
    expect(machine.update('acct', 0.97, 9_000, 95)?.transition).toBe('entered');
  });

  it('isSaturated returns false for never-seen accounts', () => {
    expect(machine.isSaturated('unknown')).toBe(false);
  });

  it('skips exited re-emit within the same window', () => {
    machine.update('acct', 0.97, 9_000, 95);
    machine.update('acct', 0.5, 9_000, 95);
    // Dropping lower in the same window should NOT fire another exited.
    expect(machine.update('acct', 0.4, 9_000, 95)).toBeNull();
  });

  it('dedups a re-entered transition after an exit within the same window', () => {
    // Oscillation path: entered → exited → re-saturate while still in the
    // same reset window. The second `entered` must be swallowed by the
    // per-window dedup so the UI doesn't render a flapping timeline.
    expect(machine.update('acct', 0.97, 9_000, 95)?.transition).toBe('entered');
    expect(machine.update('acct', 0.5, 9_000, 95)?.transition).toBe('exited');
    expect(machine.update('acct', 0.99, 9_000, 95)).toBeNull();
  });
});

describe('buildFableSaturationBody', () => {
  it('tells opted-in accounts that further requests will draw overage', () => {
    const body = buildFableSaturationBody('user@x', 0.97, true);
    expect(body).toContain('97.0%');
    expect(body).toContain('will draw from overage');
    expect(body).not.toContain('blocked');
  });

  it('tells not-opted-in accounts that further requests will be blocked', () => {
    const body = buildFableSaturationBody('user@x', 1.0, false);
    expect(body).toContain('100.0%');
    expect(body).toContain('blocked by Sentinel');
    expect(body).toContain('enable overage in Settings');
    expect(body).not.toContain('will draw from overage');
  });
});
