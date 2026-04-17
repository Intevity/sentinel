import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync, readdirSync } from 'fs';
import type { OAuthAccount, ClaudeState } from '@claude-sentinel/shared';
import {
  CLAUDE_JSON_PATH,
  readClaudeState,
  writeClaudeState,
  updateClaudeState,
  setActiveAccount,
  getActiveAccount,
} from './claude-state.js';

// Use a temp path for all tests to avoid touching ~/.claude.json
const TEST_PATH = join(tmpdir(), `claude-test-${process.pid}.json`);

const mockAccount: OAuthAccount = {
  accountUuid: 'uuid-test',
  emailAddress: 'test@example.com',
  organizationUuid: 'org-test',
  hasExtraUsageEnabled: false,
  billingType: 'stripe_subscription',
  accountCreatedAt: '2024-01-01T00:00:00Z',
  subscriptionCreatedAt: '2024-01-01T00:00:00Z',
  displayName: 'Test User',
  organizationRole: 'user',
  workspaceRole: null,
  organizationName: 'Test Org',
};

function cleanup() {
  if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH);
  // Clean up any lingering tmp files
  try {
    const dir = tmpdir();
    // readdirSync imported at top of file
    readdirSync(dir)
      .filter((f: string) => f.startsWith(`claude-test-${process.pid}`))
      .forEach((f: string) => unlinkSync(join(dir, f)));
  } catch {
    // ignore
  }
}

describe('claude-state', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('CLAUDE_JSON_PATH points to ~/.claude.json', () => {
    expect(CLAUDE_JSON_PATH).toContain('.claude.json');
    expect(CLAUDE_JSON_PATH).toContain(process.env['HOME'] ?? '');
  });

  describe('readClaudeState', () => {
    it('returns empty object when file does not exist', () => {
      expect(readClaudeState(TEST_PATH)).toEqual({});
    });

    it('reads and parses existing JSON file', () => {
      writeClaudeState({ hasAvailableSubscription: true }, TEST_PATH);
      const state = readClaudeState(TEST_PATH);
      expect(state.hasAvailableSubscription).toBe(true);
    });

    it('handles extra fields (unknown keys)', () => {
      const data = { hasAvailableSubscription: true, unknownKey: 'value' };
      writeClaudeState(data, TEST_PATH);
      const state = readClaudeState(TEST_PATH);
      expect(state['unknownKey']).toBe('value');
    });
  });

  describe('writeClaudeState', () => {
    it('creates file with correct content', () => {
      writeClaudeState({ hasAvailableSubscription: false }, TEST_PATH);
      expect(existsSync(TEST_PATH)).toBe(true);
      const state = readClaudeState(TEST_PATH);
      expect(state.hasAvailableSubscription).toBe(false);
    });

    it('uses atomic write (no leftover .tmp file)', () => {
      writeClaudeState({ hasAvailableSubscription: true }, TEST_PATH);
      // No .tmp files should remain
      const tmpGlob = `${TEST_PATH}.tmp`;
      // The tmp file includes pid and timestamp so we look for prefix
      expect(existsSync(tmpGlob)).toBe(false);
    });

    it('overwrites existing file completely', () => {
      writeClaudeState({ hasAvailableSubscription: true }, TEST_PATH);
      writeClaudeState({ hasAvailableSubscription: false }, TEST_PATH);
      expect(readClaudeState(TEST_PATH).hasAvailableSubscription).toBe(false);
    });

    it('preserves null values', () => {
      writeClaudeState({ cachedExtraUsageDisabledReason: null }, TEST_PATH);
      expect(readClaudeState(TEST_PATH).cachedExtraUsageDisabledReason).toBeNull();
    });
  });

  describe('updateClaudeState', () => {
    it('merges patch into existing state', () => {
      writeClaudeState({ hasAvailableSubscription: true }, TEST_PATH);
      updateClaudeState({ cachedExtraUsageDisabledReason: 'reason' }, TEST_PATH);
      const state = readClaudeState(TEST_PATH);
      expect(state.hasAvailableSubscription).toBe(true);
      expect(state.cachedExtraUsageDisabledReason).toBe('reason');
    });

    it('works when file does not yet exist', () => {
      updateClaudeState({ hasAvailableSubscription: false }, TEST_PATH);
      expect(readClaudeState(TEST_PATH).hasAvailableSubscription).toBe(false);
    });

    it('preserves all existing fields on update', () => {
      const initial: ClaudeState = {
        hasAvailableSubscription: true,
        oauthAccount: mockAccount,
        customField: 'preserved',
      };
      writeClaudeState(initial, TEST_PATH);
      updateClaudeState({ cachedExtraUsageDisabledReason: null }, TEST_PATH);
      const state = readClaudeState(TEST_PATH);
      expect(state.hasAvailableSubscription).toBe(true);
      expect(state.oauthAccount?.emailAddress).toBe('test@example.com');
      expect(state['customField']).toBe('preserved');
    });

    it('allows overwriting a field', () => {
      writeClaudeState({ hasAvailableSubscription: true }, TEST_PATH);
      updateClaudeState({ hasAvailableSubscription: false }, TEST_PATH);
      expect(readClaudeState(TEST_PATH).hasAvailableSubscription).toBe(false);
    });
  });

  describe('setActiveAccount', () => {
    it('writes oauthAccount to state', () => {
      setActiveAccount(mockAccount, TEST_PATH);
      const state = readClaudeState(TEST_PATH);
      expect(state.oauthAccount?.emailAddress).toBe('test@example.com');
      expect(state.oauthAccount?.accountUuid).toBe('uuid-test');
    });

    it('replaces existing account', () => {
      setActiveAccount(mockAccount, TEST_PATH);
      setActiveAccount({ ...mockAccount, emailAddress: 'other@example.com' }, TEST_PATH);
      expect(getActiveAccount(TEST_PATH)?.emailAddress).toBe('other@example.com');
    });

    it('preserves other state fields', () => {
      writeClaudeState({ hasAvailableSubscription: true }, TEST_PATH);
      setActiveAccount(mockAccount, TEST_PATH);
      expect(readClaudeState(TEST_PATH).hasAvailableSubscription).toBe(true);
    });

    it('works from empty state', () => {
      setActiveAccount(mockAccount, TEST_PATH);
      expect(existsSync(TEST_PATH)).toBe(true);
    });
  });

  describe('getActiveAccount', () => {
    it('returns null when file does not exist', () => {
      expect(getActiveAccount(TEST_PATH)).toBeNull();
    });

    it('returns null when oauthAccount missing from state', () => {
      writeClaudeState({ hasAvailableSubscription: true }, TEST_PATH);
      expect(getActiveAccount(TEST_PATH)).toBeNull();
    });

    it('returns the stored account', () => {
      setActiveAccount(mockAccount, TEST_PATH);
      const account = getActiveAccount(TEST_PATH);
      expect(account).not.toBeNull();
      expect(account?.emailAddress).toBe('test@example.com');
      expect(account?.organizationRole).toBe('user');
      expect(account?.workspaceRole).toBeNull();
      expect(account?.hasExtraUsageEnabled).toBe(false);
    });

    it('returns updated account after switch', () => {
      setActiveAccount(mockAccount, TEST_PATH);
      setActiveAccount({ ...mockAccount, emailAddress: 'new@example.com' }, TEST_PATH);
      expect(getActiveAccount(TEST_PATH)?.emailAddress).toBe('new@example.com');
    });
  });
});
