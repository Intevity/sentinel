/**
 * Tracks whether Claude Code's API traffic is actually flowing through
 * Sentinel's reverse proxy — the ingestion path that feeds the Optimize tab.
 *
 * Why this exists: the Metrics tab and the Optimize tab are fed by two
 * independent paths. Metrics comes from Claude Code's OTEL export (the OTEL
 * receiver); Optimize comes from tool calls the proxy extracts out of
 * `/v1/messages` bodies. If `ANTHROPIC_BASE_URL` is overridden — by an OS
 * env var, or a project / enterprise settings file that outranks
 * `~/.claude/settings.json` — Claude Code's API calls bypass the proxy while
 * its OTEL telemetry still reaches the daemon. Metrics populate; Optimize
 * stays empty with no explanation.
 *
 * This tracker keeps two rolling-window counts so the daemon can detect that
 * exact divergence:
 *   - OTEL `api_request` events ingested (proof of real Claude Code activity)
 *   - real (non-probe) `/v1/messages` POSTs seen by the proxy
 *
 * When activity is visible via OTEL but no real proxy traffic arrives, the
 * proxy is being bypassed. Sentinel's own 5-minute background usage probes
 * are excluded from the proxy count (the proxy filters them by user-agent),
 * so they can never mask a bypass.
 *
 * The tracker is counters-only and does no I/O. `index.ts` composes the
 * `settingsBaseUrl` fields onto the snapshot from the drift inspector.
 */
import type { CaptureHealth } from '@sentinel/shared';
import { isSentinelEndpoint } from './claude-otel-config.js';

/** Counter-derived portion of `CaptureHealth` — everything except the
 *  `settingsBaseUrl*` fields, which require a settings-file read the tracker
 *  deliberately doesn't perform. */
export type CaptureHealthSnapshot = Pick<
  CaptureHealth,
  'state' | 'windowMs' | 'otelApiRequests' | 'realProxyRequests'
>;

export interface CaptureHealthOptions {
  /** Rolling window both counts are measured over. Default 10 minutes. */
  windowMs?: number;
  /** Minimum OTEL `api_request` count in the window before a zero proxy
   *  count is treated as a bypass. Guards against false alarms on a quiet
   *  or brand-new install. Default 3. */
  minOtelSignal?: number;
}

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MIN_OTEL_SIGNAL = 3;

export class CaptureHealthTracker {
  private readonly windowMs: number;
  private readonly minOtelSignal: number;
  private otel: number[] = [];
  private proxy: number[] = [];

  constructor(opts: CaptureHealthOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.minOtelSignal = opts.minOtelSignal ?? DEFAULT_MIN_OTEL_SIGNAL;
  }

  /** Record one Claude Code `api_request` OTEL log event. */
  recordOtelApiRequest(now: number = Date.now()): void {
    this.otel.push(now);
    this.prune(now);
  }

  /** Record one real (non-probe) `/v1/messages` POST handled by the proxy. */
  recordRealProxyRequest(now: number = Date.now()): void {
    this.proxy.push(now);
    this.prune(now);
  }

  /** Drop timestamps older than the window from both buffers. */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.otel.length > 0 && (this.otel[0] as number) < cutoff) this.otel.shift();
    while (this.proxy.length > 0 && (this.proxy[0] as number) < cutoff) this.proxy.shift();
  }

  /** Counts + classified state for the current window. `state` is
   *  `proxy-bypassed` when there is sufficient OTEL signal but zero real
   *  proxy traffic; otherwise `ok`. */
  snapshot(now: number = Date.now()): CaptureHealthSnapshot {
    this.prune(now);
    const otelApiRequests = this.otel.length;
    const realProxyRequests = this.proxy.length;
    const state =
      otelApiRequests >= this.minOtelSignal && realProxyRequests === 0 ? 'proxy-bypassed' : 'ok';
    return { state, windowMs: this.windowMs, otelApiRequests, realProxyRequests };
  }
}

/** Merge a counter snapshot with the `ANTHROPIC_BASE_URL` read from
 *  `~/.claude/settings.json` into the full `CaptureHealth` the UI consumes.
 *  Pure: the caller performs the settings-file read (see index.ts) and
 *  passes the observed base URL in. `settingsBaseUrlRoutesToSentinel`
 *  tells the UI whether the file itself is wrong (false) or whether the
 *  file is correct but something at higher precedence overrides it (true). */
export function composeCaptureHealth(
  snapshot: CaptureHealthSnapshot,
  settingsBaseUrl: string | null,
): CaptureHealth {
  return {
    ...snapshot,
    settingsBaseUrl,
    settingsBaseUrlRoutesToSentinel: isSentinelEndpoint(settingsBaseUrl),
  };
}
