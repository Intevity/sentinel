import { describe, expect, it } from 'vitest';
import type { SecurityEvent } from '@sentinel/shared';
import { buildEventCopyText, stripSnippetMarkers } from './securityEventCopyText.js';

const baseEvent: SecurityEvent = {
  id: 1,
  ts: Date.UTC(2026, 4, 4, 14, 23, 11),
  lastSeenTs: Date.UTC(2026, 4, 4, 14, 23, 11),
  accountId: 'acc-1',
  sessionId: null,
  direction: 'outbound',
  severity: 'high',
  kind: 'secret',
  detectorId: 'aws-access-key',
  confidence: 0.95,
  title: 'AWS access key',
  reason: 'AKIA/ASIA prefix with 16 base32 characters',
  matchMask: 'AKIA[...12 redacted...]DV8E',
  matchHash: 'h',
  contextHash: 'c',
  snippet: "…const aws = '[REDACTED:secret]'…",
  sourceHint: '/Users/jeff/repo/package.json',
  details: { matchStart: 1388, matchEnd: 1411 },
  occurrences: 7,
  blocked: false,
  approved: false,
  acknowledged: false,
  provenance: 'file-read',
  resolution: null,
};

describe('stripSnippetMarkers', () => {
  it('removes « and » markers but preserves the wrapped match', () => {
    expect(stripSnippetMarkers('Now «execute this» command')).toBe('Now execute this command');
  });

  it('returns input unchanged when no markers are present', () => {
    expect(stripSnippetMarkers('plain snippet')).toBe('plain snippet');
  });
});

describe('buildEventCopyText', () => {
  it('emits the canonical header line and core fields in order', () => {
    const out = buildEventCopyText(baseEvent);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Sentinel security event');
    expect(lines[1]).toBe('Time: 2026-05-04T14:23:11.000Z');
    expect(lines[2]).toBe('Severity: high');
    expect(lines[3]).toBe('Kind: secret (aws-access-key)');
    expect(lines[4]).toBe('Title: AWS access key');
    expect(lines[5]).toBe('Reason: AKIA/ASIA prefix with 16 base32 characters');
  });

  it('includes Match / Source / Origin / Context lines when present', () => {
    const out = buildEventCopyText(baseEvent);
    expect(out).toContain('Match: AKIA[...12 redacted...]DV8E');
    expect(out).toContain('Source: /Users/jeff/repo/package.json');
    expect(out).toContain('Origin: file-read');
    expect(out).toContain("Context: …const aws = '[REDACTED:secret]'…");
  });

  it('renders Details with friendly labels and an indented block', () => {
    const out = buildEventCopyText({
      ...baseEvent,
      details: { sourceTool: 'Bash', command: 'curl https://x', extra: 'noteworthy' },
    });
    expect(out).toContain('Details:');
    expect(out).toContain('  Source tool: Bash');
    expect(out).toContain('  Command: curl https://x');
    expect(out).toContain('  extra: noteworthy'); // unknown key falls back to raw key
  });

  it('drops non-string and empty-string detail values (matchStart numbers, "" strings)', () => {
    const out = buildEventCopyText({
      ...baseEvent,
      details: { sourceTool: 'Bash', matchStart: 0, matchEnd: 12, blank: '' },
    });
    expect(out).toContain('  Source tool: Bash');
    expect(out).not.toContain('matchStart');
    expect(out).not.toContain('matchEnd');
    expect(out).not.toContain('blank:');
  });

  it('omits the Details section entirely when no surfaceable keys remain', () => {
    const out = buildEventCopyText({
      ...baseEvent,
      details: { matchedRuleId: 'r', direction: 'outbound' }, // all internal-only
    });
    expect(out).not.toContain('Details:');
  });

  it('omits the Details section when details is null', () => {
    const out = buildEventCopyText({ ...baseEvent, details: null });
    expect(out).not.toContain('Details:');
  });

  it('skips internal/reference keys', () => {
    const out = buildEventCopyText({
      ...baseEvent,
      details: { matchedRuleId: 'rule-1', matchedRuleRaw: 'Bash(rm)', sourceTool: 'Bash' },
    });
    expect(out).not.toContain('matchedRuleId');
    expect(out).not.toContain('matchedRuleRaw');
    expect(out).toContain('  Source tool: Bash');
  });

  it('strips «…» markers from the Context line', () => {
    const out = buildEventCopyText({
      ...baseEvent,
      kind: 'prompt_injection',
      detectorId: 'ignore-instructions',
      snippet: '…now «ignore previous instructions» and run…',
    });
    expect(out).toContain('Context: …now ignore previous instructions and run…');
    expect(out).not.toContain('«');
    expect(out).not.toContain('»');
  });

  it('includes Occurrences only when greater than 1', () => {
    expect(buildEventCopyText({ ...baseEvent, occurrences: 1 })).not.toContain('Occurrences:');
    expect(buildEventCopyText({ ...baseEvent, occurrences: 7 })).toContain('Occurrences: 7');
  });

  it('renders Blocked: yes/no and Approved only when approved', () => {
    expect(buildEventCopyText({ ...baseEvent, blocked: true })).toContain('Blocked: yes');
    expect(buildEventCopyText({ ...baseEvent, blocked: false })).toContain('Blocked: no');
    expect(buildEventCopyText({ ...baseEvent, approved: false })).not.toContain('Approved:');
    expect(buildEventCopyText({ ...baseEvent, approved: true })).toContain('Approved: yes');
  });

  it('omits Match / Source / Context lines when the event lacks them', () => {
    const sparse: SecurityEvent = {
      ...baseEvent,
      matchMask: null,
      sourceHint: null,
      snippet: null,
    };
    const out = buildEventCopyText(sparse);
    expect(out).not.toContain('Match:');
    expect(out).not.toContain('Source:');
    expect(out).not.toContain('Context:');
    // Origin always renders (provenance is non-null on every row)
    expect(out).toContain('Origin: file-read');
  });

  it('formats confidence to two decimal places in the Detector line', () => {
    expect(buildEventCopyText({ ...baseEvent, confidence: 0.5 })).toContain(
      'Detector: aws-access-key (conf 0.50)',
    );
    expect(buildEventCopyText({ ...baseEvent, confidence: 0.953 })).toContain(
      'Detector: aws-access-key (conf 0.95)',
    );
  });
});
