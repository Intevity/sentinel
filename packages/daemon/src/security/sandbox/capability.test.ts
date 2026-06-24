import { describe, it, expect } from 'vitest';
import { computeCapability, type SandboxProbe } from './capability.js';

function probe(overrides: Partial<SandboxProbe> = {}): SandboxProbe {
  return {
    sandboxExec: false,
    ripgrep: false,
    bubblewrap: false,
    socat: false,
    seccomp: false,
    srtWin: false,
    ...overrides,
  };
}

describe('computeCapability', () => {
  describe('macOS', () => {
    it('is full when sandbox-exec is present', () => {
      const s = computeCapability('darwin', probe({ sandboxExec: true, ripgrep: true }));
      expect(s.capability).toBe('full');
      expect(s.reasons).toEqual([]);
      expect(s.dependencies).toEqual([
        { name: 'sandbox-exec', present: true },
        { name: 'ripgrep', present: true },
      ]);
    });

    it('is full but warns when ripgrep is missing', () => {
      const s = computeCapability('darwin', probe({ sandboxExec: true, ripgrep: false }));
      expect(s.capability).toBe('full');
      expect(s.reasons.join(' ')).toMatch(/ripgrep/);
    });

    it('is unavailable when sandbox-exec is missing', () => {
      const s = computeCapability('darwin', probe({ sandboxExec: false }));
      expect(s.capability).toBe('unavailable');
      expect(s.reasons.join(' ')).toMatch(/sandbox-exec/);
    });
  });

  describe('Linux', () => {
    it('is full when bubblewrap and socat are present', () => {
      const s = computeCapability('linux', probe({ bubblewrap: true, socat: true, seccomp: true }));
      expect(s.capability).toBe('full');
      expect(s.reasons).toEqual([]);
    });

    it('warns (but stays full) when seccomp is missing', () => {
      const s = computeCapability('linux', probe({ bubblewrap: true, socat: true, seccomp: false }));
      expect(s.capability).toBe('full');
      expect(s.reasons.join(' ')).toMatch(/seccomp/);
    });

    it('is unavailable and names both missing deps', () => {
      const s = computeCapability('linux', probe({ bubblewrap: false, socat: false }));
      expect(s.capability).toBe('unavailable');
      expect(s.reasons.join(' ')).toMatch(/bubblewrap and socat/);
    });

    it('is unavailable when only bubblewrap is missing', () => {
      const s = computeCapability('linux', probe({ bubblewrap: false, socat: true }));
      expect(s.capability).toBe('unavailable');
      expect(s.reasons.join(' ')).toMatch(/bubblewrap/);
      expect(s.reasons.join(' ')).not.toMatch(/and socat/);
    });

    it('is unavailable when only socat is missing', () => {
      const s = computeCapability('linux', probe({ bubblewrap: true, socat: false }));
      expect(s.capability).toBe('unavailable');
      expect(s.reasons.join(' ')).toMatch(/socat/);
      expect(s.reasons.join(' ')).not.toMatch(/bubblewrap and/);
    });
  });

  describe('Windows', () => {
    it('is network-only when the helper is present', () => {
      const s = computeCapability('win32', probe({ srtWin: true }));
      expect(s.capability).toBe('network-only');
      expect(s.reasons.join(' ')).toMatch(/network isolation only/);
    });

    it('is unavailable when the helper is missing', () => {
      const s = computeCapability('win32', probe({ srtWin: false }));
      expect(s.capability).toBe('unavailable');
      expect(s.reasons.join(' ')).toMatch(/srt-win/);
    });
  });

  it('is unavailable on an unsupported platform', () => {
    const s = computeCapability('freebsd', probe());
    expect(s.capability).toBe('unavailable');
    expect(s.dependencies).toEqual([]);
    expect(s.reasons.join(' ')).toMatch(/not supported/);
    expect(s.platform).toBe('freebsd');
  });
});
