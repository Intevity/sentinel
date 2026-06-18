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
      expect(cmd).toContain('Sentinel-credentials');
    });

    it('returns null when execSync throws', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
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
      expect(cmd).toContain('Sentinel-credentials');
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
      expect(cmd).toContain('Sentinel-credentials');
    });

    it('swallows errors when the entry does not exist on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
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
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
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
      expect(cmd).toContain('Sentinel-credentials');
    });

    it('falls back to Claude Code keychain when no sentinel entry exists', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // Sentinel reads (new + legacy) both miss, then the CC slot returns creds
      const ccBlob = JSON.stringify({ claudeAiOauth: sampleCreds });
      mockExecSync
        .mockImplementationOnce(() => {
          throw new Error('not found');
        }) // sentinel read (new service) miss
        .mockImplementationOnce(() => {
          throw new Error('not found');
        }) // sentinel read (legacy "Claude Sentinel-*" service) miss
        .mockReturnValue(ccBlob); // CC slot

      // activeEmail matches the target email → fall back allowed
      const result = readActiveCredentials('test@example.com', 'test@example.com');
      expect(result?.accessToken).toBe('at-test');
    });

    it('returns null when both stores miss', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(readActiveCredentials('nobody@example.com', 'nobody@example.com')).toBeNull();
    });

    it('does not fall back to CC slot when active email differs', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // Sentinel miss, then CC would return something — but we should NOT read it
      mockExecSync
        .mockImplementationOnce(() => {
          throw new Error('not found');
        }) // sentinel read (new service) miss
        .mockImplementationOnce(() => {
          throw new Error('not found');
        }) // sentinel read (legacy "Claude Sentinel-*" service) miss
        .mockReturnValue(JSON.stringify({ claudeAiOauth: sampleCreds })); // CC slot

      // Target email != active email → no fallback
      const result = readActiveCredentials('other@example.com', 'active@example.com');
      expect(result).toBeNull();
      // Sentinel new + legacy reads only; the CC slot is never read (active != target)
      expect(mockExecSync).toHaveBeenCalledTimes(2);
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
      // Call 1: CC read; Calls 2–3: sentinel read (new service, then the legacy
      // "Claude Sentinel-*" fallback on the miss — feeds the skip-identical-write
      // comparison); Call 4: sentinel write (existing entry missing → must write).
      mockExecSync
        .mockReturnValueOnce(ccBlob) // CC read
        .mockReturnValueOnce('') // sentinel read (new service) miss
        .mockReturnValueOnce('') // sentinel read (legacy service) miss
        .mockReturnValueOnce(''); // sentinel write

      const result = captureCurrentCredentials('test@example.com');
      expect(result?.accessToken).toBe('at-test');
      expect(mockExecSync).toHaveBeenCalledTimes(4);
      // Final call should write to the (new) sentinel service
      const writeCmd = mockExecSync.mock.calls[3]?.[0] ?? '';
      expect(writeCmd).toContain('Sentinel-credentials');
    });

    it('preserves subscriptionType and SKIPS the write when nothing changed', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const ccCredsNoSub = { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: 9999 };
      const ccBlob = JSON.stringify({ claudeAiOauth: ccCredsNoSub });
      // Existing entry is exactly the merged result (CC creds + preserved
      // fields) — the store write must be skipped: on Windows every write
      // costs two synchronous DPAPI/PowerShell spawns that block the daemon.
      const sentinelBlob = JSON.stringify({
        ...ccCredsNoSub,
        subscriptionType: 'max',
        rateLimitTier: 'premium',
      });
      mockExecSync
        .mockReturnValueOnce(ccBlob) // CC slot read
        .mockReturnValueOnce(sentinelBlob); // sentinel read (existing entry)

      const result = captureCurrentCredentials('account-uuid');
      expect(result?.subscriptionType).toBe('max');
      expect(result?.rateLimitTier).toBe('premium');
      expect(result?.accessToken).toBe('at-new');
      // Only 2 calls: CC read + sentinel read. No third (write) call.
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it('writes (with preserved fields) when the captured creds differ from the stored entry', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const ccCredsNoSub = { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: 9999 };
      const ccBlob = JSON.stringify({ claudeAiOauth: ccCredsNoSub });
      // Existing entry holds an OLD access token → merged creds differ → write.
      const sentinelBlob = JSON.stringify({
        accessToken: 'at-old',
        refreshToken: 'rt-old',
        expiresAt: 1111,
        subscriptionType: 'max',
        rateLimitTier: 'premium',
      });
      mockExecSync
        .mockReturnValueOnce(ccBlob) // CC slot read
        .mockReturnValueOnce(sentinelBlob) // sentinel read (existing entry)
        .mockReturnValueOnce(''); // sentinel write

      const result = captureCurrentCredentials('account-uuid');
      expect(result?.subscriptionType).toBe('max');
      expect(result?.accessToken).toBe('at-new');
      expect(mockExecSync).toHaveBeenCalledTimes(3);
      // Written blob carries the fresh token AND the preserved plan fields.
      const writeCmd = mockExecSync.mock.calls[2]?.[0] ?? '';
      expect(writeCmd).toContain('max');
      expect(writeCmd).toContain('at-new');
    });

    it('does not override subscriptionType already present in CC creds', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const ccCreds = { ...sampleCreds, subscriptionType: 'team', rateLimitTier: 'standard' };
      const ccBlob = JSON.stringify({ claudeAiOauth: ccCreds });
      // CC has both fields; the sentinel read still happens (it feeds the
      // skip-identical-write comparison) but must not override them.
      mockExecSync
        .mockReturnValueOnce(ccBlob) // CC read
        .mockReturnValueOnce('') // sentinel read (new service) miss
        .mockReturnValueOnce('') // sentinel read (legacy service) miss
        .mockReturnValueOnce(''); // sentinel write

      const result = captureCurrentCredentials('account-uuid');
      expect(result?.subscriptionType).toBe('team');
      // 4 calls: CC read + sentinel new read + sentinel legacy read + sentinel write
      expect(mockExecSync).toHaveBeenCalledTimes(4);
    });

    it('handles sentinel read failure gracefully during preservation', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const ccCredsNoSub = { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: 9999 };
      const ccBlob = JSON.stringify({ claudeAiOauth: ccCredsNoSub });
      mockExecSync
        .mockReturnValueOnce(ccBlob) // CC read
        .mockImplementationOnce(() => {
          throw new Error('no entry');
        }) // sentinel read fails
        .mockReturnValueOnce(''); // sentinel write

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

    it('returns null when the captured CC blob has no claudeAiOauth wrapper', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockReturnValueOnce('{}'); // CC slot with no oauth wrapper
      const result = captureCurrentCredentials('acct-x');
      expect(result).toBeNull();
    });

    it('returns null when execSync itself throws', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockExecSync.mockImplementation(() => {
        throw new Error('exec failed');
      });
      const result = captureCurrentCredentials('acct-x');
      expect(result).toBeNull();
    });

    it('returns null when the CC slot contents fail to parse as JSON', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // CC read returns non-JSON → JSON.parse in captureCurrentCredentials
      // throws → outer catch returns null.
      mockExecSync.mockReturnValueOnce('not-valid-json');
      const result = captureCurrentCredentials('acct-x');
      expect(result).toBeNull();
    });

    it('preserves rateLimitTier from existing sentinel entry when CC creds lack only rateLimitTier', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // CC creds have subscriptionType but NOT rateLimitTier — the
      // preservation conditional at line 86 fires only for the missing
      // rateLimitTier branch, not subscriptionType.
      const ccCredsPartial = {
        accessToken: 'at-new',
        refreshToken: 'rt-new',
        expiresAt: 9999,
        subscriptionType: 'max',
      };
      const ccBlob = JSON.stringify({ claudeAiOauth: ccCredsPartial });
      const sentinelBlob = JSON.stringify({
        accessToken: 'old',
        refreshToken: 'old',
        expiresAt: 0,
        subscriptionType: 'pro',
        rateLimitTier: 'premium',
      });
      mockExecSync
        .mockReturnValueOnce(ccBlob) // CC slot read
        .mockReturnValueOnce(sentinelBlob) // sentinel read — existing entry
        .mockReturnValueOnce(''); // sentinel write

      const result = captureCurrentCredentials('acct-partial');
      // subscriptionType stays as what CC returned (not overwritten).
      expect(result?.subscriptionType).toBe('max');
      // rateLimitTier preserved from the existing sentinel entry.
      expect(result?.rateLimitTier).toBe('premium');
    });
  });

  describe('readActiveCredentials — fallback error handling', () => {
    it('returns null when CC fallback itself throws during JSON parse', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // Sentinel miss, CC returns non-JSON so the inner try's parse throws,
      // hitting the `catch { /* ignore */ }` branch.
      mockExecSync
        .mockImplementationOnce(() => {
          throw new Error('sentinel miss');
        }) // sentinel read (new service) miss
        .mockImplementationOnce(() => {
          throw new Error('sentinel miss');
        }) // sentinel read (legacy service) miss
        .mockReturnValueOnce('not-valid-json'); // CC slot
      // Without activeId specified, fall-back is allowed and the catch kicks in.
      expect(readActiveCredentials('test@example.com')).toBeNull();
    });

    it('returns null when the CC slot JSON lacks a claudeAiOauth wrapper', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // Sentinel miss, CC returns parseable JSON but no oauth key — exercises
      // the `?? null` branch after JSON.parse succeeds.
      mockExecSync
        .mockImplementationOnce(() => {
          throw new Error('sentinel miss');
        }) // sentinel read (new service) miss
        .mockImplementationOnce(() => {
          throw new Error('sentinel miss');
        }) // sentinel read (legacy service) miss
        .mockReturnValueOnce(JSON.stringify({ something_else: 1 })); // CC slot
      expect(readActiveCredentials('test@example.com')).toBeNull();
    });
  });
});
