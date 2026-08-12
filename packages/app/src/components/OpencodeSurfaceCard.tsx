import React from 'react';
import { Terminal, AlertTriangle } from 'lucide-react';
import { useSurfaceState } from '../hooks/useSurfaceState.js';
import { useOpencodeConfig } from '../hooks/useOpencodeConfig.js';

/**
 * Per-surface status card for **opencode**, sibling to {@link DesktopSurfaceCard}.
 *
 * Unlike the Claude surfaces this one is bring-your-own-key: opencode
 * authenticates with the user's own Anthropic API key and Sentinel observes the
 * traffic (request log, security scanning, permission rules, cache TTL) without
 * substituting a pooled subscription token. The copy says so, because a user who
 * expects account pooling here would otherwise be quietly misled.
 *
 *  - not installed → hidden
 *  - routed through Sentinel (active) → hidden; Disable lives in Settings → General
 *  - plugin-override → warning, no action; a plugin rewrites the base URL at
 *    startup, so writing the config again would not change anything
 *  - unwritable → warning + the snippet to paste (commented config we refuse to
 *    round-trip through JSON.stringify)
 *  - installed, not routed → Enable
 */
export default function OpencodeSurfaceCard(): React.ReactElement | null {
  const { state } = useSurfaceState();
  const { details, acting, actionError, activate } = useOpencodeConfig();

  if (!state?.opencode.installed) return null;

  const configState = details?.state ?? 'inactive';
  // Nothing actionable once routed — mirrors DesktopSurfaceCard's active gate.
  if (configState === 'active') return null;

  const blocked = configState === 'plugin-override' || configState === 'unwritable';
  const foreign = configState === 'foreign-base-url';
  const warn = blocked || foreign;

  // Static class strings (Tailwind JIT can't see interpolated names).
  const wrap = warn
    ? 'rounded-2xl bg-ios-orange/[0.08] dark:bg-ios-orange/[0.12] ring-1 ring-ios-orange/20 p-3'
    : 'rounded-2xl bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] ring-1 ring-ios-blue/20 p-3';
  const iconWrap = warn
    ? 'flex-shrink-0 w-8 h-8 rounded-full bg-ios-orange/10 flex items-center justify-center'
    : 'flex-shrink-0 w-8 h-8 rounded-full bg-ios-blue/10 flex items-center justify-center';

  const title =
    configState === 'plugin-override'
      ? 'opencode is bypassing Sentinel'
      : configState === 'unwritable'
        ? 'opencode needs a manual config edit'
        : foreign
          ? 'opencode routed elsewhere'
          : 'Route opencode through Sentinel';

  const body =
    configState === 'plugin-override'
      ? `A configured plugin (${details?.overridingPlugins.join(', ')}) rewrites opencode's Anthropic base URL when it starts, so it reaches Anthropic without passing through Sentinel. Remove the plugin from your opencode config to route it here.`
      : configState === 'unwritable'
        ? 'Your opencode config contains comments, which Sentinel will not rewrite — saving it would delete them. Add this to it by hand instead:'
        : foreign
          ? `opencode's Anthropic provider points at ${details?.baseUrl}. Enabling replaces that with the Sentinel proxy.`
          : 'Routes opencode through the Sentinel proxy for request logging, security scanning, and permission rules. Uses your own Anthropic API key — Sentinel does not supply pooled subscription accounts to opencode. Restart opencode after enabling.';

  return (
    <div className="mx-4 mt-1 mb-1">
      <div className={wrap}>
        <div className="flex items-start gap-3">
          <div className={iconWrap}>
            {warn ? (
              <AlertTriangle size={15} className="text-ios-orange" strokeWidth={2} />
            ) : (
              <Terminal size={15} className="text-ios-blue" strokeWidth={2} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-black dark:text-white">{title}</p>
            <p className="text-[11px] text-muted mt-0.5">{body}</p>
            {configState === 'unwritable' && details?.manualSnippet && (
              <pre className="text-[10px] text-muted mt-1 p-2 rounded-lg bg-black/5 dark:bg-white/5 overflow-x-auto">
                {details.manualSnippet}
              </pre>
            )}
            {details?.configPath && configState !== 'inactive' && (
              <p className="text-[10px] text-muted mt-1 font-mono break-all">
                {details.configPath}
              </p>
            )}
            {actionError && (
              <p className="text-[11px] text-ios-red mt-1 font-mono break-all">{actionError}</p>
            )}
          </div>
          {!blocked && (
            <button
              onClick={() => void activate()}
              disabled={acting}
              className="flex-shrink-0 btn-primary"
            >
              {acting ? 'Enabling…' : 'Enable'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
