/**
 * Per-curated-id digest size estimate, in input tokens. The subagent's
 * digest is the summary it replays into the parent Opus turn, so this
 * directly drives:
 *   - the hypothetical cost in `savings-calc.ts`
 *   - the back-fill migration in `db.ts`
 *   - the dashboard's "parent-context tokens saved" computation
 *
 * Kept in the shared package so the daemon, the back-fill migration,
 * and the app all reference the same values without circular imports.
 * Tuned to the curated SOUL bodies (file-explorer caps at 500 tokens,
 * log-analyzer at 800, etc.).
 */
export const DIGEST_TOKENS_BY_CURATED_ID: Readonly<Record<string, number>> = {
  'file-explorer': 500,
  'test-runner-parser': 600,
  'log-analyzer': 800,
  'repo-mapper': 1500,
  'diff-pre-pass': 1000,
  'output-formatter': 400,
  'web-fetcher': 600,
  'test-failure-investigator': 500,
  'dep-tracer': 900,
};

/** Default digest size for unknown curated ids. Picked so the calculator
 *  never throws on a typo and so future curated entries that don't
 *  ship with an explicit override still get a defensible estimate. */
export const DEFAULT_DIGEST_TOKENS = 700;

export function getDigestTokens(curatedId: string): number {
  return DIGEST_TOKENS_BY_CURATED_ID[curatedId] ?? DEFAULT_DIGEST_TOKENS;
}
