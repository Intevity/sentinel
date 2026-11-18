/**
 * Claude Code auto mode's server-side classifier review, as seen from the proxy.
 *
 * In auto mode Claude Code asks the API to review each proposed tool call. The
 * request carries a top-level `safeguards` body field paired with a
 * `dangerous-tool-use-<date>` value in `anthropic-beta`, and the streamed
 * response answers in `message_delta.delta.safeguard_results`, keyed by the
 * response's own tool_use ids. Behind a gateway (any `ANTHROPIC_BASE_URL` that
 * isn't api.anthropic.com, which includes Sentinel), a response that completes
 * without those results makes Claude Code stop asking for review for the rest of
 * the session. Claude Code versions from 2026-11-30 have no local fallback left,
 * so such a session asks the user to approve every action by hand.
 *
 * The gateway contract (code.claude.com/docs/en/llm-gateway-protocol.md and
 * auto-mode-classifier-billing.md): forward `anthropic-beta` and `safeguards`
 * unchanged as a pair, and return responses without dropping fields or
 * rewriting tool-use ids. The proxy honours it for every request this module
 * identifies as reviewed, and records here whether the review results came
 * back, so a session that loses its review shows up in the daemon log and on
 * `/health` instead of only as a silent switch to manual approval.
 */

import { log } from './logger.js';

/** The request body field that asks for review. */
const SAFEGUARDS_FIELD = '"safeguards"';
/** The response field that carries the review's results. */
const RESULTS_MARKER = '"safeguard_results"';
/** The SSE event that ends a streamed message. */
const MESSAGE_STOP_MARKER = '"message_stop"';
/** Bytes kept from the previous chunk so a marker split across two chunks is
 *  still found. Longer than the longest marker. */
const MARKER_CARRY_BYTES = 32;

/**
 * True when a /v1/messages body asks for server-side classifier review: its top
 * level carries a non-empty `safeguards` array.
 *
 * The beta flag alone is not the signal. Claude Code sends
 * `dangerous-tool-use-<date>` on nearly every request, subagents and side
 * queries included, but only requests carrying the field are reviewed. A cheap
 * substring check rules out most bodies before the parse.
 */
export function requestsServerReview(body: Buffer): boolean {
  if (!body.includes(SAFEGUARDS_FIELD)) return false;
  try {
    const parsed = JSON.parse(body.toString('utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const safeguards = (parsed as Record<string, unknown>)['safeguards'];
    return Array.isArray(safeguards) && safeguards.length > 0;
  } catch {
    return false;
  }
}

/** How a reviewed request's response ended, from the review's point of view. */
export type ReviewOutcome =
  /** The response carried `safeguard_results`. */
  | 'answered'
  /** The response completed without `safeguard_results`. This is what makes
   *  Claude Code stop asking for review in a gateway session. */
  | 'missing'
  /** The response ended before completing (client hang-up, dropped stream).
   *  Claude Code denies that response's actions without a verdict, but keeps
   *  asking for review. */
  | 'incomplete'
  /** Upstream answered with a non-2xx status. */
  | 'error';

/** Scans the upstream response bytes of one reviewed request for the review
 *  results. A pure observer: it never touches what reaches the client. */
export interface ReviewResultScanner {
  push(chunk: Buffer): void;
  /** Classify the response once it is over. `completed` is true when the
   *  upstream body ended normally. */
  outcome(statusCode: number, completed: boolean): ReviewOutcome;
}

export function createReviewResultScanner(isSse: boolean): ReviewResultScanner {
  let carry = '';
  let sawResults = false;
  let sawStop = false;
  return {
    push(chunk) {
      if (sawResults && sawStop) return;
      // latin1 maps every byte to one char, so a marker (pure ASCII) matches
      // no matter where a multi-byte character elsewhere was split.
      const text = carry + chunk.toString('latin1');
      if (!sawResults && text.includes(RESULTS_MARKER)) sawResults = true;
      if (!sawStop && text.includes(MESSAGE_STOP_MARKER)) sawStop = true;
      carry = text.slice(-MARKER_CARRY_BYTES);
    },
    outcome(statusCode, completed) {
      if (statusCode < 200 || statusCode >= 300) return 'error';
      if (sawResults) return 'answered';
      // A stream is complete once message_stop arrives; a JSON body once the
      // upstream body ends.
      const complete = isSse ? sawStop : completed;
      return complete ? 'missing' : 'incomplete';
    },
  };
}

/** Which credential carried a reviewed request upstream. Review support is
 *  rolled out per credential, so a loss on one kind and not another tells the
 *  two causes (the proxy, or the credential) apart. */
export type ReviewCredential = 'login' | 'pooled-api-key' | 'client-api-key';

type OutcomeCounts = Record<ReviewOutcome, number>;

/** Review outcomes split by whether Sentinel rewrote the request body (tool
 *  result compression, cache TTL override, permission tool strip, API key
 *  system prompt). The split is what shows whether a body rewrite costs the
 *  review: a gap only on `rewritten` points at the rewrite. */
export interface AutoModeReviewStats {
  untouched: OutcomeCounts;
  rewritten: OutcomeCounts;
}

const emptyCounts = (): OutcomeCounts => ({ answered: 0, missing: 0, incomplete: 0, error: 0 });

let stats: AutoModeReviewStats = { untouched: emptyCounts(), rewritten: emptyCounts() };

/** A missing review is logged at most once per credential kind and body
 *  treatment in this window, so a session that has lost its review doesn't
 *  write a line per request. */
export const MISSING_REVIEW_LOG_THROTTLE_MS = 10 * 60 * 1000;
const lastMissingLogAt = new Map<string, number>();

/** Record how one reviewed request's response ended. */
export function recordReviewOutcome(args: {
  outcome: ReviewOutcome;
  rewritten: boolean;
  credential: ReviewCredential;
  statusCode: number;
}): void {
  const bucket = args.rewritten ? stats.rewritten : stats.untouched;
  bucket[args.outcome] += 1;
  if (args.outcome !== 'missing') return;
  const body = args.rewritten ? 'rewritten' : 'untouched';
  const key = `${args.credential}:${body}`;
  const now = Date.now();
  if (
    now - (lastMissingLogAt.get(key) ?? Number.NEGATIVE_INFINITY) <
    MISSING_REVIEW_LOG_THROTTLE_MS
  ) {
    return;
  }
  lastMissingLogAt.set(key, now);
  log.warn(
    `[AutoModeReview] A request that asked for auto mode's server review got a complete ` +
      `${args.statusCode} response from Anthropic with no review results ` +
      `(credential: ${args.credential}, body: ${body}). Sentinel forwarded the response ` +
      `as received; Claude Code stops asking for review for that session.`,
  );
}

/** Snapshot for `/health`. */
export function getAutoModeReviewStats(): AutoModeReviewStats {
  return { untouched: { ...stats.untouched }, rewritten: { ...stats.rewritten } };
}

/** Reset the counters and log throttle. Tests only. */
export function resetAutoModeReviewStats(): void {
  stats = { untouched: emptyCounts(), rewritten: emptyCounts() };
  lastMissingLogAt.clear();
}
