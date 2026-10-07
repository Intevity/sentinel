import React from 'react';
import { Terminal, AlertTriangle } from 'lucide-react';
import { useSurfaceState } from '../hooks/useSurfaceState.js';
import { useOpencodeConfig } from '../hooks/useOpencodeConfig.js';
import { opencodeCardCopy } from '../lib/opencodeCopy.js';

/**
 * Per-surface status card for **opencode**, sibling to {@link DesktopSurfaceCard}.
 *
 * opencode reaches Anthropic one of two ways, and the copy names both because
 * a user who guesses wrong is quietly misled about whose quota they spend:
 * with an API key, Sentinel forwards the user's own key and only observes
 * (request log, security scanning, permission rules, cache TTL); with the
 * `opencode-claude-auth` plugin (Claude subscription sign-in), requests are
 * served from Sentinel's account pool like Claude Code's.
 *
 *  - not installed → hidden
 *  - routed through Sentinel (active) → hidden; Disable lives in Settings → General
 *  - plugin-override → warning, no action; a plugin rewrites the base URL at
 *    startup, so writing the config again would not change anything
 *  - unwritable → warning + the snippet to paste, naming the actual cause
 *    (comments we refuse to round-trip through JSON.stringify, or a file that
 *    does not parse)
 *  - foreign-base-url → Enable, saying the user's URL comes back on Disable
 *  - installed, not routed → Enable
 *
 * The config path is always shown: the daemon resolves it from its own
 * environment, which the GUI launches, so an `OPENCODE_CONFIG` exported only in
 * a shell rc file is not honored — showing the path makes that visible.
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

  const { title, body } = opencodeCardCopy(details);

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
            {details?.configPath && (
              <p className="text-[10px] text-muted mt-1 break-all">
                {configState === 'unwritable' ? 'Config file: ' : 'Writes to '}
                <span className="font-mono">{details.configPath}</span>
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
