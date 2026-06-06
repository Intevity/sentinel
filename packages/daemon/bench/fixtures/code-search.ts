/**
 * Benchmark fixture: ripgrep-style `path:line:content` search output, the
 * workload class behind Headroom's "code search (100 results) 92%" figure.
 *
 * Deterministic builder: 150 files with between 3 and 20 matches each
 * (sizes a pure function of the file index), exercising search_extract's
 * file cap (heaviest kept), per-file cap (first/last split), and marker
 * accounting.
 */

export function buildCodeSearch(): string {
  const lines: string[] = [];
  for (let f = 0; f < 150; f++) {
    const dir = ['daemon', 'app', 'shared', 'test-harness'][f % 4];
    const matches = 3 + ((f * 11) % 18);
    for (let m = 0; m < matches; m++) {
      const line = 10 + ((f * 53 + m * 29) % 900);
      lines.push(
        `packages/${dir}/src/module-${f}/handler-${(f * 7) % 40}.ts:${line}:  const result${m} = await dispatchRequest(ctx, { retries: ${m % 4} });`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Bare path list (Glob / `files_with_matches` shape) companion fixture for
 * search_extract's Shape B head/tail path capping.
 */
export function buildGlobList(): string {
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) {
    lines.push(`packages/daemon/src/generated/segment-${(i * 19) % 1000}/part-${i}.ts`);
  }
  return lines.join('\n');
}
