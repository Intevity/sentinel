import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OverageStateMachine,
  OVERAGE_STATUS_HEADER,
  OVERAGE_RESET_HEADER,
  OVERAGE_REASON_HEADER,
  OVERAGE_IN_USE_HEADER,
} from './overage.js';

describe('OverageStateMachine', () => {
  let machine: OverageStateMachine;

  beforeEach(() => {
    machine = new OverageStateMachine();
  });

  describe('parseHeaders', () => {
    it('returns null values when no overage headers present', () => {
      const result = machine.parseHeaders({ 'content-type': 'application/json' });
      expect(result).toEqual({ status: null, resetsAt: null, disabledReason: null, inUse: null });
    });

    it('parses allowed status with in-use=true (actively consuming overage)', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_RESET_HEADER]: '1776700800',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      expect(result.status).toBe('allowed');
      expect(result.resetsAt).toBe(1776700800);
      expect(result.inUse).toBe(true);
    });

    it('parses allowed status without in-use header as inUse=false', () => {
      // Live team-account shape: overage window exists but no request has drawn from it.
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_RESET_HEADER]: '1776700800',
      });
      expect(result.status).toBe('allowed');
      expect(result.inUse).toBe(false);
    });

    it('parses disabled status with reason', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: 'disabled',
        [OVERAGE_REASON_HEADER]: 'budget_exhausted',
      });
      expect(result.status).toBe('disabled');
      expect(result.disabledReason).toBe('budget_exhausted');
      expect(result.inUse).toBe(false);
    });

    it('accepts in-use=1 as truthy', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: '1',
      });
      expect(result.inUse).toBe(true);
    });

    it('treats non-truthy in-use values as false', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'false',
      });
      expect(result.inUse).toBe(false);
    });

    it('handles array header values', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: ['allowed', 'extra'],
        [OVERAGE_IN_USE_HEADER]: ['true'],
      });
      expect(result.status).toBe('allowed');
      expect(result.inUse).toBe(true);
    });

    it('handles array header values for all headers', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: ['allowed'],
        [OVERAGE_RESET_HEADER]: ['1776700800'],
        [OVERAGE_REASON_HEADER]: ['budget_exhausted'],
        [OVERAGE_IN_USE_HEADER]: ['true'],
      });
      expect(result.status).toBe('allowed');
      expect(result.resetsAt).toBe(1776700800);
      expect(result.disabledReason).toBe('budget_exhausted');
      expect(result.inUse).toBe(true);
    });

    it('returns null values for empty array headers', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: [],
        [OVERAGE_RESET_HEADER]: [],
        [OVERAGE_REASON_HEADER]: [],
        [OVERAGE_IN_USE_HEADER]: [],
      });
      expect(result.status).toBeNull();
      expect(result.resetsAt).toBeNull();
      expect(result.disabledReason).toBeNull();
      expect(result.inUse).toBeNull();
    });

    it('returns null resetsAt for invalid number', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_RESET_HEADER]: 'not-a-number',
      });
      expect(result.resetsAt).toBeNull();
    });
  });

  describe('handleHeaders', () => {
    it('returns null when no overage headers present', () => {
      const result = machine.handleHeaders('acc1', { 'x-custom': 'value' });
      expect(result).toBeNull();
    });

    it('returns null when overage window is present but in-use=false (team account shape)', () => {
      // Regression test for the original bug: observing overage headers on an
      // account that isn't currently consuming overage must NOT fire a transition.
      const result = machine.handleHeaders('team', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_RESET_HEADER]: '1776700800',
      });
      expect(result).toBeNull();
    });

    it('detects entered transition on first in-use=true header', () => {
      const result = machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_RESET_HEADER]: '1776700800',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      expect(result?.transition).toBe('entered');
      expect(result?.accountId).toBe('acc1');
      expect(result?.state.isUsingOverage).toBe(true);
      expect(result?.state.resetsAt).toBe(1776700800);
    });

    it('does not fire entered transition twice in a row', () => {
      machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      const second = machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      expect(second).toBeNull();
    });

    it('detects exited transition when in-use drops off', () => {
      machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      const result = machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
      });
      expect(result?.transition).toBe('exited');
      expect(result?.state.isUsingOverage).toBe(false);
    });

    it('detects disabled transition', () => {
      const result = machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'disabled',
        [OVERAGE_REASON_HEADER]: 'budget_exhausted',
      });
      expect(result?.transition).toBe('disabled');
      expect(result?.state.status).toBe('disabled');
      expect(result?.state.disabledReason).toBe('budget_exhausted');
    });

    it('does not fire disabled transition twice', () => {
      machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'disabled' });
      const second = machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'disabled' });
      expect(second).toBeNull();
    });

    it('tracks different accounts independently', () => {
      const r1 = machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      const r2 = machine.handleHeaders('acc2', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      expect(r1?.transition).toBe('entered');
      expect(r2?.transition).toBe('entered');
    });

    it('calls registered transition handlers', () => {
      const handler = vi.fn();
      machine.onTransition(handler);
      machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]?.[0].transition).toBe('entered');
    });

    it('calls multiple handlers', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      machine.onTransition(h1);
      machine.onTransition(h2);
      machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });
  });

  describe('getState', () => {
    it('returns null for unknown account', () => {
      expect(machine.getState('unknown')).toBeNull();
    });

    it('returns current state after update', () => {
      machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_RESET_HEADER]: '1776700800',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      const state = machine.getState('acc1');
      expect(state?.isUsingOverage).toBe(true);
      expect(state?.resetsAt).toBe(1776700800);
    });
  });

  describe('resetState', () => {
    it('clears state for an account', () => {
      machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      machine.resetState('acc1');
      expect(machine.getState('acc1')).toBeNull();
    });

    it('is idempotent for unknown accounts', () => {
      expect(() => machine.resetState('unknown')).not.toThrow();
    });
  });

  describe('getTrackedAccounts', () => {
    it('returns empty array initially', () => {
      expect(machine.getTrackedAccounts()).toEqual([]);
    });

    it('returns tracked account IDs after updates', () => {
      machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      machine.handleHeaders('acc2', {
        [OVERAGE_STATUS_HEADER]: 'allowed',
        [OVERAGE_IN_USE_HEADER]: 'true',
      });
      const accounts = machine.getTrackedAccounts();
      expect(accounts).toHaveLength(2);
      expect(accounts).toContain('acc1');
      expect(accounts).toContain('acc2');
    });
  });
});
