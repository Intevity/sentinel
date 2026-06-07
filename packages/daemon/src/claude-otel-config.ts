/**
 * Single source of truth for the env vars Sentinel writes into
 * Claude Code's `~/.claude/settings.json` to wire OTEL metrics + logs
 * through the local receiver.
 *
 * The Rust side (`packages/app/src-tauri/src/settings_patch.rs`) has its
 * own inlined copy of these constants because activation runs before the
 * daemon is up. A Rust unit test asserts the two key lists agree; if you
 * change values here, mirror them there too.
 */

// Literal IPv4 loopback, NOT `localhost`. Claude Code's OTLP-HTTP exporter
// uses Node's raw `http.request`, which has no Happy-Eyeballs fallback: on
// Windows `localhost` frequently resolves to `::1` first, and the daemon binds
// IPv4-only (`127.0.0.1`, see index.ts), so an exporter aimed at `localhost`
// hits `[::1]:47284` → ECONNREFUSED and metrics silently never arrive. The
// proxy survives the same URL because the Anthropic SDK uses fetch/undici,
// which does try both families. Pinning the address removes the DNS step for
// both signals on every platform.
export const SENTINEL_BASE_URL = 'http://127.0.0.1:47284';

/** Eight managed env keys with the exact values Sentinel writes. Order
 *  is preserved so the on-disk file is stable across runs (helps with
 *  user diff-noise + git-tracked settings). */
export const SENTINEL_OTEL_ENV_VARS: Readonly<Record<string, string>> = Object.freeze({
  ANTHROPIC_BASE_URL: SENTINEL_BASE_URL,
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
  OTEL_METRIC_EXPORT_INTERVAL: '5000',
  OTEL_LOGS_EXPORT_INTERVAL: '2000',
});

/** Keys Sentinel owns. Anything outside this list in `env` belongs to the
 *  user (or another tool) and must be preserved on every write. */
export const MANAGED_KEYS: readonly string[] = Object.keys(SENTINEL_OTEL_ENV_VARS);

/** OTEL signal-specific endpoint overrides. Per the OTEL spec these win
 *  over the base `OTEL_EXPORTER_OTLP_ENDPOINT` when present, so a foreign
 *  tool can route metrics or logs away from Sentinel while leaving the
 *  base endpoint alone. Re-patch must strip them; drift inspection must
 *  detect them. */
export const OTEL_SIGNAL_ENDPOINT_KEYS: readonly string[] = [
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
];

/** Header-name CSV containing optional per-signal headers; Honeycomb-style
 *  installers may also touch this. Promote reads it to extract auth. */
export const OTEL_HEADERS_KEY = 'OTEL_EXPORTER_OTLP_HEADERS';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Mirrors the URL-acceptance rule in `settings.ts#coerce()` for
 *  `otelExporterEndpoint`: HTTPS for the public internet, HTTP only on
 *  loopback. Used by promote() to refuse foreign endpoints whose URLs
 *  would be silently dropped by the forwarder's settings coercion. */
export function isUrlSafeForForwarder(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(host));
  } catch {
    return false;
  }
}

/** True when `url` points at Sentinel's own local OTLP receiver — i.e. any
 *  loopback host form (localhost / 127.0.0.1 / ::1) on our port over http.
 *  Drift detection uses this instead of an exact `=== SENTINEL_BASE_URL`
 *  match so a settings file still carrying the older `http://localhost:47284`
 *  value is recognized as ours (not a foreign endpoint) after SENTINEL_BASE_URL
 *  moved to the literal IPv4 address. Re-activation then normalizes the
 *  on-disk value to 127.0.0.1. */
export function isSentinelEndpoint(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(u.hostname.toLowerCase()) &&
      u.port === new URL(SENTINEL_BASE_URL).port
    );
  } catch {
    return false;
  }
}
