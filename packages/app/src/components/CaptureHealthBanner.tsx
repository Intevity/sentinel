import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useCaptureHealth } from '../hooks/useCaptureHealth.js';

const SENTINEL_PROXY_URL = 'http://127.0.0.1:47284';

/**
 * Explains why the Optimize tab has no data when Claude Code's API traffic
 * is bypassing Sentinel's proxy.
 *
 * Optimize is fed exclusively by tool calls the proxy extracts from
 * `/v1/messages`; the Metrics tab is fed by Claude Code's independent OTEL
 * export. When `ANTHROPIC_BASE_URL` is overridden, API calls skip the proxy
 * while OTEL telemetry still flows: Metrics populate, Optimize stays empty.
 * Rather than show silent zeros, this banner names the cause and points at
 * the fix; the daemon distinguishes "settings.json is wrong" from
 * "settings.json is right but something at higher precedence overrides it".
 *
 * Renders nothing unless the daemon reports `state === 'proxy-bypassed'`.
 */
export default function CaptureHealthBanner(): React.ReactElement | null {
  const { health, loading } = useCaptureHealth();

  if (loading || !health) return null;
  if (health.state !== 'proxy-bypassed') return null;

  // The settings file is correct but something outranks it (an OS env var or
  // a project / enterprise settings file) versus the file itself being wrong.
  const overridden = health.settingsBaseUrlRoutesToSentinel;

  return (
    <div className="glass-card flex items-start gap-3 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-semibold">Claude Code is not routing through Sentinel's proxy</p>
        <p className="text-foreground/70">
          Sentinel is receiving telemetry from Claude Code ({health.otelApiRequests} recent
          requests) but none of that traffic is reaching the proxy, so the Optimize tab has nothing
          to measure. The Metrics tab still works because it uses a separate telemetry path.
        </p>
        {overridden ? (
          <p className="text-foreground/70">
            Your Claude Code <code>settings.json</code> correctly points{' '}
            <code>ANTHROPIC_BASE_URL</code> at Sentinel, so something at higher precedence is
            overriding it: most often an <code>ANTHROPIC_BASE_URL</code> set in your system or user
            environment variables. Clear that override (or set it to{' '}
            <code>{SENTINEL_PROXY_URL}</code>
            ), then restart your terminal and Claude Code.
          </p>
        ) : (
          <p className="text-foreground/70">
            Claude Code&apos;s <code>ANTHROPIC_BASE_URL</code> is{' '}
            {health.settingsBaseUrl ? (
              <>
                pointing elsewhere (<code>{health.settingsBaseUrl}</code>)
              </>
            ) : (
              'not set'
            )}
            . Set it to <code>{SENTINEL_PROXY_URL}</code> in <code>~/.claude/settings.json</code>,
            or re-run Sentinel&apos;s setup, then restart Claude Code.
          </p>
        )}
      </div>
    </div>
  );
}
