import { useCallback, useEffect, useState } from 'react';
import type { OtelForwarderStatus, OtelExporterTestResult } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseOtelExporterResult {
  status: OtelForwarderStatus | null;
  loading: boolean;
  /** Persist a new ingestion-key value to the OS keychain. Empty string
   *  clears the slot. The `otel_forwarder_status` broadcast updates
   *  status afterwards, so callers usually don't need to do anything
   *  with the resolved promise. */
  setSecret: (value: string) => Promise<void>;
  /** Delete the stored secret. */
  clearSecret: () => Promise<void>;
  /** User-initiated probe: round-trip a synthetic OTLP body to the
   *  configured endpoint to verify creds. */
  test: () => Promise<OtelExporterTestResult | null>;
}

/**
 * Subscribe to the OTEL forwarder's live status. Seeds from a one-shot
 * `get_otel_exporter_status` call so the UI doesn't flash "unknown"
 * before the first broadcast lands, then stays current via the
 * `otel_forwarder_status` broadcast the daemon fires on every secret
 * write/clear and at counter milestones.
 */
export function useOtelExporter(): UseOtelExporterResult {
  const [status, setStatus] = useState<OtelForwarderStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const setSecret = useCallback(async (value: string) => {
    await sendToSentinel({ type: 'set_otel_exporter_secret', value }).catch(() => undefined);
  }, []);

  const clearSecret = useCallback(async () => {
    await sendToSentinel({ type: 'clear_otel_exporter_secret' }).catch(() => undefined);
  }, []);

  const test = useCallback(async () => {
    const res = await sendToSentinel<OtelExporterTestResult>({
      type: 'test_otel_exporter',
    }).catch(() => null);
    if (!res || !res.success) return null;
    return res.data ?? null;
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const res = await sendToSentinel<OtelForwarderStatus>({
          type: 'get_otel_exporter_status',
        });
        if (res.success) setStatus(res.data ?? null);
      } catch {
        /* non-fatal */
      } finally {
        setLoading(false);
      }
    })();
    onDaemonMessage((msg) => {
      if (msg.type === 'otel_forwarder_status') {
        setStatus(msg.status);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);

  return { status, loading, setSecret, clearSecret, test };
}
