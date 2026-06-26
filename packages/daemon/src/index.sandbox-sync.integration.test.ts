import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { ClaudeSyncStatus, SandboxStatus, Settings } from '@sentinel/shared';
import { startTestDaemon, type TestDaemon } from './index.test-helpers.js';

/**
 * End-to-end Leg A (sandbox settings-sync) tests: drive the real daemon over
 * IPC and assert against the real Claude Code settings file the engine writes.
 */

let ctx: TestDaemon | null = null;

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

function policy(overrides: Partial<Settings['isolationPolicy']> = {}): Settings['isolationPolicy'] {
  return {
    enabled: true,
    syncToClaudeCode: true,
    enforceCodeMode: false,
    network: { allowedDomains: ['example.com'], deniedDomains: [] },
    filesystem: { allowWrite: ['~/.kube'], denyWrite: [], denyRead: [], allowRead: [] },
    credentials: { files: [], envVars: [] },
    ...overrides,
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return pred();
}

function readSandboxBlock(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return parsed['sandbox'] as Record<string, unknown> | undefined;
}

describe('sandbox-sync (Leg A) daemon integration', () => {
  it('starts the engine at boot and pushes a sandbox block, preserving other keys', async () => {
    ctx = await startTestDaemon({
      settings: { isolationPolicy: policy() },
      claudeSettings: { model: 'opus' },
    });
    const sawPush = await waitFor(() => readSandboxBlock(ctx!.claudeSettingsPath) !== undefined);
    expect(sawPush).toBe(true);

    const file = JSON.parse(readFileSync(ctx.claudeSettingsPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(file['model']).toBe('opus'); // unrelated key preserved
    const sb = file['sandbox'] as Record<string, unknown>;
    expect(sb['enabled']).toBe(true);
    expect((sb['network'] as Record<string, unknown>)['allowedDomains']).toEqual(['example.com']);

    const status = await ctx.request<ClaudeSyncStatus>({ type: 'get_sandbox_status' });
    expect(status.success).toBe(true);
    expect(status.data?.active).toBe(true);
    expect(status.data?.lastPushedAt).not.toBeNull();
  });

  it('reports the sandbox capability (Leg B) for the host platform', async () => {
    ctx = await startTestDaemon({
      settings: { isolationPolicy: policy({ enforceCodeMode: false }) },
    });
    const cap = await ctx.request<SandboxStatus>({ type: 'get_sandbox_capability' });
    expect(cap.success).toBe(true);
    expect(cap.data?.platform).toBe(process.platform);
    expect(['full', 'network-only', 'unavailable']).toContain(cap.data?.capability);
    expect(Array.isArray(cap.data?.dependencies)).toBe(true);
  });

  it('leaves the engine inactive when syncToClaudeCode is off', async () => {
    ctx = await startTestDaemon({
      settings: { isolationPolicy: policy({ syncToClaudeCode: false }) },
    });
    const status = await ctx.request<ClaudeSyncStatus>({ type: 'get_sandbox_status' });
    expect(status.success).toBe(true);
    expect(status.data?.active).toBe(false);
    expect(readSandboxBlock(ctx.claudeSettingsPath)).toBeUndefined();
  });

  it('starts the engine when the policy is toggled on via update_settings', async () => {
    ctx = await startTestDaemon({
      settings: { isolationPolicy: policy({ syncToClaudeCode: false }) },
    });
    const updated = await ctx.request<Settings>({
      type: 'update_settings',
      settings: { isolationPolicy: policy({ syncToClaudeCode: true }) },
    });
    expect(updated.success).toBe(true);

    const sawActive = await waitFor(() => readSandboxBlock(ctx!.claudeSettingsPath) !== undefined);
    expect(sawActive).toBe(true);
    const status = await ctx.request<ClaudeSyncStatus>({ type: 'get_sandbox_status' });
    expect(status.data?.active).toBe(true);
  });

  it('stops the engine when the policy is toggled off via update_settings', async () => {
    ctx = await startTestDaemon({ settings: { isolationPolicy: policy() } });
    let active = false;
    for (let i = 0; i < 100 && !active; i++) {
      const s = await ctx.request<ClaudeSyncStatus>({ type: 'get_sandbox_status' });
      if (s.data?.active) active = true;
      else await new Promise((r) => setTimeout(r, 30));
    }
    expect(active).toBe(true);
    await ctx.request<Settings>({
      type: 'update_settings',
      settings: { isolationPolicy: policy({ syncToClaudeCode: false }) },
    });
    const status = await ctx.request<ClaudeSyncStatus>({ type: 'get_sandbox_status' });
    expect(status.data?.active).toBe(false);
  });

  it('pushes again when policy content changes while sync stays on', async () => {
    ctx = await startTestDaemon({ settings: { isolationPolicy: policy() } });
    await waitFor(() => readSandboxBlock(ctx!.claudeSettingsPath) !== undefined);

    await ctx.request<Settings>({
      type: 'update_settings',
      settings: {
        isolationPolicy: policy({
          network: { allowedDomains: ['changed.com'], deniedDomains: [] },
        }),
      },
    });
    const sawChange = await waitFor(() => {
      const sb = readSandboxBlock(ctx!.claudeSettingsPath);
      const domains = (sb?.['network'] as Record<string, unknown> | undefined)?.['allowedDomains'];
      return Array.isArray(domains) && domains.includes('changed.com');
    });
    expect(sawChange).toBe(true);
  });

  it('pulls an externally-edited sandbox block back into the policy on demand', async () => {
    ctx = await startTestDaemon({ settings: { isolationPolicy: policy() } });
    await waitFor(() => readSandboxBlock(ctx!.claudeSettingsPath) !== undefined);

    // Simulate a hand-edit to the Claude Code settings file adding a domain.
    writeFileSync(
      ctx.claudeSettingsPath,
      JSON.stringify({ sandbox: { network: { allowedDomains: ['handedit.com'] } } }),
    );
    const pull = await ctx.request({ type: 'sandbox_sync_pull', mode: 'merge' });
    expect(pull.success).toBe(true);

    let imported = false;
    for (let i = 0; i < 100 && !imported; i++) {
      const s = await ctx.request<Settings>({ type: 'get_settings' });
      if (s.data?.isolationPolicy.network.allowedDomains.includes('handedit.com')) imported = true;
      else await new Promise((r) => setTimeout(r, 30));
    }
    expect(imported).toBe(true);
  });
});
