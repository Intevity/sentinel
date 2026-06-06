/**
 * Benchmark fixture: a large multi-file unified diff including a lockfile
 * section, a whitespace-only hunk, mode-change lines, and a file with far
 * more hunks than the aggressive cap. Exercises diff_trim's lockfile drop,
 * whitespace-hunk drop, file cap, hunk cap, and context trim.
 *
 * Deterministic builder (pure function of loop indices).
 */

function srcFileDiff(f: number, hunks: number, contextPad: number): string[] {
  const path = `packages/daemon/src/feature-${f}/impl-${(f * 3) % 25}.ts`;
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    `index ${(f * 2654435761) >>> (f % 7)}a..${(f * 40503) >>> (f % 5)}b 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
  ];
  for (let h = 0; h < hunks; h++) {
    const start = 20 + h * 40;
    const ctx = 3 + contextPad;
    lines.push(`@@ -${start},${ctx * 2 + 3} +${start},${ctx * 2 + 4} @@ function seg${h}()`);
    for (let c = 0; c < ctx; c++) lines.push(`   const before${h}_${c} = compute(${c});`);
    lines.push(`-  return legacyPath(input${h});`);
    lines.push(`+  const normalized = normalizeInput(input${h});`);
    lines.push(`+  return modernPath(normalized);`);
    for (let c = 0; c < ctx; c++) lines.push(`   emit(after${h}_${c});`);
  }
  return lines;
}

export function buildUnifiedDiff(): string {
  const lines: string[] = [];
  // 14 ordinary source files, varying hunk counts (one far over the caps).
  for (let f = 0; f < 14; f++) {
    lines.push(...srcFileDiff(f, f === 4 ? 18 : 2 + (f % 4), f === 9 ? 9 : 0));
  }
  // Mode-change file: the byte-preservation guard target.
  lines.push('diff --git a/scripts/release.sh b/scripts/release.sh');
  lines.push('old mode 100644');
  lines.push('new mode 100755');
  lines.push('index 91ac01f..91ac01f 100755');
  // Whitespace-only hunk file.
  lines.push('diff --git a/packages/app/src/styles.css b/packages/app/src/styles.css');
  lines.push('--- a/packages/app/src/styles.css');
  lines.push('+++ b/packages/app/src/styles.css');
  lines.push('@@ -10,4 +10,4 @@ .panel {');
  lines.push('   display: flex;');
  lines.push('-\t');
  lines.push('+  ');
  lines.push('   gap: 4px;');
  // Lockfile with a huge hunk body.
  lines.push('diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml');
  lines.push('--- a/pnpm-lock.yaml');
  lines.push('+++ b/pnpm-lock.yaml');
  lines.push('@@ -100,800 +100,800 @@ packages:');
  for (let i = 0; i < 800; i++) {
    const sign = i % 2 === 0 ? '-' : '+';
    lines.push(`${sign}  /dep-package-${(i * 13) % 400}@${(i % 9) + 1}.${i % 30}.${i % 10}:`);
  }
  lines.push('\\ No newline at end of file');
  return lines.join('\n');
}
