/**
 * Cache-aware counterfactual savings calculator.
 *
 * For an opportunity (a list of tool_calls a curated subagent would have
 * absorbed), we estimate two costs:
 *
 *   actualCost   — what the parent Opus turn paid for these tokens, with
 *                  cache state derived from the matching cache_ttl_event.
 *                  Cached tokens get the 0.1x multiplier; cache writes
 *                  get 1.25x (5m) or 2.0x (1h); the rest are uncached.
 *
 *   hypoCost     — what the routing alternative would have cost: the
 *                  subagent (typically Haiku) reading the file cold,
 *                  plus a fixed-size digest replayed back into the parent
 *                  Opus turn (uncached on the first replay).
 *
 *   savings      = actualCost - hypoCost
 *
 * The proportional split is approximate: when a turn has multiple tool
 * results, we attribute each tool's share of the input by
 * (response_size_bytes / sum). Cache state carries over uniformly. The
 * dashboard labels the numbers "estimated" and links to a methodology
 * page so users know to expect approximation, not actuals.
 */

import {
  getBaseInputPricePerMillion,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
} from '../cache-ttl/pricing.js';

/** Tokens-per-byte rough conversion. Anthropic's tokenizer averages
 *  ~3.6 bytes per input token on English text and ~3 bytes on code.
 *  Splitting the difference keeps the estimate honest without per-
 *  payload tokenization cost. */
const BYTES_PER_TOKEN = 3.5;

/** Per-curated-id digest size estimate, in tokens. The subagent's
 *  digest is what the parent Opus turn replays each subsequent turn,
 *  so this directly drives the hypothetical cost. Tuned to the
 *  curated SOUL bodies — file-explorer caps at 500 tokens, log-
 *  analyzer at 800, etc. */
const DIGEST_TOKENS_BY_CURATED_ID: Readonly<Record<string, number>> = {
  'file-explorer': 500,
  'test-runner-parser': 600,
  'log-analyzer': 800,
  'repo-mapper': 1500,
  'diff-pre-pass': 1000,
  'output-formatter': 400,
};

/** Default digest size for unknown curated ids (graceful fallback so
 *  the calculator never throws on a typo). */
const DEFAULT_DIGEST_TOKENS = 700;

export interface ToolCallContribution {
  /** Approximate input bytes the tool result added to the parent
   *  conversation when its response was injected. */
  responseSizeBytes: number;
}

export interface CacheTurnState {
  /** Tokens read from prompt cache during this turn (0.1x rate). */
  cacheRead: number;
  /** Tokens written to 5m cache during this turn (1.25x rate). */
  cacheCreate5m: number;
  /** Tokens written to 1h cache during this turn (2.0x rate). */
  cacheCreate1h: number;
  /** Uncached input tokens (1.0x rate). */
  uncachedInput: number;
  /** Total input tokens — sum of the four buckets, used as the
   *  denominator for proportional attribution. */
  totalInputTokens: number;
}

export interface SavingsInputs {
  /** Tool calls the candidate subagent would have absorbed. */
  toolCalls: ToolCallContribution[];
  /** Cache-state snapshot of the parent Opus turn that contained
   *  these tool results. */
  parentTurn: CacheTurnState;
  /** Model the parent turn ran on. */
  actualModel: string;
  /** Curated id used for digest sizing and (in v1) hypothetical
   *  model lookup. Looked up in DIGEST_TOKENS_BY_CURATED_ID. */
  curatedId: string;
  /** Hypothetical model the subagent would have run on. Always
   *  Haiku for the v1 curated library; passed in so future curated
   *  entries can vary without changing this calculator. */
  hypoModel: string;
}

export interface SavingsResult {
  actualCostUsd: number;
  hypotheticalCostUsd: number;
  savingsUsd: number;
  /** Per-call attribution share applied to the parent turn's input. */
  shareOfTurn: number;
  /** Tokens we attributed to the candidate routing decision. */
  attributedInputTokens: number;
  attributedCachedTokens: number;
}

export function computeSavings(inputs: SavingsInputs): SavingsResult {
  const totalToolBytes = inputs.toolCalls.reduce((s, c) => s + c.responseSizeBytes, 0);
  // When the turn carried 0 input tokens (probe / empty), savings are
  // 0 by definition. Avoids a divide-by-zero on shareOfTurn.
  if (inputs.parentTurn.totalInputTokens <= 0 || totalToolBytes <= 0) {
    return {
      actualCostUsd: 0,
      hypotheticalCostUsd: 0,
      savingsUsd: 0,
      shareOfTurn: 0,
      attributedInputTokens: 0,
      attributedCachedTokens: 0,
    };
  }

  // Approximate the share of the parent turn's input that came from
  // these tool results. We use a rough byte-to-token conversion since
  // the actual tokenization happens upstream and we don't have it.
  const totalBytesEquivalent = inputs.parentTurn.totalInputTokens * BYTES_PER_TOKEN;
  const shareOfTurn = Math.min(1, totalToolBytes / totalBytesEquivalent);

  // Cache state proportionally split across the share.
  const split = (n: number): number => n * shareOfTurn;
  const baseActual = getBaseInputPricePerMillion(inputs.actualModel);
  const actualCostUsd =
    (split(inputs.parentTurn.cacheRead) * baseActual * CACHE_READ_MULTIPLIER +
      split(inputs.parentTurn.cacheCreate5m) * baseActual * CACHE_WRITE_5M_MULTIPLIER +
      split(inputs.parentTurn.cacheCreate1h) * baseActual * CACHE_WRITE_1H_MULTIPLIER +
      split(inputs.parentTurn.uncachedInput) * baseActual) /
    1_000_000;

  // Hypothetical: subagent reads the file cold (no cache). Token count
  // approximated from byte count. Plus a digest sent back into the
  // parent Opus turn — uncached on first replay, then cached on later
  // turns; v1 estimate counts it once at the actual model's rate.
  const hypoInputTokens = totalToolBytes / BYTES_PER_TOKEN;
  const baseHypo = getBaseInputPricePerMillion(inputs.hypoModel);
  const digestTokens = DIGEST_TOKENS_BY_CURATED_ID[inputs.curatedId] ?? DEFAULT_DIGEST_TOKENS;
  const hypotheticalCostUsd = (hypoInputTokens * baseHypo + digestTokens * baseActual) / 1_000_000;

  const attributedInputTokens = Math.round(split(inputs.parentTurn.totalInputTokens));
  const attributedCachedTokens = Math.round(split(inputs.parentTurn.cacheRead));

  return {
    actualCostUsd,
    hypotheticalCostUsd,
    savingsUsd: actualCostUsd - hypotheticalCostUsd,
    shareOfTurn,
    attributedInputTokens,
    attributedCachedTokens,
  };
}
