import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendToSentinel } = vi.hoisted(() => ({ sendToSentinel: vi.fn() }));

vi.mock('./ipc.js', () => ({
  sendToSentinel,
}));

import { applyPreset, markSetupSkipped, PRESETS } from './securityPresets.js';

beforeEach(() => {
  sendToSentinel.mockReset();
});

describe('PRESETS', () => {
  it('defines low/medium/high profiles with the expected enforcement modes', () => {
    expect(PRESETS.low.settings.securityEnforcementMode).toBe('observe');
    expect(PRESETS.medium.settings.securityEnforcementMode).toBe('block_high');
    expect(PRESETS.high.settings.securityEnforcementMode).toBe('block_medium_high');
  });

  it('low profile carries only the self-protection rules and keeps default-action allow', () => {
    // Sprint 2: Low gets the SHARED_CONFIG_PROTECTION_RULES so an
    // agent can't disable Sentinel even on the most permissive
    // preset. toolPermissionsEnabled flipped from false → true so
    // those rules can fire; toolPermissionDefaultAction stays allow,
    // so nothing else is blocked.
    expect(PRESETS.low.settings.toolPermissionsEnabled).toBe(true);
    expect(PRESETS.low.settings.toolPermissionDefaultAction).toBe('allow');
    expect(PRESETS.low.rules.length).toBeGreaterThan(0);
    const decisions = new Set(PRESETS.low.rules.map((r) => r.decision));
    // Low has ONLY denies (no asks, no allows) — they are the
    // self-protection invariant carried into every preset.
    expect(decisions).toEqual(new Set(['deny']));
  });

  it('every preset (low/medium/high) denies tool-based config writes', () => {
    const required = [
      'Write(~/.claude/settings.json)',
      'Edit(~/.claude/settings.json)',
      'MultiEdit(~/.claude/settings.json)',
      'Write(~/.claude/CLAUDE.md)',
      'Edit(~/.claude/CLAUDE.md)',
      'MultiEdit(~/.claude/CLAUDE.md)',
      'Write(~/.claude-sentinel/**)',
      'Edit(~/.claude-sentinel/**)',
      'MultiEdit(~/.claude-sentinel/**)',
    ];
    for (const profile of ['low', 'medium', 'high'] as const) {
      const byRaw = new Map<string, (typeof PRESETS)[typeof profile]['rules'][number]>(
        PRESETS[profile].rules.map((r) => [`${r.tool}(${r.pattern ?? ''})`, r]),
      );
      for (const raw of required) {
        const rule = byRaw.get(raw);
        expect(rule, `${profile} preset must include ${raw}`).toBeDefined();
        expect(rule!.decision).toBe('deny');
      }
    }
  });

  it('every preset highlights the new self-protection coverage', () => {
    for (const profile of ['low', 'medium', 'high'] as const) {
      const present = PRESETS[profile].highlights.some((h) =>
        h.toLowerCase().includes('claude code permissions'),
      );
      expect(present, `${profile} highlights should mention self-protection`).toBe(true);
    }
  });

  it('medium profile ships ask+deny rules with no allow rules', () => {
    const hasAllow = PRESETS.medium.rules.some((r) => r.decision === 'allow');
    expect(hasAllow).toBe(false);
    expect(PRESETS.medium.rules.length).toBeGreaterThan(5);
    expect(PRESETS.medium.settings.toolPermissionDefaultAction).toBe('allow');
    // Both decision tiers must be represented: ask for broad Bash wildcards,
    // deny for resource-specific protections.
    const decisions = new Set(PRESETS.medium.rules.map((r) => r.decision));
    expect(decisions.has('ask')).toBe(true);
    expect(decisions.has('deny')).toBe(true);
    // The obvious foot-guns are ask rules so users can approve legitimate
    // one-offs instead of having them silently blocked.
    const byRaw = new Map(
      PRESETS.medium.rules.map((r) => [`${r.tool}(${r.pattern ?? ''})`, r] as const),
    );
    expect(byRaw.get('Bash(rm -rf *)')?.decision).toBe('ask');
    expect(byRaw.get('Bash(sudo *)')?.decision).toBe('ask');
    expect(byRaw.get('Bash(chmod 777 *)')?.decision).toBe('ask');
    expect(byRaw.get('Bash(curl * | bash)')?.decision).toBe('ask');
    expect(byRaw.get('Bash(wget * | sh)')?.decision).toBe('ask');
    // Resource guards stay as deny.
    expect(byRaw.get('Write(~/.ssh/**)')?.decision).toBe('deny');
    expect(byRaw.get('Read(~/.aws/credentials)')?.decision).toBe('deny');
  });

  it('high profile is default-deny with an explicit allow list plus shared denies', () => {
    expect(PRESETS.high.settings.toolPermissionDefaultAction).toBe('deny');
    expect(PRESETS.high.settings.toolPermissionSkipInAutoMode).toBe(false);
    const decisions = PRESETS.high.rules.map((r) => r.decision);
    expect(decisions).toContain('allow');
    expect(decisions).toContain('deny');
    // High includes everything Medium has (shared deny list).
    for (const medRule of PRESETS.medium.rules) {
      const found = PRESETS.high.rules.some(
        (r) =>
          r.decision === medRule.decision &&
          r.tool === medRule.tool &&
          r.pattern === medRule.pattern,
      );
      expect(found).toBe(true);
    }
  });
});

describe('applyPreset', () => {
  it('writes settings with securitySetupCompleted=true then installs each rule', async () => {
    sendToSentinel.mockResolvedValue({ success: true, data: null });
    await applyPreset('medium');

    const calls = sendToSentinel.mock.calls;
    expect(calls[0]?.[0].type).toBe('update_settings');
    expect(calls[0]?.[0].settings.securitySetupCompleted).toBe(true);
    expect(calls[0]?.[0].settings.securityEnforcementMode).toBe('block_high');

    // All remaining calls must be upsert_permission_rule, one per rule.
    const upserts = calls.slice(1);
    expect(upserts).toHaveLength(PRESETS.medium.rules.length);
    for (const [msg] of upserts) {
      expect(msg.type).toBe('upsert_permission_rule');
      expect(msg.rule.raw).toMatch(/^[A-Za-z_*]/);
    }
  });

  it('serializes raw correctly for whole-tool rules vs pattern rules', async () => {
    sendToSentinel.mockResolvedValue({ success: true, data: null });
    await applyPreset('high');
    const calls = sendToSentinel.mock.calls.slice(1);
    const rawReadTool = calls.find(([m]) => m.rule.tool === 'Read' && m.rule.pattern === null);
    expect(rawReadTool?.[0].rule.raw).toBe('Read');
    const rawBashGit = calls.find(([m]) => m.rule.tool === 'Bash' && m.rule.pattern === 'git *');
    expect(rawBashGit?.[0].rule.raw).toBe('Bash(git *)');
  });

  it('throws if update_settings fails', async () => {
    sendToSentinel.mockResolvedValueOnce({ success: false, error: 'denied' });
    await expect(applyPreset('low')).rejects.toThrow('denied');
  });

  it('throws if a rule upsert fails, leaving earlier writes applied', async () => {
    sendToSentinel
      .mockResolvedValueOnce({ success: true, data: null }) // update_settings
      .mockResolvedValueOnce({ success: true, data: null }) // first rule
      .mockResolvedValueOnce({ success: false, error: 'parse error' });
    await expect(applyPreset('medium')).rejects.toThrow(/parse error/);
  });
});

describe('markSetupSkipped', () => {
  it('flips securitySetupCompleted to true without touching other settings', async () => {
    sendToSentinel.mockResolvedValue({ success: true, data: null });
    await markSetupSkipped();
    expect(sendToSentinel).toHaveBeenCalledWith({
      type: 'update_settings',
      settings: { securitySetupCompleted: true },
    });
  });

  it('throws when the IPC fails', async () => {
    sendToSentinel.mockResolvedValueOnce({ success: false, error: 'timeout' });
    await expect(markSetupSkipped()).rejects.toThrow('timeout');
  });
});
