/**
 * Desktop surface IPC handlers against a running daemon: get_surface_state,
 * activate_desktop, get_claude_desktop_drift_state, reapply_desktop_config,
 * deactivate_desktop. Real daemon + real Unix-socket IPC + a temp configLibrary
 * (via SENTINEL_TEST_CLAUDE_DESKTOP_DIR). No mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startTestDaemon, type TestDaemon } from './index.test-helpers.js';
import { SENTINEL_BASE_URL } from './claude-otel-config.js';
import type {
  SurfaceState,
  ClaudeDesktopDriftDetails,
  Settings,
} from '@sentinel/shared';

describe('desktop surface IPC', () => {
  let ctx: TestDaemon;

  beforeEach(async () => {
    ctx = await startTestDaemon();
  });
  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('get_surface_state reports both surfaces (desktop starts uninstalled/inactive)', async () => {
    const r = await ctx.request<SurfaceState>({ type: 'get_surface_state' });
    expect(r.success).toBe(true);
    expect(r.data?.cli).toBeDefined();
    expect(r.data?.desktop).toEqual({ installed: false, activated: false, healthy: false });
  });

  it('activate_desktop writes the gateway config, persists the id, and broadcasts', async () => {
    const r = await ctx.request<ClaudeDesktopDriftDetails>({ type: 'activate_desktop' });
    expect(r.success).toBe(true);
    expect(r.data?.state).toBe('active');
    expect(r.data?.appliedBaseUrl).toBe(SENTINEL_BASE_URL);

    // Broadcast the new drift state to the UI.
    await ctx.waitForBroadcast((m) => m.type === 'claude_desktop_drift_state');

    // The owned config id is persisted so later update/remove targets it.
    const settings = await ctx.request<Settings>({ type: 'get_settings' });
    expect(settings.data?.claudeDesktopConfigId).toBeTruthy();

    // Surface state now shows desktop installed (dir created) + activated.
    const surface = await ctx.request<SurfaceState>({ type: 'get_surface_state' });
    expect(surface.data?.desktop.installed).toBe(true);
    expect(surface.data?.desktop.activated).toBe(true);
  });

  it('get_claude_desktop_drift_state reflects the applied config', async () => {
    await ctx.request({ type: 'activate_desktop' });
    const r = await ctx.request<ClaudeDesktopDriftDetails>({
      type: 'get_claude_desktop_drift_state',
    });
    expect(r.success).toBe(true);
    expect(r.data?.state).toBe('active');
  });

  it('reapply_desktop_config restores the active state idempotently', async () => {
    const first = await ctx.request<ClaudeDesktopDriftDetails>({ type: 'activate_desktop' });
    const firstSettings = await ctx.request<Settings>({ type: 'get_settings' });
    const reapply = await ctx.request<ClaudeDesktopDriftDetails>({
      type: 'reapply_desktop_config',
    });
    expect(reapply.success).toBe(true);
    expect(reapply.data?.state).toBe('active');
    // Same owned id (no duplicate config minted).
    const afterSettings = await ctx.request<Settings>({ type: 'get_settings' });
    expect(afterSettings.data?.claudeDesktopConfigId).toBe(
      firstSettings.data?.claudeDesktopConfigId,
    );
    expect(first.data?.appliedId).toBe(reapply.data?.appliedId);
  });

  it('starts the desktop drift watcher at boot when already active', async () => {
    const seeded = await startTestDaemon({ seedDesktopActive: true });
    try {
      // Boot-time inspect reports the seeded active config...
      const drift = await seeded.request<ClaudeDesktopDriftDetails>({
        type: 'get_claude_desktop_drift_state',
      });
      expect(drift.data?.state).toBe('active');
      // ...and the surface detector reports desktop installed + activated.
      const surface = await seeded.request<SurfaceState>({ type: 'get_surface_state' });
      expect(surface.data?.desktop.installed).toBe(true);
      expect(surface.data?.desktop.activated).toBe(true);
    } finally {
      await seeded.cleanup();
    }
  });

  it('deactivate_desktop removes our config and clears the persisted id', async () => {
    await ctx.request({ type: 'activate_desktop' });
    const r = await ctx.request<ClaudeDesktopDriftDetails>({ type: 'deactivate_desktop' });
    expect(r.success).toBe(true);
    expect(r.data?.state).toBe('inactive'); // only our entry existed → applied cleared

    const settings = await ctx.request<Settings>({ type: 'get_settings' });
    expect(settings.data?.claudeDesktopConfigId).toBeNull();

    const surface = await ctx.request<SurfaceState>({ type: 'get_surface_state' });
    expect(surface.data?.desktop.activated).toBe(false);
  });
});
