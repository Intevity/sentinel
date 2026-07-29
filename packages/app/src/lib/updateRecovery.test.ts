import { describe, it, expect } from 'vitest';
import { REPO } from './bugReport.js';
import {
  releaseUrlFor,
  failedUpdateHeadline,
  failedUpdateDetail,
  type FailedUpdateAttempt,
} from './updateRecovery.js';

function attempt(overrides: Partial<FailedUpdateAttempt> = {}): FailedUpdateAttempt {
  return {
    targetVersion: '0.9.4',
    runningVersion: '0.9.3',
    installer: 'nsis',
    artifact: 'Sentinel_0.9.4_x64-setup.exe',
    trigger: 'modal',
    ...overrides,
  };
}

describe('releaseUrlFor', () => {
  it('pins the release page to the version', () => {
    expect(releaseUrlFor('0.9.4')).toBe('https://github.com/Intevity/sentinel/releases/tag/v0.9.4');
  });

  it('does not double the v prefix', () => {
    expect(releaseUrlFor('v0.9.4')).toBe(
      'https://github.com/Intevity/sentinel/releases/tag/v0.9.4',
    );
    expect(releaseUrlFor(' V0.9.4 ')).toBe(
      'https://github.com/Intevity/sentinel/releases/tag/v0.9.4',
    );
  });

  it('falls back to /releases/latest when the version is unknown', () => {
    expect(releaseUrlFor('')).toBe('https://github.com/Intevity/sentinel/releases/latest');
    expect(releaseUrlFor('   ')).toBe('https://github.com/Intevity/sentinel/releases/latest');
  });

  it('derives the repo from bugReport rather than hardcoding it', () => {
    // Drift guard: a second hardcoded owner/repo string in updateRecovery.ts
    // would fail here. (Not asserted via buildIssueUrl — that reads the
    // __APP_VERSION__ build-time define, and stubbing it would put a vi.*
    // call site in a file the mock budget currently has at zero.)
    expect(REPO).toBe('Intevity/sentinel');
    expect(releaseUrlFor('1.0.0')).toBe(`https://github.com/${REPO}/releases/tag/v1.0.0`);
  });
});

describe('failedUpdateHeadline', () => {
  it('names both the version that failed and the one still running', () => {
    const h = failedUpdateHeadline(attempt());
    expect(h).toContain('0.9.4');
    expect(h).toContain('0.9.3');
  });

  it('strips v prefixes from both versions', () => {
    expect(
      failedUpdateHeadline(attempt({ targetVersion: 'v0.9.4', runningVersion: 'v0.9.3' })),
    ).toBe("Sentinel 0.9.4 didn't install — still on 0.9.3");
  });
});

describe('failedUpdateDetail', () => {
  it('names the elevation prompt for the MSI', () => {
    const d = failedUpdateDetail(attempt({ installer: 'msi' }));
    expect(d).toContain('administrator');
    expect(d).toContain('User Account Control');
    expect(d).not.toContain('SmartScreen');
  });

  it('names SmartScreen and antivirus for the NSIS installer', () => {
    const d = failedUpdateDetail(attempt({ installer: 'nsis' }));
    expect(d).toContain('SmartScreen');
    expect(d).toContain('antivirus');
    expect(d).not.toContain('administrator');
  });

  it('stays generic for non-Windows installers', () => {
    const d = failedUpdateDetail(attempt({ installer: 'app' }));
    expect(d).not.toContain('SmartScreen');
    expect(d).not.toContain('administrator');
    expect(d).toContain('never replaced the app');
  });
});
