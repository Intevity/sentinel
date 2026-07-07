import React from 'react';
import { Monitor, AlertTriangle } from 'lucide-react';
import { useSurfaceState } from '../hooks/useSurfaceState.js';
import { useClaudeDesktopDrift } from '../hooks/useClaudeDesktopDrift.js';

/**
 * Per-surface status card for the Claude **Desktop** app, sibling to
 * {@link ActivationBanner} (which owns the terminal CLI). Renders only when the
 * desktop app is detected. Routing goes through the daemon (it writes the
 * `Claude-3p/configLibrary` gateway config), not Rust — the desktop app has no
 * before-daemon first-run path.
 *
 *  - not installed → hidden
 *  - installed, not routed → Enable
 *  - routed to another gateway (drift) → Re-apply (recovery)
 *  - routed through Sentinel → confirmation + Disable
 */
export default function DesktopSurfaceCard(): React.ReactElement | null {
  const { state } = useSurfaceState();
  const { details, acting, actionError, activate, deactivate, reapply } = useClaudeDesktopDrift();

  if (!state?.desktop.installed) return null;

  const driftState = details?.state ?? 'inactive';
  const foreign = driftState === 'foreign-gateway';
  const active = driftState === 'active';

  // Static class strings (Tailwind JIT can't see interpolated names).
  const wrap = foreign
    ? 'rounded-2xl bg-ios-orange/[0.08] dark:bg-ios-orange/[0.12] ring-1 ring-ios-orange/20 p-3'
    : 'rounded-2xl bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] ring-1 ring-ios-blue/20 p-3';
  const iconWrap = foreign
    ? 'flex-shrink-0 w-8 h-8 rounded-full bg-ios-orange/10 flex items-center justify-center'
    : 'flex-shrink-0 w-8 h-8 rounded-full bg-ios-blue/10 flex items-center justify-center';

  return (
    <div className="mx-4 mt-1 mb-1">
      <div className={wrap}>
        <div className="flex items-start gap-3">
          <div className={iconWrap}>
            {foreign ? (
              <AlertTriangle size={15} className="text-ios-orange" strokeWidth={2} />
            ) : (
              <Monitor size={15} className="text-ios-blue" strokeWidth={2} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-black dark:text-white">
              {foreign
                ? 'Claude Desktop routed elsewhere'
                : active
                  ? 'Claude Desktop routed through Sentinel'
                  : 'Route Claude Desktop through Sentinel'}
            </p>
            <p className="text-[11px] text-muted mt-0.5">
              {foreign
                ? 'The desktop app points at another inference gateway. Re-apply to route it through Sentinel.'
                : active
                  ? 'Chat and Code inference from the desktop app flows through the Sentinel proxy. Restart Claude Desktop if you just enabled it.'
                  : 'Routes the Claude Desktop app (Chat + Code) through the Sentinel proxy for pooled accounts, usage tracking, and alerts. Restart Claude Desktop after enabling.'}
            </p>
            {actionError && (
              <p className="text-[11px] text-ios-red mt-1 font-mono break-all">{actionError}</p>
            )}
          </div>
          {foreign ? (
            <button
              onClick={() => void reapply()}
              disabled={acting}
              className="flex-shrink-0 btn-primary"
            >
              {acting ? 'Re-applying…' : 'Re-apply'}
            </button>
          ) : active ? (
            <button
              onClick={() => void deactivate()}
              disabled={acting}
              className="flex-shrink-0 btn-ghost"
            >
              {acting ? 'Disabling…' : 'Disable'}
            </button>
          ) : (
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
