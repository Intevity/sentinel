import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecSync = vi.fn<(cmd: string, opts?: object) => string>();

vi.mock('child_process', () => ({
  execSync: (cmd: string, opts?: object) => mockExecSync(cmd, opts),
}));

const {
  readActiveCredentials,
  captureCurrentCredentials,
  readSentinelCredentials,
  writeSentinelCredentials,
  writeClaudeCodeCredentials,
  deleteSentinelCredentials,
} = await import('./accounts.js');

const sampleCreds = {
  accessToken: 'at-test',
  refreshToken: 'rt-test',
  expiresAt: 9999999999000,
  scopes: ['read', 'write'],
  subscriptionType: 'max',
  rateLimitTier: 'standard',
  tokenAccount: {
    uuid: 'uuid-1',
    emailAddress: 'test@example.com',
    organizationUuid: 'org-1',
  },
};

describe('accounts', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  describe('readSentinelCredentials', () => {
    it('reads from sentinel service by email on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockReturnValue(JSON.stringify(sampleCreds));

      const result = readSentinelCredentials('test@example.com');
      expect(result?.accessToken).toBe('at-test');
      const cmd = mockExecSync.mock.calls[0]?.[0] ?? '';
      expect(cmd).toContain('Claude Sentinel-credentials');
    });

    it('returns null when execSync throws', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      expect(readSentinelCredentials('none@example.com')).toBeNull();
    });

    it('returns null on invalid JSON', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockReturnValue('not-json');
      expect(readSentinelCredentials('test@example.com')).toBeNull();
    });
  });

  describe('writeSentinelCredentials', () => {
    it('writes to sentinel service on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockReturnValue('');
      writeSentinelCredentials('test@example.com', sampleCreds);
      const cmd = mockExecSync.mock.calls[0]?.[0] ?? '';
      expect(cmd).toContain('security add-generic-password');
      expect(cmd).toContain('Claude Sentinel-credentials');
    });

    it('writes to sentinel service on linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      mockExecSync.mockReturnValue('');
      writeSentinelCredentials('test@example.com', sampleCreds);
      const cmd = mockExecSync.mock.calls[0]?.[0] ?? '';
      expect(cmd).toContain('secret-tool store');
    });
  });

  describe('deleteSentinelCredentials', () => {
    it('issues `security delete-generic-password` on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockReturnValue('');
      deleteSentinelCredentials('test@example.com');
      const cmd = mockExecSync.mock.calls[0]?.[0] ?? '';
      expect(cmd).toContain('security delete-generic-password');
      expect(cmd).toContain('Claude Sentinel-credentials');
    });

    it('swallows errors when the entry does not exist on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      // Should not throw
      expect(() => deleteSentinelCredentials('missing@example.com')).not.toThrow();
    });

    it('issues `secret-tool clear` on linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      mockExecSync.mockReturnValue('');
      deleteSentinelCredentials('test@example.com');
      const cmd = mockExecSync.mock.calls[0]?.[0] ?? '';
      expect(cmd).toContain('secret-tool clear');
    });

    it('swallows errors on linux when the entry does not exist', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      expect(() => deleteSentinelCredentials('missing@example.com')).not.toThrow();
    });
  });

  describe('readActiveCredentials', () => {
    it('returns sentinel-stored credentials when available', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // First call: sentinel store lookup returns the creds
      mockExecSync.mockReturnValue(JSON.stringify(sampleCreds));

      const result = readActiveCredentials('test@example.com');
      expect(result?.accessToken).toBe('at-test');
      // Should have hit the sentinel service, not Claude Code's service
      const cmd = mockExecSync.mock.calls[0]?.[0] ?? '';
      expect(cmd).toContain('Claude Sentinel-credentials');
    });

    it('falls back to Claude Code keychain when no sentinel entry exists', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // First call (sentinel) throws, second call (CC) returns creds
      const ccBlob = JSON.stringify({ claudeAiOauth: sampleCreds });
      mockExecSync
        .mockImplementationOnce(() => { throw new Error('not found'); }) // sentinel miss
        .mockReturnValue(ccBlob); // CC slot

      // activeEmail matches the target email → fall back allowed
      const result = readActiveCredentials('test@example.com', 'test@example.com');
      expect(result?.accessToken).toBe('at-test');
    });

    it('returns null when both stores miss', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });
      expect(readActiveCredentials('nobody@example.com', 'nobody@example.com')).toBeNull();
    });

    it('does not fall back to CC slot when active email differs', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // Sentinel miss, then CC would return something — but we should NOT read it
      mockExecSync
        .mockImplementationOnce(() => { throw new Error('not found'); }) // sentinel miss
        .mockReturnValue(JSON.stringify({ claudeAiOauth: sampleCreds })); // CC slot

      // Target email != active email → no fallback
      const result = readActiveCredentials('other@example.com', 'active@example.com');
      expect(result).toBeNull();
      // Only 1 call made (sentinel only)
      expect(mockExecSync).toHaveBeenCalledOnce();
    });
  });

  describe('writeClaudeCodeCredentials', () => {
    it('writes to Claude Code keychain on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockReturnValue('');
      writeClaudeCodeCredentials(sampleCreds);
      const cmd = mockExecSync.mock.calls[0]?.[0] ?? '';
      expect(cmd).toContain('security add-generic-password');
      expect(cmd).toContain('Claude Code-credentials');
      // The blob written should contain claudeAiOauth wrapper
      expect(cmd).toContain('claudeAiOauth');
    });
  });

  describe('captureCurrentCredentials', () => {
    it('reads CC slot, writes to sentinel store, and returns creds', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const ccBlob = JSON.stringify({ claudeAiOauth: sampleCreds });
      // sampleCreds has subscriptionType + rateLimitTier, so no sentinel read needed
      // Call 1: CC read, Call 2: sentinel write
      mockExecSync
        .mockReturnValueOnce(ccBlob) // CC read
        .mockReturnValueOnce('');    // sentinel write

      const result = captureCurrentCredentials('test@example.com');
      expect(result?.accessToken).toBe('at-test');
      expect(mockExecSync).toHaveBeenCalledTimes(2);
      // Second call should write to sentinel
      const writeCmd = mockExecSync.mock.calls[1]?.[0] ?? '';
      expect(writeCmd).toContain('Claude Sentinel-credentials');
    });

    it('preserves subscriptionType from existing sentinel entry when CC creds lack it', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const ccCredsNoSub = { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: 9999 };
      const ccBlob = JSON.stringify({ claudeAiOauth: ccCredsNoSub });
      const sentinelBlob = JSON.stringify({ ...ccCredsNoSub, subscriptionType: 'max', rateLimitTier: 'premium' });
      // Call 1: CC read, Call 2: sentinel read (for preservation), Call 3: sentinel write
      mockExecSync
        .mockReturnValueOnce(ccBlob)      // CC slot read
        .mockReturnValueOnce(sentinelBlob) // sentinel read (existing entry)
        .mockReturnValueOnce('');          // sentinel write

      const result = captureCurrentCredentials('account-uuid');
      expect(result?.subscriptionType).toBe('max');
      expect(result?.rateLimitTier).toBe('premium');
      expect(result?.accessToken).toBe('at-new');
      // Written blob should include the preserved fields
      const writeCmd = mockExecSync.mock.calls[2]?.[0] ?? '';
      expect(writeCmd).toContain('max');
    });

    it('does not override subscriptionType already present in CC creds', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const ccCreds = { ...sampleCreds, subscriptionType: 'team', rateLimitTier: 'standard' };
      const ccBlob = JSON.stringify({ claudeAiOauth: ccCreds });
      // CC has both fields — no sentinel read should happen
      mockExecSync
        .mockReturnValueOnce(ccBlob) // CC read
        .mockReturnValueOnce('');    // sentinel write

      const result = captureCurrentCredentials('account-uuid');
      expect(result?.subscriptionType).toBe('team');
      // Only 2 calls: CC read + sentinel write (no sentinel read needed)
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it('handles sentinel read failure gracefully during preservation', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const ccCredsNoSub = { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: 9999 };
      const ccBlob = JSON.stringify({ claudeAiOauth: ccCredsNoSub });
      mockExecSync
        .mockReturnValueOnce(ccBlob) // CC read
        .mockImplementationOnce(() => { throw new Error('no entry'); }) // sentinel read fails
        .mockReturnValueOnce('');    // sentinel write

      const result = captureCurrentCredentials('account-uuid');
      expect(result?.accessToken).toBe('at-new');
      expect(result?.subscriptionType).toBeUndefined();
    });

    it('returns null when CC slot is empty', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockReturnValue(''); // empty result
      const result = captureCurrentCredentials('test@example.com');
      expect(result).toBeNull();
    });
  });
});
