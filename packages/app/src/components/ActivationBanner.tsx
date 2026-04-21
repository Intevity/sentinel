import React, { useEffect, useState } from 'react';
import { Zap, AlertCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

type State = 'checking' | 'active' | 'inactive' | 'activating' | 'error';

/**
 * Shown until Sentinel is activated. "Activate" writes ANTHROPIC_BASE_URL and
 * the OTEL env vars into ~/.claude/settings.json so Claude Code routes its
 * API calls + telemetry through the Sentinel daemon on localhost:47284.
 *
 * Replaces the old `PluginSetupBanner` that ran `claude plugin install`;
 * Sentinel no longer ships a plugin. Uninstall (unpatch) is in the ⋯ menu.
 */
export default function ActivationBanner(): React.ReactElement | null {
  const [state, setState] = useState<State>('checking');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    invoke<boolean>('is_sentinel_activated')
      .then((active) => setState(active ? 'active' : 'inactive'))
      .catch(() => setState('inactive'));
  }, []);

  const handleActivate = async (): Promise<void> => {
    setState('activating');
    setError('');
    try {
      await invoke('activate_sentinel');
      setState('active');
    } catch (e) {
      setError(String(e));
      setState('error');
    }
  };

  if (state === 'checking' || state === 'active') return null;

  return (
    <div className="mx-4 mt-1 mb-1">
      <div className="rounded-2xl bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] ring-1 ring-ios-blue/20 p-3">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-ios-blue/10 flex items-center justify-center">
            {state === 'error' ? (
              <AlertCircle size={15} className="text-ios-red" strokeWidth={2} />
            ) : (
              <Zap size={15} className="text-ios-blue" strokeWidth={2} />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-black dark:text-white">
              Activate Sentinel
            </p>
            <p className="text-[11px] text-[#8E8E93] mt-0.5">
              Routes Claude Code through the Sentinel proxy for multi-account switching, usage
              tracking, and overage alerts. Restart Claude Code after activating.
            </p>
            {state === 'error' && (
              <p className="text-[11px] text-ios-red mt-1 font-mono break-all">{error}</p>
            )}
          </div>
          <button
            onClick={() => void handleActivate()}
            disabled={state === 'activating'}
            className="flex-shrink-0 btn-primary"
          >
            {state === 'activating' ? 'Activating…' : state === 'error' ? 'Retry' : 'Activate'}
          </button>
        </div>
      </div>
    </div>
  );
}
