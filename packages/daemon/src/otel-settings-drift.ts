/**
 * Inspector for Claude Code's `~/.claude/settings.json` OTEL wiring.
 *
 * Returns an `OtelDriftDetails` snapshot the Metrics-tab banner uses to
 * decide whether to surface "metrics aren't flowing into Sentinel" and
 * which recovery actions to offer.
 *
 * Stateless and pure-where-possible: the only I/O is the settings.json
 * read in `inspectClaudeOtelConfig()`. The classifier, header parser, and
 * auth-header picker are pure so they can be unit-tested table-style.
 */
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import type { OtelDriftDetails, OtelDriftState } from '@claude-sentinel/shared';
import {
  SENTINEL_BASE_URL,
  OTEL_HEADERS_KEY,
  isUrlSafeForForwarder,
} from './claude-otel-config.js';

const METRICS_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT';
const LOGS_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT';

/** Subset of env keys this module cares about. Any other `env.*` entry
 *  is ignored — Sentinel doesn't manage it and the inspector doesn't
 *  classify on it. */
export interface ObservedOtelEnv {
  endpoint: string | null;
  metricsEndpoint: string | null;
  logsEndpoint: string | null;
  telemetryEnabled: boolean;
  protocol: string | null;
  headers: string | null;
}

/** Read `~/.claude/settings.json`, extract the OTEL env block, classify,
 *  and build the promote-preview when applicable. Missing file → state
 *  `'no-settings-file'`. Malformed JSON → treated as missing-file (we
 *  can't trust any content; the user can re-patch to restore). */
export async function inspectClaudeOtelConfig(
  settingsPath: string,
  sentinelExporterEndpoint: string | null = null,
): Promise<OtelDriftDetails> {
  const env = await readEnvBlock(settingsPath);
  if (env === null) {
    return {
      state: 'no-settings-file',
      actual: emptyObserved(),
      canPromote: false,
      promotePreview: null,
    };
  }
  const observed = readObserved(env);
  const state = classifyDrift(observed);
  const canPromote = state === 'foreign-endpoint' && isUrlSafeForForwarder(observed.endpoint ?? '');
  const promotePreview = canPromote
    ? buildPromotePreview(observed, sentinelExporterEndpoint)
    : null;
  return {
    state,
    actual: observed,
    canPromote,
    promotePreview,
  };
}

/** Pure: classify a parsed env block into one of the four drift states.
 *  Exposed for unit testing. Ordering matters — telemetry-disabled
 *  trumps foreign-endpoint because a user with `CLAUDE_CODE_ENABLE_TELEMETRY=0`
 *  can't fix anything by promoting (no metrics would flow). */
export function classifyDrift(env: ObservedOtelEnv): Exclude<OtelDriftState, 'no-settings-file'> {
  if (!env.telemetryEnabled) return 'telemetry-disabled';
  // Signal-specific endpoints OVERRIDE the base. If either is non-null
  // and points elsewhere, Claude Code's OTEL SDK routes that signal
  // away from Sentinel even when the base endpoint still points at us.
  if (env.metricsEndpoint && env.metricsEndpoint !== SENTINEL_BASE_URL) return 'foreign-endpoint';
  if (env.logsEndpoint && env.logsEndpoint !== SENTINEL_BASE_URL) return 'foreign-endpoint';
  if (env.endpoint === null) return 'foreign-endpoint';
  if (env.endpoint !== SENTINEL_BASE_URL) return 'foreign-endpoint';
  return 'ok';
}

/** Pure: parse an `OTEL_EXPORTER_OTLP_HEADERS`-style CSV into name/value
 *  pairs. Per the OTEL spec, the format is comma-separated `name=value`,
 *  values URL-percent-decoded, whitespace allowed around delimiters.
 *  Malformed entries are silently skipped — drift inspection should not
 *  hard-fail on a typo in the user's headers config. */
export function parseOtlpHeaders(raw: string | null | undefined): Array<{
  name: string;
  value: string;
}> {
  if (!raw || typeof raw !== 'string') return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    if (name === '') continue;
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      value = rawValue;
    }
    out.push({ name, value });
  }
  return out;
}

// Common auth-header name patterns across OTEL ingestion vendors:
//   - authorization                (RFC 7235)
//   - x-api-key / dd-api-key       (AWS, Datadog, …)
//   - signoz-ingestion-key         (SigNoz)
//   - x-honeycomb-team             (Honeycomb uses "team" as the auth slot)
//   - x-app-secret                 (generic)
// Pattern is conservative: anything ending in `-key`, `-token`, `-secret`,
// or `-team` is treated as a credential. Non-credential OTEL headers
// like `x-trace-id` and `x-request-id` are deliberately not matched.
const AUTH_HEADER_RE = /^(authorization|.*[-_](?:key|token|secret|team)|.*-ingestion-key)$/i;

/** Pure: heuristic pick of the auth header from a parsed list. Returns
 *  null when zero or multiple match; in those cases the UI surfaces the
 *  full list and the user picks via `chosenHeaderName`. */
export function pickAuthHeader(
  headers: Array<{ name: string; value: string }>,
): { name: string; value: string } | null {
  const matches = headers.filter((h) => AUTH_HEADER_RE.test(h.name));
  if (matches.length === 1) return matches[0] ?? null;
  return null;
}

/** Mask a secret value as `head…tail` (first 4 + ellipsis + last 4). For
 *  values shorter than 9 chars, just returns an ellipsis to avoid
 *  leaking nearly the whole secret. Used in the promote confirmation
 *  modal so users can sanity-check the captured value without exposure. */
export function maskSecret(value: string): string {
  if (value.length < 9) return '…';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function emptyObserved(): ObservedOtelEnv {
  return {
    endpoint: null,
    metricsEndpoint: null,
    logsEndpoint: null,
    telemetryEnabled: false,
    protocol: null,
    headers: null,
  };
}

function readObserved(env: Record<string, unknown>): ObservedOtelEnv {
  const str = (k: string): string | null => {
    const v = env[k];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  const tele = env['CLAUDE_CODE_ENABLE_TELEMETRY'];
  const telemetryEnabled = tele === '1' || tele === 'true' || tele === 1 || tele === true;
  return {
    endpoint: str('OTEL_EXPORTER_OTLP_ENDPOINT'),
    metricsEndpoint: str(METRICS_ENDPOINT_KEY),
    logsEndpoint: str(LOGS_ENDPOINT_KEY),
    telemetryEnabled,
    protocol: str('OTEL_EXPORTER_OTLP_PROTOCOL'),
    headers: str(OTEL_HEADERS_KEY),
  };
}

async function readEnvBlock(settingsPath: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fs.readFile(settingsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const env = (parsed as Record<string, unknown>)['env'];
  if (!env || typeof env !== 'object') return {};
  return env as Record<string, unknown>;
}

/** Build the masked preview surfaced to the UI in the promote
 *  confirmation modal. Exported so tests can target the masking logic
 *  directly without staging an entire foreign-config file. */
export function buildPromotePreview(
  observed: ObservedOtelEnv,
  sentinelExporterEndpoint: string | null,
): OtelDriftDetails['promotePreview'] {
  const endpoint = observed.metricsEndpoint ?? observed.logsEndpoint ?? observed.endpoint ?? '';
  const headers = parseOtlpHeaders(observed.headers);
  const auth = pickAuthHeader(headers);
  return {
    endpoint,
    headerName: auth?.name ?? null,
    headerValueMasked: auth ? maskSecret(auth.value) : null,
    replacesExisting:
      sentinelExporterEndpoint && sentinelExporterEndpoint !== endpoint
        ? sentinelExporterEndpoint
        : null,
  };
}

/** Canonical hash of just the eight managed env keys + the two signal-
 *  specific overrides. Used by the watcher for echo-suppression: after
 *  a successful re-patch we store the hash and skip subsequent watcher
 *  ticks whose hash matches.
 *
 *  Operates on raw env-block values rather than `ObservedOtelEnv` so
 *  watcher comparisons reflect the actual file state, including keys
 *  Sentinel doesn't read. */
export function canonHashManagedEnv(env: Record<string, unknown>): string {
  const ALL_KEYS = [
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_ENABLE_TELEMETRY',
    'OTEL_METRICS_EXPORTER',
    'OTEL_LOGS_EXPORTER',
    'OTEL_EXPORTER_OTLP_PROTOCOL',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_METRIC_EXPORT_INTERVAL',
    'OTEL_LOGS_EXPORT_INTERVAL',
    METRICS_ENDPOINT_KEY,
    LOGS_ENDPOINT_KEY,
  ].sort();
  const picked: Record<string, unknown> = {};
  for (const k of ALL_KEYS) picked[k] = env[k] ?? null;
  return createHash('sha256').update(JSON.stringify(picked)).digest('hex');
}
