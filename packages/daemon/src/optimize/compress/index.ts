/**
 * In-flight tool_result compression. Pure, deterministic, idempotent rules
 * applied to Anthropic /v1/messages request bodies before they are forwarded
 * upstream, plus the per-request stats the proxy records for analytics.
 */

export { compressMessagesBody } from './compress-body.js';
export { compressToolResultText } from './tiers.js';
export {
  stripAnsi,
  collapseBlankLines,
  collapseDuplicateLines,
  collapseStackTraces,
  truncateLog,
} from './text-rules.js';
export { tryParseJson, minifyJsonWhitespace, tabularDedup } from './json-rules.js';
export { isUnifiedDiff, trimUnifiedDiff } from './diff-rules.js';
export { isSearchOutput, extractSearchMatches } from './search-rules.js';
export { normalizeTemplate, foldNearDuplicateLines } from './log-fold-rules.js';
export { isHtml, extractHtmlText } from './html-rules.js';
export { byteLen, estimateTokensFromBytes, hashOriginal } from './types.js';
export type {
  CompressionLevel,
  CompressOpts,
  CompressResult,
  CompressionStats,
  CaptureRecord,
  PerToolStat,
  PerRuleStat,
  RuleId,
  SkipReason,
} from './types.js';
