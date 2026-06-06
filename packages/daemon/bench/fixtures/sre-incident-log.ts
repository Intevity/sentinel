/**
 * Benchmark fixture: a timestamped service log around an incident, the
 * workload class behind Headroom's "SRE incident debugging 92%" figure.
 *
 * Deterministic builder. The INFO request lines differ only in volatile
 * fields (timestamp, latency, hex request id), so they normalize to one
 * template: log_near_dup_fold is the rule under test, with the ERROR burst
 * and its stack trace exercising the interesting-line exclusion plus
 * stack_trace_collapse / log_error_extract downstream.
 */

export function buildSreIncidentLog(): string {
  const lines: string[] = [];
  const hex = (n: number): string => ((n * 2654435761) >>> 0).toString(16).padStart(8, '0');
  const ts = (i: number): string => {
    const m = String(11 + Math.floor(i / 600)).padStart(2, '0');
    const s = String(Math.floor(i / 10) % 60).padStart(2, '0');
    const ms = String((i * 73) % 1000).padStart(3, '0');
    return `2026-03-14T02:${m}:${s}.${ms}Z`;
  };
  for (let i = 0; i < 2200; i++) {
    if (i === 1100) {
      lines.push(`${ts(i)} ERROR upstream connection refused host=db-primary-3 attempt=1`);
      lines.push(`${ts(i)} ERROR query failed: timeout after 5000ms route=/api/v1/orders`);
      lines.push('Traceback (most recent call last):');
      for (let f = 0; f < 14; f++) {
        lines.push(
          `  File "/srv/app/handlers/orders_${f % 4}.py", line ${120 + f * 17}, in handle`,
        );
      }
      lines.push('ConnectionError: pool exhausted (32/32 in use)');
      lines.push(`${ts(i)} WARN circuit breaker OPEN for db-primary-3`);
      continue;
    }
    const route = i % 3 === 0 ? '/api/v1/orders' : i % 3 === 1 ? '/api/v1/users' : '/api/v1/items';
    lines.push(
      `${ts(i)} INFO request handled route=${route} status=200 latency_ms=${12 + ((i * 7) % 180)} req_id=${hex(i)}`,
    );
  }
  lines.push('2026-03-14T02:59:59.000Z INFO log segment closed events=2218');
  return lines.join('\n');
}
