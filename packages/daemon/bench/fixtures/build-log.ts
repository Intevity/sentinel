/**
 * Benchmark fixture: a cargo-style build log, the workload class behind
 * Headroom's "build logs 93.9%" benchmark figure.
 *
 * Deterministic builder (pure function of loop indices). The `Compiling`
 * lines match the compressor's LOG_FRAMEWORK_RE (cargo pattern), so
 * log_error_extract is the rule under test: it must keep the two warning
 * blocks, the error[E0308] block, and the head/tail summary while eliding
 * the thousands of progress lines in between.
 */

export function buildBuildLog(): string {
  const lines: string[] = [];
  lines.push('$ cargo build --release --workspace');
  lines.push('    Updating crates.io index');
  for (let i = 0; i < 180; i++) {
    lines.push(
      `  Downloaded dep-crate-${(i * 17) % 500} v${(i % 9) + 1}.${(i * 3) % 20}.${i % 10}`,
    );
  }
  lines.push(`  Downloaded 180 crates (24.1 MB) in 2.94s`);
  for (let i = 0; i < 2100; i++) {
    lines.push(`   Compiling unit-${(i * 37) % 4096} v0.${(i % 40) + 1}.${i % 10}`);
    if (i === 700) {
      lines.push('warning: unused variable: `retries`');
      lines.push('  --> src/scheduler/queue.rs:142:9');
      lines.push('   |');
      lines.push('142|     let retries = attempts.checked_sub(1);');
      lines.push('   |         ^^^^^^^ help: if this is intentional, prefix it with an underscore');
      lines.push('   |');
      lines.push('   = note: `#[warn(unused_variables)]` on by default');
    }
    if (i === 1400) {
      lines.push('error[E0308]: mismatched types');
      lines.push('   --> src/proxy/upstream.rs:88:22');
      lines.push('    |');
      lines.push('88  |     let timeout: u64 = config.timeout_ms;');
      lines.push(
        '    |                  ---   ^^^^^^^^^^^^^^^^^ expected `u64`, found `Option<u64>`',
      );
      lines.push('    |                  |');
      lines.push('    |                  expected due to this');
    }
  }
  lines.push('warning: `sentinel-proxy` (lib) generated 1 warning');
  lines.push(
    'error: could not compile `sentinel-proxy` (lib) due to 1 previous error; 1 warning emitted',
  );
  return lines.join('\n');
}
