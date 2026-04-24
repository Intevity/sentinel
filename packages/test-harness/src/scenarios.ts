/**
 * Named rate-limit / overage presets used by tests to drive the fake
 * Anthropic server into predictable states without hand-authoring headers.
 *
 * Header names must match the regex in
 * packages/daemon/src/rate-limit-store.ts:55 exactly — the real API and
 * this fake agree on these strings. If Anthropic ships a new window name
 * (e.g. a 24h bucket), add a preset here and a matching case in the regex.
 */

import { randomUUID } from 'node:crypto';

export type ScenarioName =
  | 'healthy-account'
  | '5h-warning'
  | '5h-blocked'
  | 'overage-in-use'
  | 'overage-entered-fresh'
  | 'overage-disabled'
  | 'overage-exited'
  | 'overage-null-reset'
  | 'sonnet-saturation'
  | 'sonnet-saturated-blocked'
  | 'rate-limited-5h'
  | 'weekly-paused-7d'
  | 'upstream-500'
  | 'upstream-unauth-401'
  | 'gzipped-json'
  | 'refresh-token-expired';

export interface ScenarioHeaderSet {
  [header: string]: string;
}

/** Unix seconds one hour from now — a fresh reset window. */
function resetInHour(): string {
  return String(Math.floor(Date.now() / 1000) + 3600);
}

/** Unix seconds seven days from now. */
function resetInWeek(): string {
  return String(Math.floor(Date.now() / 1000) + 7 * 86400);
}

export interface Scenario {
  /** Headers injected on every /v1/messages response. */
  messagesHeaders: ScenarioHeaderSet;
  /** Override status code for /v1/messages. Default 200. */
  messagesStatus?: number;
  /** Override status code for /v1/oauth/token. Default 200. */
  tokenStatus?: number;
  /** Short description for test assertions / logging. */
  label: string;
}

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  'healthy-account': {
    label: 'fresh 5h window, no overage',
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.10',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.15',
      'anthropic-ratelimit-unified-7d-reset': resetInWeek(),
    },
  },
  '5h-warning': {
    label: '5h window over 90%, warning status',
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
      'anthropic-ratelimit-unified-5h-utilization': '0.92',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.40',
      'anthropic-ratelimit-unified-7d-reset': resetInWeek(),
    },
  },
  '5h-blocked': {
    label: '5h window exhausted, blocked',
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-utilization': '1.00',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.60',
      'anthropic-ratelimit-unified-7d-reset': resetInWeek(),
    },
  },
  'overage-in-use': {
    label: '5h exhausted, drawing from overage budget',
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-utilization': '1.00',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-utilization': '0.30',
      'anthropic-ratelimit-unified-overage-reset': resetInHour(),
      'anthropic-ratelimit-unified-overage-in-use': 'true',
    },
  },
  'sonnet-saturation': {
    label: '7d Sonnet window near exhaustion',
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.45',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'anthropic-ratelimit-unified-7d_sonnet-status': 'allowed_warning',
      'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.95',
      'anthropic-ratelimit-unified-7d_sonnet-reset': resetInWeek(),
    },
  },
  'overage-entered-fresh': {
    label: '5h blocked, overage available but not yet drawing',
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-utilization': '1.00',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-utilization': '0.00',
      'anthropic-ratelimit-unified-overage-reset': resetInHour(),
      'anthropic-ratelimit-unified-overage-in-use': 'false',
    },
  },
  'overage-disabled': {
    label: 'overage pool disabled by user or admin',
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-utilization': '1.00',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'anthropic-ratelimit-unified-overage-status': 'disabled',
    },
  },
  'overage-exited': {
    label: '5h resets, overage no longer in use',
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.05',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-utilization': '0.30',
      'anthropic-ratelimit-unified-overage-reset': resetInHour(),
      'anthropic-ratelimit-unified-overage-in-use': 'false',
    },
  },
  'overage-null-reset': {
    label: 'overage allowed but no reset timestamp reported',
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-utilization': '1.00',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-utilization': '0.10',
      'anthropic-ratelimit-unified-overage-in-use': 'true',
    },
  },
  'sonnet-saturated-blocked': {
    label: '7d Sonnet window exhausted (blocked)',
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.20',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'anthropic-ratelimit-unified-7d_sonnet-status': 'blocked',
      'anthropic-ratelimit-unified-7d_sonnet-utilization': '1.00',
      'anthropic-ratelimit-unified-7d_sonnet-reset': resetInWeek(),
    },
  },
  'rate-limited-5h': {
    label: '5h window exhausted — upstream returns 429',
    messagesStatus: 429,
    messagesHeaders: {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-utilization': '1.00',
      'anthropic-ratelimit-unified-5h-reset': resetInHour(),
      'retry-after': '3600',
    },
  },
  'weekly-paused-7d': {
    label: '7d window exhausted — upstream returns 429 with weekly retry-after',
    messagesStatus: 429,
    messagesHeaders: {
      'anthropic-ratelimit-unified-7d-status': 'blocked',
      'anthropic-ratelimit-unified-7d-utilization': '1.00',
      'anthropic-ratelimit-unified-7d-reset': resetInWeek(),
      'retry-after': String(7 * 86400),
    },
  },
  'upstream-500': {
    label: 'generic upstream server error',
    messagesStatus: 500,
    messagesHeaders: {},
  },
  'upstream-unauth-401': {
    label: 'Anthropic rejects a registered bearer (revoked server-side)',
    messagesStatus: 401,
    messagesHeaders: {},
  },
  'gzipped-json': {
    label: 'JSON response with content-encoding: gzip (skip-tap path)',
    messagesHeaders: {
      'content-encoding': 'gzip',
    },
  },
  'refresh-token-expired': {
    label: 'token endpoint returns 400 (refresh token revoked)',
    messagesHeaders: {},
    tokenStatus: 400,
  },
};

/** Convenience: headers for the default /v1/messages response of a named scenario. */
export function scenarioHeaders(name: ScenarioName): ScenarioHeaderSet {
  return { ...SCENARIOS[name].messagesHeaders, 'request-id': randomUUID() };
}
