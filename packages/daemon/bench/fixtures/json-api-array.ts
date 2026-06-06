/**
 * Benchmark fixture: a large pretty-printed JSON API response array, the
 * workload class Headroom's SmartCrusher/TabularCompactor benchmarks use.
 *
 * Deterministic builder: every value is a pure function of the row index
 * (no randomness, no clock), so the fixture bytes are identical on every
 * run and the benchmark's savings floors can assert exact percentages.
 *
 * Shape notes (chosen to exercise specific rules):
 *  - homogeneous rows with an identical key signature   -> json_tabular
 *  - a uniform nested `meta` object on every row        -> dotted-column flatten
 *  - numeric `latencyMs`/`retries` with planted outliers -> json_sample stats
 *  - sporadic `"failed"` statuses                        -> sample error keeping
 */

const REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1'];

export function buildJsonApiArray(): string {
  const rows: unknown[] = [];
  for (let i = 0; i < 600; i++) {
    rows.push({
      id: i + 1,
      name: `resource-${(i * 7919) % 100000}`,
      status: i % 97 === 0 ? 'failed' : 'ok',
      latencyMs: 20 + ((i * 31) % 400) + (i % 149 === 0 ? 2400 : 0),
      retries: i % 5,
      meta: {
        region: REGIONS[i % 3],
        zone: `z${(i % 4) + 1}`,
        node: `node-${(i * 13) % 50}`,
      },
      createdAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T0${i % 10}:00:00Z`,
    });
  }
  return JSON.stringify(rows, null, 2);
}
