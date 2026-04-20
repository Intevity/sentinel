import React, { useState } from 'react';
import { Shield, ShieldAlert, ShieldX, X } from 'lucide-react';
import type { SecurityEnforcementMode } from '@claude-sentinel/shared';
import { sendToSentinel } from '../lib/ipc.js';

interface SecurityEnforcementModalProps {
  /** Current mode, null when the user has never chosen one. The modal
   *  defaults the radio to `observe` when null. */
  initial: SecurityEnforcementMode | null;
  /** Dismiss the modal. Called on success or on "Not now". */
  onClose: () => void;
}

const OPTIONS: Array<{
  mode: SecurityEnforcementMode;
  title: string;
  description: string;
  Icon: typeof Shield;
  iconClass: string;
}> = [
  {
    mode: 'observe',
    title: 'Observe only',
    description:
      'Record findings and alert you. Never blocks or modifies requests. Recommended for most users.',
    Icon: Shield,
    iconClass: 'text-ios-green',
  },
  {
    mode: 'block_high',
    title: 'Block on HIGH severity',
    description:
      'Stop outbound requests when a confirmed secret is detected. Claude Code sees a "permission denied" error.',
    Icon: ShieldAlert,
    iconClass: 'text-ios-orange',
  },
  {
    mode: 'block_medium_high',
    title: 'Block on MEDIUM and HIGH',
    description:
      'Stricter. Also blocks on medium-confidence risky content. Higher chance of false positives.',
    Icon: ShieldX,
    iconClass: 'text-ios-red',
  },
];

export default function SecurityEnforcementModal({
  initial,
  onClose,
}: SecurityEnforcementModalProps): React.ReactElement {
  const [choice, setChoice] = useState<SecurityEnforcementMode>(initial ?? 'observe');
  const [saving, setSaving] = useState(false);

  const save = async (mode: SecurityEnforcementMode): Promise<void> => {
    setSaving(true);
    try {
      await sendToSentinel({
        type: 'update_settings',
        settings: { securityEnforcementMode: mode },
      });
    } finally {
      setSaving(false);
      onClose();
    }
  };

  const disable = async (): Promise<void> => {
    setSaving(true);
    try {
      await sendToSentinel({
        type: 'update_settings',
        settings: { securityScanEnabled: false, securityEnforcementMode: 'observe' },
      });
    } finally {
      setSaving(false);
      onClose();
    }
  };

  return (
    <div className="absolute inset-0 bg-black/40 z-40 flex items-center justify-center p-3">
      <div className="bg-white dark:bg-[#1E1E1E] rounded-2xl shadow-card max-w-[420px] w-full max-h-full overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5">
          <h2 className="text-[14px] font-semibold text-black dark:text-white">
            Choose security posture
          </h2>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-full hover:bg-[#8E8E93]/10 flex items-center justify-center"
            title="Close"
          >
            <X size={14} className="text-[#8E8E93]" />
          </button>
        </div>

        <div className="px-4 py-3">
          <p className="text-[11px] text-[#8E8E93] mb-3 leading-snug">
            Sentinel scans outbound requests and model responses for secrets, risky tool calls,
            and prompt-injection signals. Pick how you want findings handled.
          </p>

          <div className="space-y-2">
            {OPTIONS.map((opt) => {
              const selected = choice === opt.mode;
              return (
                <button
                  key={opt.mode}
                  type="button"
                  onClick={() => setChoice(opt.mode)}
                  className={`w-full text-left rounded-xl p-3 flex items-start gap-3 transition-colors border ${
                    selected
                      ? 'border-ios-blue bg-ios-blue/5'
                      : 'border-transparent bg-[#F2F2F7] dark:bg-[#2A2A2A] hover:border-[#8E8E93]/20'
                  }`}
                >
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-white dark:bg-[#1E1E1E] flex items-center justify-center">
                    <opt.Icon size={16} className={opt.iconClass} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[12px] font-semibold text-black dark:text-white">
                        {opt.title}
                      </p>
                      {selected && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-ios-blue text-white">
                          SELECTED
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#8E8E93] mt-0.5 leading-snug">
                      {opt.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2 mt-4">
            <button
              onClick={() => void disable()}
              disabled={saving}
              className="text-[11px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors disabled:opacity-40"
            >
              Turn off scanning
            </button>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                disabled={saving}
                className="text-[11px] font-medium px-3 py-1.5 rounded-lg text-[#8E8E93] hover:bg-[#8E8E93]/10 disabled:opacity-40"
              >
                Not now
              </button>
              <button
                onClick={() => void save(choice)}
                disabled={saving}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
