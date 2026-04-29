#!/usr/bin/env node
/**
 * Detector regex ReDoS lint. Sprint 10.
 *
 * Walks every regex literal in
 * packages/daemon/src/security/detectors.ts and runs each one against a
 * panel of pathological inputs, timing the match. Any regex whose
 * single match exceeds 100 ms on any input is flagged as a ReDoS risk
 * and the script exits non-zero.
 *
 * Why source-parse instead of import: the script is dependency-free and
 * doesn't require a daemon build, matching scripts/mock-budget.mjs's
 * style. detectors.ts is structured uniformly, so a small literal
 * tokenizer is sufficient.
 *
 * Usage:
 *   node scripts/check-detector-regex.mjs            check (default) — exit 1 on regression
 *   node scripts/check-detector-regex.mjs --verbose  print timings for every (regex, input) pair
 *
 * Exit codes:
 *   0  all regexes within budget
 *   1  one or more regexes exceeded 100 ms threshold
 *   2  internal error (cannot read source, parse failure)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const DETECTORS_PATH = join(REPO_ROOT, 'packages/daemon/src/security/detectors.ts');

const args = new Set(process.argv.slice(2));
const VERBOSE = args.has('--verbose');

// 100 ms is the budget; well-formed regexes complete in single-digit ms
// even on 10 KB inputs. Catastrophic backtracking is multi-second, so
// the threshold has clear separation from healthy noise.
const BUDGET_MS = 100;
// Each (regex, input) is timed twice and the warmer reading is used,
// to keep CI runners (slower than local) from flaking on JIT noise.
const REPEATS = 2;

function fail(msg, code = 2) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

let source;
try {
  source = readFileSync(DETECTORS_PATH, 'utf8');
} catch (err) {
  fail(`cannot read ${DETECTORS_PATH}: ${err.message}`);
}

// ─── Source extraction ──────────────────────────────────────────────

/**
 * Read a JS regex literal starting at `start` (which must point at the
 * leading `/`). Returns `{ pattern, flags, end }` or null if the literal
 * is malformed.
 */
function readRegexLiteral(text, start) {
  if (text[start] !== '/') return null;
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[' && !inClass) {
      inClass = true;
      i++;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      i++;
      continue;
    }
    if (ch === '\n' && !inClass) return null;
    if (ch === '/' && !inClass) {
      let j = i + 1;
      while (j < text.length && /[gimsuy]/.test(text[j])) j++;
      return { pattern: text.slice(start + 1, i), flags: text.slice(i + 1, j), end: j };
    }
    i++;
  }
  return null;
}

/** Find the next non-whitespace index at or after `from`. */
function skipWs(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * Walk the source and yield every `{ id, pattern, flags, line }` regex.
 * Captures rules of all shapes:
 *   - `regex: /<pat>/<f>,` (inline)
 *   - `regex:\n      /<pat>/<f>,` (multi-line continuation)
 *   - `const FOO_REGEX = /<pat>/<f>;`
 *   - `pattern: /<pat>/<f>,` (allowlist/context tables)
 *   - `re: /<pat>/<f>,`     (read-target tables)
 *   - `anchorRegex` / `candidateRegex` (keyword-gated rules)
 * Skips `buildEnvVarHijackRegex(...)` — those are handled separately.
 */
function* extractRegexes(text) {
  // Build line-start offsets so we can map indices back to line numbers
  // for diagnostic output.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (idx) => {
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  // Track the most-recently-seen `id: '<x>'` so we can label rule regexes.
  const idRe = /\bid:\s*'([^']+)'/g;
  const idsByOffset = [];
  for (let m; (m = idRe.exec(text)); ) {
    idsByOffset.push({ offset: m.index, id: m[1] });
  }
  // Only use a recent `id` (within ~30 lines back) so unlabeled patterns
  // in tables like RISKY_WEBFETCH_HOSTS / ALLOWLIST_PATH_PATTERNS don't
  // get tagged with the previous BASH_RULES rule's id.
  const idAtOrBefore = (offset) => {
    let last = null;
    for (const e of idsByOffset) {
      if (e.offset <= offset) last = e;
      else break;
    }
    if (!last) return null;
    if (offset - last.offset > 1500) return null;
    return last.id;
  };

  // Markers we care about; ordered by frequency for early-out.
  const markers = ['regex:', 'pattern:', 'anchorRegex:', 'candidateRegex:', 're:'];
  const constRe = /\b(?:const|let)\s+([A-Z][A-Z0-9_]*REGEX|[A-Z][A-Z0-9_]*PATTERN)\s*=\s*/g;

  // Field-style markers (`regex:` etc.).
  for (let i = 0; i < text.length; i++) {
    let matched = null;
    for (const marker of markers) {
      if (text.startsWith(marker, i)) {
        matched = marker;
        break;
      }
    }
    if (!matched) continue;
    // Skip type declarations like `regex: RegExp;` inside interfaces.
    const after = skipWs(text, i + matched.length);
    if (text[after] !== '/') {
      // Could be `buildEnvVarHijackRegex(...)` or a type — skip.
      continue;
    }
    const lit = readRegexLiteral(text, after);
    if (!lit) continue;
    // Patterns in unlabeled tables (e.g. RISKY_WEBFETCH_HOSTS) have no
    // nearby `id:`. Synthesize one from the line number so the lint
    // still tests them.
    const id = idAtOrBefore(i) ?? `line-${lineOf(after)}`;
    const labelSuffix =
      matched === 'pattern:' || matched === 're:'
        ? ''
        : matched === 'anchorRegex:'
          ? '/anchor'
          : matched === 'candidateRegex:'
            ? '/candidate'
            : '';
    yield {
      id: id + labelSuffix,
      pattern: lit.pattern,
      flags: lit.flags,
      line: lineOf(after),
      shape: matched,
    };
    i = lit.end - 1;
  }

  // Top-level `const X_REGEX = /.../;` constants.
  for (let m; (m = constRe.exec(text)); ) {
    const after = skipWs(text, constRe.lastIndex);
    if (text[after] !== '/') continue;
    const lit = readRegexLiteral(text, after);
    if (!lit) continue;
    yield {
      id: m[1],
      pattern: lit.pattern,
      flags: lit.flags,
      line: lineOf(after),
      shape: 'const',
    };
  }
}

// ─── Build env-var hijack regexes by mirroring detectors.ts logic ───

// Mirrors `buildEnvVarHijackRegex` in detectors.ts so the lint covers
// the env-var-hijack rules without needing to import the daemon module.
// If detectors.ts changes that function, this mirror must change too —
// the tests pin the hijack semantics, so a divergence shows up there.
function buildEnvVarHijackRegex(vars) {
  const alternation = vars.join('|');
  return new RegExp(
    `(?:(?:^|[\\s;&|])(?:export\\s+|env\\s+(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*)?(?:${alternation})=` +
      `|\\bsetenv\\s+(?:${alternation})\\b)`,
    'g',
  );
}

const ENV_VAR_HIJACK_HIGH = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'NODE_OPTIONS',
];
const ENV_VAR_HIJACK_MEDIUM = [
  'PYTHONHOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'PATH',
  'AWS_[A-Z][A-Z0-9_]*',
];

// ─── Pathological input panel ───────────────────────────────────────

const A10K = 'a'.repeat(10000);
const PATHO = [
  { label: 'a*10000', input: A10K },
  // Force near-miss to trigger backtracking on patterns with `[^X]+ X` shape.
  { label: 'a*10000+!', input: A10K + '!' },
  { label: '(*1000', input: '('.repeat(1000) },
  // URL-shaped near-miss for connection-string and webhook regexes.
  { label: 'http://a*10000', input: 'http://' + 'a'.repeat(10000) },
  { label: 'postgres://u:a*8000', input: 'postgres://u:' + 'a'.repeat(8000) },
  // Bash shell-shaped near-miss for risky-bash regexes.
  { label: 'curl a*10000', input: 'curl ' + 'a'.repeat(10000) },
  { label: 'rm -a*1000+slash', input: 'rm -' + 'a'.repeat(1000) + ' /' },
  // Targeted "rm -" with no `r` or `f` flag char anywhere -> exposes
  // patterns like `[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*` to backtracking.
  { label: 'rm -bcde*2000', input: 'rm -' + 'bcde'.repeat(500) + ' /' },
  { label: 'rm -bcde*2000 no-target', input: 'rm -' + 'bcde'.repeat(500) },
  // <img tag near-miss for HTML-shaped injection regexes.
  {
    label: '<img a*5000 + src=',
    input: '<img ' + 'a'.repeat(5000) + ' src="http://x?a=$',
  },
  // Markdown link near-miss.
  { label: '[a*5000](http://...)', input: '[' + 'a'.repeat(5000) + '](http://x?token=)' },
  // SAS-URL near-miss.
  {
    label: 'azure-blob URL + a*5000',
    input: 'https://x.blob.core.windows.net/' + 'a'.repeat(5000) + '?sig=',
  },
  // JSON service-account near-miss (lookahead window stress).
  {
    label: '{a*4000 no markers}',
    input: '{' + 'a'.repeat(4000) + '}',
  },
  // Connection-string negative shape (near-miss on `@`).
  {
    label: 'mysql://u:a*8000 no @',
    input: 'mysql://u:' + 'a'.repeat(8000),
  },
  // nc/scp/ssh -flag*flag*flag near-miss exposes (-\S+\s+)* style.
  { label: 'nc -a -a -a x100 host', input: 'nc ' + '-a '.repeat(100) + ' host 1234' },
  { label: 'ssh -aaaa*1000', input: 'ssh ' + '-' + 'a'.repeat(1000) },
  // jdbc?user=&...a*2000 stresses `[^?\s]*?(?:^|&)(?:user|password)=`.
  { label: 'jdbc:?a*2000', input: 'jdbc:postgres://h?' + 'a'.repeat(2000) },
  // Discord token near-miss: long base64-ish run with no dots.
  { label: 'MT a*5000 no dots', input: 'MT' + 'a'.repeat(5000) },
  // tool_use(arg) near-miss for `[^)]*[/$"'\\\s][^)]{0,200}\)`.
  { label: 'Bash(a*5000 no )', input: 'Bash(' + 'a'.repeat(5000) },
];

// ─── Run lint ───────────────────────────────────────────────────────

const cases = [];
for (const { id, pattern, flags, line, shape } of extractRegexes(source)) {
  let regex;
  try {
    // Strip 'g' flag so successive exec() calls don't advance lastIndex
    // and skew timings by terminating early.
    regex = new RegExp(pattern, flags.replace('g', ''));
  } catch (err) {
    fail(`cannot compile ${id} at ${DETECTORS_PATH}:${line}: ${err.message}`);
  }
  cases.push({ id, line, regex, shape });
}

// Append the env-var hijack rules (built dynamically in detectors.ts).
cases.push({
  id: 'env-var-hijack-high',
  line: 0,
  regex: buildEnvVarHijackRegex(ENV_VAR_HIJACK_HIGH),
  shape: 'built',
});
cases.push({
  id: 'env-var-hijack-medium',
  line: 0,
  regex: buildEnvVarHijackRegex(ENV_VAR_HIJACK_MEDIUM),
  shape: 'built',
});

if (cases.length < 50) {
  fail(`extracted only ${cases.length} regexes; parser likely missed entries`);
}

const violations = [];
const allTimings = [];

for (const { id, line, regex } of cases) {
  for (const { label, input } of PATHO) {
    let lastMs = 0;
    for (let r = 0; r < REPEATS; r++) {
      const t0 = performance.now();
      regex.exec(input);
      lastMs = performance.now() - t0;
    }
    allTimings.push({ id, line, label, ms: lastMs });
    if (lastMs > BUDGET_MS) {
      violations.push({ id, line, label, ms: lastMs });
    }
  }
}

if (VERBOSE) {
  console.log(`Checked ${cases.length} regexes × ${PATHO.length} inputs.`);
  const slowest = allTimings.slice().sort((a, b) => b.ms - a.ms);
  console.log('Top-15 slowest (regex × input):');
  for (const t of slowest.slice(0, 15)) {
    console.log(`  ${t.ms.toFixed(2).padStart(8)} ms  ${t.id} :: ${t.label}`);
  }
}

if (violations.length > 0) {
  console.error(`ReDoS lint failed: ${violations.length} regex/input pair(s) over ${BUDGET_MS} ms`);
  for (const v of violations) {
    console.error(`  ${v.ms.toFixed(2).padStart(8)} ms  ${v.id} (line ${v.line}) :: ${v.label}`);
  }
  process.exit(1);
}

console.log(
  `ReDoS lint OK: ${cases.length} regexes × ${PATHO.length} inputs all under ${BUDGET_MS} ms.`,
);
