import React, { useState } from 'react';
import { Shield, ShieldCheck, ShieldAlert, ShieldX, X, Check, ArrowLeft, AlertTriangle, Loader2, Gauge } from 'lucide-react';
import { applyPreset, markSetupSkipped, PRESETS, type RiskProfile } from '../lib/securityPresets.js';
import { useScanBenchmark } from '../hooks/useScanBenchmark.js';
import { sendToSentinel } from '../lib/ipc.js';
import type { SecurityBenchmarkResult } from '@claude-sentinel/shared';

interface SecuritySetupWizardProps {
  /** Dismiss the wizard. Called after Apply succeeds or Skip/Close. */
  onClose: () => void;
  /** Callback ref forwarded from `useAutoResizeWindow().overlayRef` so the
   *  tray window grows up to its max height to fit wizard content instead
   *  of forcing an internal scroll. */
  measureRef?: ((el: HTMLElement | null) => void) | undefined;
  /** True only for the automatic first-install open. Re-runs from Settings
   *  pass false, which bypasses the "Skip security setup?" confirmation on
   *  the header X: the user already has a configured profile, so dismissing
   *  isn't a consequential decision. */
  isFirstRun?: boolean;
}

const PROFILE_ICONS: Record<RiskProfile, typeof Shield> = {
  low: Shield,
  medium: ShieldAlert,
  high: ShieldX,
};

const PROFILE_ICON_CLASS: Record<RiskProfile, string> = {
  low: 'text-ios-green',
  medium: 'text-ios-orange',
  high: 'text-ios-red',
};

type Step = 'select' | 'benchmark' | 'review';

export default function SecuritySetupWizard({ onClose, measureRef, isFirstRun = true }: SecuritySetupWizardProps): React.ReactElement {
  const [step, setStep] = useState<Step>('select');
  const [choice, setChoice] = useState<RiskProfile>('medium');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown when the user hits the ✕ in the header. The bottom-left "Skip
  // for now" button bypasses this prompt — that's the explicit escape
  // hatch for people who know what they're giving up.
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false);
  // Fresh bench result captured in this wizard session. Kept locally
  // (not read from Settings.lastScanBenchmark) so the "Use recommendation"
  // button only activates on numbers we just measured — avoids silently
  // reapplying an old result from a different machine.
  const [benchResult, setBenchResult] = useState<SecurityBenchmarkResult | null>(null);
  const scanBench = useScanBenchmark();

  const useRecommendation = async (): Promise<void> => {
    if (!benchResult) return;
    // Patch the threshold before we leave the bench step so applyPreset's
    // later settings write doesn't clobber it. applyPreset's presets
    // don't touch securityOversizedThresholdMb, so this write survives.
    try {
      await sendToSentinel({
        type: 'update_settings',
        settings: { securityOversizedThresholdMb: benchResult.recommendedMb },
      });
    } catch {
      /* non-fatal — user can retune from Settings later */
    }
    setStep('review');
  };

  const apply = async (): Promise<void> => {
    setApplying(true);
    setError(null);
    try {
      await applyPreset(choice);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setApplying(false);
    }
  };

  const skip = async (): Promise<void> => {
    setApplying(true);
    try {
      await markSetupSkipped();
    } catch {
      // Non-fatal — user asked to dismiss; swallow the error and close.
    } finally {
      onClose();
    }
  };

  const selected = PRESETS[choice];
  const SelectedIcon = PROFILE_ICONS[choice];
  const ruleCount = selected.rules.length;

  return (
    <div className="absolute inset-0 bg-black/40 z-40 flex items-center justify-center p-3">
      <div
        ref={measureRef}
        data-expand-max
        className="bg-white dark:bg-[#1E1E1E] rounded-2xl shadow-card max-w-[460px] w-full max-h-full overflow-y-auto"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5">
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} className="text-ios-blue" />
            <h2 className="text-[14px] font-semibold text-black dark:text-white">
              Security setup
            </h2>
          </div>
          <button
            onClick={() => {
              if (isFirstRun) {
                // First install: dismissal is consequential, so gate it
                // behind an explicit confirm that spells out what the user
                // is giving up.
                setSkipConfirmOpen(true);
              } else {
                // Re-run from Settings: securitySetupCompleted is already
                // true, so closing is just closing. No confirm, no IPC.
                onClose();
              }
            }}
            className="w-7 h-7 rounded-full hover:bg-[#8E8E93]/10 flex items-center justify-center"
            title="Close"
            aria-label="Close"
          >
            <X size={14} className="text-[#8E8E93]" />
          </button>
        </div>

        {skipConfirmOpen && (
          <SkipConfirm
            disabled={applying}
            onKeep={() => setSkipConfirmOpen(false)}
            onSkip={() => {
              setSkipConfirmOpen(false);
              void skip();
            }}
          />
        )}

        {step === 'select' && (
          <div className="px-4 py-3">
            <p className="text-[11px] text-[#8E8E93] mb-3 leading-snug">
              Pick a risk profile. Sentinel will configure the scanner, notifications, and
              tool-permission rules for you. You can fine-tune everything later in Settings.
            </p>

            <div className="space-y-2">
              {(['low', 'medium', 'high'] as const).map((profile) => {
                const preset = PRESETS[profile];
                const Icon = PROFILE_ICONS[profile];
                const iconClass = PROFILE_ICON_CLASS[profile];
                const isSelected = choice === profile;
                return (
                  <button
                    key={profile}
                    type="button"
                    onClick={() => setChoice(profile)}
                    className={`w-full text-left rounded-xl p-3 flex items-start gap-3 transition-colors border ${
                      isSelected
                        ? 'border-ios-blue bg-ios-blue/5'
                        : 'border-transparent bg-[#F2F2F7] dark:bg-[#2A2A2A] hover:border-[#8E8E93]/20'
                    }`}
                  >
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-white dark:bg-[#1E1E1E] flex items-center justify-center">
                      <Icon size={16} className={iconClass} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-[12px] font-semibold text-black dark:text-white">
                          {preset.label}
                        </p>
                        {profile === 'medium' && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-ios-blue/10 text-ios-blue uppercase tracking-wider">
                            Recommended
                          </span>
                        )}
                        {isSelected && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-ios-blue text-white">
                            SELECTED
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-[#8E8E93] mt-0.5 leading-snug">
                        {preset.description}
                      </p>
                      <ul className="mt-1.5 space-y-0.5">
                        {preset.highlights.map((h) => (
                          <li key={h} className="text-[10px] text-[#8E8E93] leading-snug flex items-start gap-1">
                            <Check size={10} strokeWidth={2.6} className="text-ios-blue flex-shrink-0 mt-[2px]" />
                            <span>{h}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-2 mt-4">
              <button
                onClick={() => void skip()}
                disabled={applying}
                className="text-[11px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors disabled:opacity-40"
              >
                Skip for now
              </button>
              <button
                onClick={() => setStep('benchmark')}
                disabled={applying}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all disabled:opacity-40"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 'benchmark' && (
          <div className="px-4 py-3">
            <div className="flex items-start gap-3 mb-3">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[#F2F2F7] dark:bg-[#2A2A2A] flex items-center justify-center">
                <Gauge size={18} className="text-ios-blue" />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-black dark:text-white">
                  Tune for this system
                </p>
                <p className="text-[11px] text-[#8E8E93] leading-snug">
                  Scan cost depends on your hardware. A quick benchmark will measure it
                  and recommend a threshold — bodies under the threshold scan
                  synchronously, larger ones are deferred off the hot path.
                </p>
              </div>
            </div>

            {!benchResult && !scanBench.running && !scanBench.error && (
              <div className="rounded-xl bg-[#F2F2F7] dark:bg-[#2A2A2A] p-3 text-center">
                <p className="text-[11px] text-[#8E8E93] leading-snug mb-2">
                  Takes a few seconds. We'll measure scan cost at 1 / 2 / 4 / 8 / 16 MB
                  and recommend the largest size that stays under 50 ms p99.
                </p>
                <button
                  onClick={() => {
                    void scanBench.run().then((r) => { if (r) setBenchResult(r); });
                  }}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all"
                >
                  Run benchmark
                </button>
              </div>
            )}

            {scanBench.running && (
              <div className="rounded-xl bg-[#F2F2F7] dark:bg-[#2A2A2A] p-4 flex items-center justify-center gap-2">
                <Loader2 size={14} className="animate-spin text-ios-blue" strokeWidth={2.5} />
                <span className="text-[11px] text-[#8E8E93]">Measuring scan cost…</span>
              </div>
            )}

            {scanBench.error && !scanBench.running && (
              <div className="rounded-lg bg-ios-red/10 px-3 py-2 text-[11px] text-ios-red mb-2">
                {scanBench.error} — you can skip tuning and tweak the threshold later in Settings.
              </div>
            )}

            {benchResult && !scanBench.running && (
              <div className="rounded-xl bg-[#F2F2F7] dark:bg-[#2A2A2A] p-3 space-y-2">
                <p className="text-[10px] font-semibold text-[#8E8E93] uppercase tracking-wider">
                  Scan cost on this system
                </p>
                <div className="grid grid-cols-5 gap-1 text-[11px]">
                  {benchResult.results.map((r) => (
                    <div key={r.sizeMb} className="text-center">
                      <div className={`font-semibold tabular-nums ${
                        r.sizeMb === benchResult.recommendedMb ? 'text-ios-blue' : 'text-black dark:text-white'
                      }`}>
                        {r.sizeMb} MB
                      </div>
                      <div className="text-[10px] text-[#8E8E93] tabular-nums">{r.p99Ms.toFixed(1)}ms</div>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-[#8E8E93] leading-snug">
                  p99 scan cost per body size.{' '}
                  <span className="font-semibold text-black dark:text-white">
                    Recommended: {benchResult.recommendedMb} MB
                  </span>{' '}
                  (largest size under 50 ms).
                </p>
                <button
                  onClick={() => {
                    void scanBench.run().then((r) => { if (r) setBenchResult(r); });
                  }}
                  className="text-[10px] font-medium text-[#8E8E93] hover:text-black dark:hover:text-white"
                >
                  Re-run
                </button>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 mt-4">
              <button
                onClick={() => setStep('select')}
                disabled={applying || scanBench.running}
                className="text-[11px] font-medium text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors disabled:opacity-40 inline-flex items-center gap-1"
              >
                <ArrowLeft size={11} strokeWidth={2.4} />
                Back
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setStep('review')}
                  disabled={applying || scanBench.running}
                  className="text-[11px] font-medium text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors disabled:opacity-40"
                >
                  Skip
                </button>
                {benchResult && (
                  <button
                    onClick={() => void useRecommendation()}
                    disabled={applying || scanBench.running}
                    className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all disabled:opacity-40"
                  >
                    Use {benchResult.recommendedMb} MB & continue
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {step === 'review' && (
          <div className="px-4 py-3">
            <div className="flex items-start gap-3 mb-3">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[#F2F2F7] dark:bg-[#2A2A2A] flex items-center justify-center">
                <SelectedIcon size={20} className={PROFILE_ICON_CLASS[choice]} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-black dark:text-white">
                  {selected.label} profile
                </p>
                <p className="text-[11px] text-[#8E8E93] leading-snug">
                  {selected.description}
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-[#F2F2F7] dark:bg-[#2A2A2A] p-3 space-y-2">
              <p className="text-[10px] font-semibold text-[#8E8E93] uppercase tracking-wider">
                Will apply
              </p>
              <dl className="space-y-1 text-[11px]">
                <Row label="Enforcement mode" value={labelForEnforcement(selected.settings.securityEnforcementMode)} />
                <Row label="Scanner categories" value={scannerLabel(selected.settings)} />
                <Row label="Notification floor" value={selected.settings.securityOsNotifyThreshold.toUpperCase()} />
                <Row
                  label="Hold blocked requests"
                  value={selected.settings.securityBlockHoldEnabled
                    ? `Up to ${selected.settings.securityApproveHoldSec}s for approval`
                    : 'No, block immediately'}
                />
                <Row
                  label="Tool permissions"
                  value={selected.settings.toolPermissionsEnabled
                    ? `On, default ${selected.settings.toolPermissionDefaultAction}`
                    : 'Off'}
                />
                {ruleCount > 0 && (
                  <Row
                    label="Rules installed"
                    value={`${ruleCount} ${ruleCount === 1 ? 'rule' : 'rules'}`}
                  />
                )}
              </dl>
            </div>

            <p className="text-[10px] text-[#8E8E93] mt-2 leading-snug">
              Existing rules are preserved. Presets add their rules on top — you can delete any of
              them later from Settings → Security → Tool permissions.
            </p>

            {error && (
              <div className="mt-2 rounded-lg bg-ios-red/10 px-3 py-2 text-[11px] text-ios-red">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 mt-4">
              <button
                onClick={() => setStep('benchmark')}
                disabled={applying}
                className="text-[11px] font-medium text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors disabled:opacity-40 inline-flex items-center gap-1"
              >
                <ArrowLeft size={11} strokeWidth={2.4} />
                Back
              </button>
              <button
                onClick={() => void apply()}
                disabled={applying}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all disabled:opacity-40"
              >
                {applying ? 'Applying…' : `Apply ${selected.label}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[#8E8E93] flex-shrink-0">{label}</dt>
      <dd className="text-black dark:text-white text-right font-medium">{value}</dd>
    </div>
  );
}

function labelForEnforcement(mode: 'observe' | 'block_high' | 'block_medium_high' | null): string {
  switch (mode) {
    case 'observe':
      return 'Observe only';
    case 'block_high':
      return 'Block on HIGH';
    case 'block_medium_high':
      return 'Block on MEDIUM + HIGH';
    case null:
    default:
      return 'Observe only';
  }
}

function scannerLabel(s: {
  securityScanSecrets: boolean;
  securityScanInjection: boolean;
  securityScanToolUse: boolean;
}): string {
  const parts: string[] = [];
  if (s.securityScanSecrets) parts.push('Secrets');
  if (s.securityScanInjection) parts.push('Injection');
  if (s.securityScanToolUse) parts.push('Risky tools');
  return parts.length ? parts.join(' + ') : 'None';
}

interface SkipConfirmProps {
  disabled: boolean;
  onKeep: () => void;
  onSkip: () => void;
}

/** Inline overlay that lays on top of the wizard card when the user hits
 *  the header ✕. Explains why skipping security setup is a real decision
 *  (not a throwaway dismiss) and gives them an explicit "Skip anyway"
 *  path that mirrors the bottom-left "Skip for now" behavior. */
function SkipConfirm({ disabled, onKeep, onSkip }: SkipConfirmProps): React.ReactElement {
  return (
    <div className="absolute inset-0 bg-black/50 rounded-2xl flex items-center justify-center p-4">
      <div className="bg-white dark:bg-[#1E1E1E] rounded-xl shadow-card max-w-[380px] w-full p-4 border border-black/5 dark:border-white/10">
        <div className="flex items-start gap-3 mb-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-ios-orange/10 flex items-center justify-center">
            <AlertTriangle size={16} className="text-ios-orange" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[13px] font-semibold text-black dark:text-white">
              Skip security setup?
            </h3>
            <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">
              Without a profile, Sentinel will still watch for obvious leaks — but the guardrails
              against risky tool calls and credential exfil stay off.
            </p>
          </div>
        </div>

        <ul className="space-y-1.5 mb-3 pl-1">
          <li className="text-[11px] text-[#8E8E93] leading-snug flex items-start gap-2">
            <span className="text-ios-orange mt-[1px]">•</span>
            <span>
              No enforcement mode means secrets in outbound prompts are logged but never blocked.
            </span>
          </li>
          <li className="text-[11px] text-[#8E8E93] leading-snug flex items-start gap-2">
            <span className="text-ios-orange mt-[1px]">•</span>
            <span>
              No tool-permission rules means <code className="font-mono text-[10px]">rm -rf</code>,{' '}
              <code className="font-mono text-[10px]">sudo</code>, and
              <code className="font-mono text-[10px]"> ~/.ssh</code> reads go through unchallenged.
            </span>
          </li>
          <li className="text-[11px] text-[#8E8E93] leading-snug flex items-start gap-2">
            <span className="text-ios-orange mt-[1px]">•</span>
            <span>
              The <b>Medium</b> profile takes 10 seconds and catches the obvious foot-guns without
              getting in your way.
            </span>
          </li>
        </ul>

        <p className="text-[10px] text-[#8E8E93] italic leading-snug mb-3">
          You can always run the wizard later from Settings → Security → Run setup wizard.
        </p>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onSkip}
            disabled={disabled}
            className="text-[11px] font-medium text-[#8E8E93] hover:text-black dark:hover:text-white px-3 py-1.5 rounded-lg hover:bg-[#8E8E93]/10 disabled:opacity-40"
          >
            Skip anyway
          </button>
          <button
            onClick={onKeep}
            disabled={disabled}
            className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all disabled:opacity-40"
          >
            Keep setting up
          </button>
        </div>
      </div>
    </div>
  );
}
