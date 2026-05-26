import React, { useState } from 'react';
import type { OtelDriftDetails } from '@claude-sentinel/shared';
import { useOtelDrift } from '../hooks/useOtelDrift.js';

/**
 * Surfaces the OTEL settings-drift state above the Metrics dashboard.
 *
 * Renders nothing when wiring is intact (state='ok'). On drift, offers
 * one or two one-click recoveries:
 *  - Re-patch: restore Sentinel's eight env vars, taking back the
 *    metrics stream from whatever tool overwrote settings.json.
 *  - Promote: copy the foreign endpoint + auth header into Sentinel's
 *    external OTEL forwarder, then re-patch back to Sentinel — so both
 *    Sentinel and the original downstream tool keep receiving metrics.
 *
 * The Promote action goes through a confirmation modal first so the
 * user can review what's being moved (especially when an existing
 * Sentinel forwarding destination would be overwritten).
 */
export default function OtelDriftBanner(): React.ReactElement | null {
  const { details, loading, acting, actionError, repatch, promote } = useOtelDrift();
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [successNote, setSuccessNote] = useState<string | null>(null);

  if (loading || !details) return null;
  if (details.state === 'ok') return null;

  const onRepatch = async (): Promise<void> => {
    setSuccessNote(null);
    const ok = await repatch();
    if (ok) {
      setSuccessNote(
        'Settings restored. Claude Code sessions already running keep their old config; new claude invocations pick up the patched values immediately.',
      );
    }
  };

  const onPromoteConfirm = async (): Promise<void> => {
    setSuccessNote(null);
    setShowPromoteModal(false);
    const ok = await promote();
    if (ok) {
      setSuccessNote(
        'Forwarding configured. Metrics will now reach both Sentinel and your original endpoint on the next Claude Code session.',
      );
    }
  };

  const bannerHeader =
    details.state === 'foreign-endpoint'
      ? "Metrics aren't flowing into Sentinel"
      : 'Claude Code telemetry is off';

  return (
    <>
      <div className="rounded-2xl bg-ios-orange/[0.08] dark:bg-ios-orange/[0.12] border border-ios-orange/20 px-4 py-3 mb-2">
        <p className="text-[12px] font-semibold text-ios-orange">{bannerHeader}</p>
        <p className="text-[11px] text-muted mt-1 leading-relaxed">
          <DriftExplanation details={details} />
        </p>

        {actionError && <p className="mt-2 text-[11px] text-ios-red">{actionError}</p>}

        {successNote && !actionError && (
          <p className="mt-2 text-[11px] text-ios-green">{successNote}</p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void onRepatch();
            }}
            disabled={acting}
            className="px-3 py-1.5 rounded-full text-[11px] font-semibold bg-ios-blue text-white disabled:opacity-50 active:scale-95 transition-transform"
          >
            {details.state === 'foreign-endpoint'
              ? 'Send metrics to Sentinel only'
              : 'Re-enable Sentinel metrics'}
          </button>
          {details.state === 'foreign-endpoint' && details.canPromote && (
            <button
              type="button"
              onClick={() => {
                setShowPromoteModal(true);
              }}
              disabled={acting}
              className="px-3 py-1.5 rounded-full text-[11px] font-semibold border border-ios-blue text-ios-blue disabled:opacity-50 active:scale-95 transition-transform"
            >
              Keep both: Sentinel and {hostOf(details.promotePreview?.endpoint ?? '')}
            </button>
          )}
        </div>
      </div>

      {showPromoteModal && details.promotePreview && (
        <PromoteConfirmModal
          preview={details.promotePreview}
          onCancel={() => setShowPromoteModal(false)}
          onConfirm={() => {
            void onPromoteConfirm();
          }}
          acting={acting}
        />
      )}
    </>
  );
}

function DriftExplanation({ details }: { details: OtelDriftDetails }): React.ReactElement {
  if (details.state === 'foreign-endpoint') {
    const host = hostOf(
      details.actual.metricsEndpoint ??
        details.actual.logsEndpoint ??
        details.actual.endpoint ??
        '',
    );
    return (
      <>
        Claude Code is sending OTEL metrics to <span className="font-semibold">{host}</span> instead
        of Sentinel. Another tool may have overwritten{' '}
        <code className="text-[10px]">~/.claude/settings.json</code>.
      </>
    );
  }
  if (details.state === 'telemetry-disabled') {
    return (
      <>
        <code className="text-[10px]">CLAUDE_CODE_ENABLE_TELEMETRY</code> is missing or set to 0 in{' '}
        <code className="text-[10px]">~/.claude/settings.json</code>; no OTEL data is being emitted.
      </>
    );
  }
  return (
    <>
      <code className="text-[10px]">~/.claude/settings.json</code> is absent. Re-patching will
      create it with Sentinel&apos;s OTEL configuration.
    </>
  );
}

function PromoteConfirmModal({
  preview,
  onCancel,
  onConfirm,
  acting,
}: {
  preview: NonNullable<OtelDriftDetails['promotePreview']>;
  onCancel: () => void;
  onConfirm: () => void;
  acting: boolean;
}): React.ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[400px] max-w-[92vw] rounded-2xl bg-white dark:bg-[#1C1C1E] shadow-card-lg p-5">
        <p className="text-[14px] font-semibold text-black dark:text-white mb-2">
          Forward metrics to both destinations?
        </p>
        <p className="text-[12px] text-muted leading-relaxed">
          Sentinel will receive OTEL events at <code>localhost:47284</code> and tee them to your
          existing endpoint, so the other tool keeps working.
        </p>

        <div className="mt-3 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] p-3 space-y-1.5">
          <Row label="Endpoint" value={preview.endpoint} />
          {preview.headerName ? (
            <>
              <Row label="Auth header" value={preview.headerName} />
              <Row label="Auth value" value={preview.headerValueMasked ?? '…'} mono />
            </>
          ) : (
            <p className="text-[11px] text-ios-orange">
              No auth header detected. You may need to paste your ingestion key into Settings →
              External OTEL forwarding after promoting.
            </p>
          )}
        </div>

        {preview.replacesExisting && (
          <p className="mt-3 text-[11px] text-ios-orange">
            Replaces existing forwarding to:{' '}
            <span className="font-semibold">{preview.replacesExisting}</span>
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={acting}
            className="px-3 py-1.5 rounded-full text-[12px] font-medium text-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={acting}
            className="px-3 py-1.5 rounded-full text-[12px] font-semibold bg-ios-blue text-white disabled:opacity-50"
          >
            Promote
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span
        className={`text-[11px] text-black dark:text-white truncate text-right ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
