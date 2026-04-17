import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OverageStateMachine, OVERAGE_STATUS_HEADER, OVERAGE_RESET_HEADER, OVERAGE_REASON_HEADER } from './overage.js';

describe('OverageStateMachine', () => {
  let machine: OverageStateMachine;

  beforeEach(() => {
    machine = new OverageStateMachine();
  });

  describe('parseHeaders', () => {
    it('returns null values when no overage headers present', () => {
      const result = machine.parseHeaders({ 'content-type': 'application/json' });
      expect(result).toEqual({ status: null, resetsAt: null, disabledReason: null });
    });

    it('parses active status header', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: 'active',
        [OVERAGE_RESET_HEADER]: '1776700800',
      });
      expect(result.status).toBe('active');
      expect(result.resetsAt).toBe(1776700800);
      expect(result.disabledReason).toBeNull();
    });

    it('parses disabled status with reason', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: 'disabled',
        [OVERAGE_REASON_HEADER]: 'budget_exhausted',
      });
      expect(result.status).toBe('disabled');
      expect(result.disabledReason).toBe('budget_exhausted');
    });

    it('handles array header values (multiple values)', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: ['active', 'extra'],
      });
      expect(result.status).toBe('active');
    });

    it('handles array header values for all three headers', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: ['active'],
        [OVERAGE_RESET_HEADER]: ['1776700800'],
        [OVERAGE_REASON_HEADER]: ['budget_exhausted'],
      });
      expect(result.status).toBe('active');
      expect(result.resetsAt).toBe(1776700800);
      expect(result.disabledReason).toBe('budget_exhausted');
    });

    it('returns null for empty array header values', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: [],
        [OVERAGE_RESET_HEADER]: [],
        [OVERAGE_REASON_HEADER]: [],
      });
      expect(result.status).toBeNull();
      expect(result.resetsAt).toBeNull();
      expect(result.disabledReason).toBeNull();
    });

    it('returns null resetsAt for invalid number', () => {
      const result = machine.parseHeaders({
        [OVERAGE_STATUS_HEADER]: 'active',
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

    it('detects entered transition on first active header', () => {
      const result = machine.handleHeaders('acc1', {
        [OVERAGE_STATUS_HEADER]: 'active',
        [OVERAGE_RESET_HEADER]: '1776700800',
      });
      expect(result).not.toBeNull();
      expect(result?.transition).toBe('entered');
      expect(result?.accountId).toBe('acc1');
      expect(result?.state.isUsingOverage).toBe(true);
      expect(result?.state.resetsAt).toBe(1776700800);
    });

    it('does not fire entered transition twice in a row', () => {
      machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'active' });
      const second = machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'active' });
      expect(second).toBeNull();
    });

    it('detects exited transition', () => {
      // First enter overage
      machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'active' });
      // Then exit (status no longer active)
      const result = machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'inactive' });
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
      const r1 = machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'active' });
      const r2 = machine.handleHeaders('acc2', { [OVERAGE_STATUS_HEADER]: 'active' });
      expect(r1?.transition).toBe('entered');
      expect(r2?.transition).toBe('entered');
    });

    it('calls registered transition handlers', () => {
      const handler = vi.fn();
      machine.onTransition(handler);
      machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'active' });
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]?.[0].transition).toBe('entered');
    });

    it('calls multiple handlers', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      machine.onTransition(h1);
      machine.onTransition(h2);
      machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'active' });
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
        [OVERAGE_STATUS_HEADER]: 'active',
        [OVERAGE_RESET_HEADER]: '1776700800',
      });
      const state = machine.getState('acc1');
      expect(state).not.toBeNull();
      expect(state?.isUsingOverage).toBe(true);
      expect(state?.resetsAt).toBe(1776700800);
    });
  });

  describe('resetState', () => {
    it('clears state for an account', () => {
      machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'active' });
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
      machine.handleHeaders('acc1', { [OVERAGE_STATUS_HEADER]: 'active' });
      machine.handleHeaders('acc2', { [OVERAGE_STATUS_HEADER]: 'active' });
      const accounts = machine.getTrackedAccounts();
      expect(accounts).toHaveLength(2);
      expect(accounts).toContain('acc1');
      expect(accounts).toContain('acc2');
    });
  });
});
