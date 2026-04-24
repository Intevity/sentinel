#!/usr/bin/env node
/**
 * Mock-count ratchet. Scans every *.test.ts file under packages/, counts
 * vi.mock / vi.fn / vi.spyOn / vi.stubGlobal call sites, and compares each
 * file's count to the ceiling recorded in .mock-budget.json at repo root.
 *
 * The goal is to prevent silent re-introduction of mocks after the
 * migration from mock-heavy unit tests to fake-Anthropic integration
 * tests. Mocks are a floor, not a target: this check blocks regressions
 * without blocking intentional new mocks — authors bump the budget in
 * the same PR via --update and defend the decision in review.
 *
 * Usage:
 *   node scripts/mock-budget.mjs             check (default) — exit 1 on violation
 *   node scripts/mock-budget.mjs --update    rewrite .mock-budget.json with current counts
 *   node scripts/mock-budget.mjs --verbose   check + print every file's count
 *
 * Exit codes:
 *   0  budget respected
 *   1  policy violation (over-budget, new file with mocks, stale budget key)
 *   2  internal error (bad JSON, unreadable file)
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const BUDGET_PATH = join(REPO_ROOT, '.mock-budget.json');

// Matches vi.mock / vi.fn / vi.spyOn / vi.stubGlobal call sites.
// Post-filter in countMocksInFile drops `typeof vi.fn` type annotations
// (they're not call sites). The `\b` tail lets us count `vi.fn<TypeArg>()`
// generic calls, which a `\s*\(` tail would miss.
const MOCK_PATTERN = /(?<![\w.])vi\.(mock|fn|spyOn|stubGlobal)\b/g;
const TYPEOF_BEFORE = /typeof\s+$/;
const MAX_SITES_PRINTED = 10;
const BUDGET_COMMENT = "Edit via 'pnpm mock:budget:update', not by hand. See Sprint 8.";

const args = new Set(process.argv.slice(2));
const MODE_UPDATE = args.has('--update');
const MODE_VERBOSE = args.has('--verbose');

function toPosix(p) {
  return p.split(sep).join('/');
}

function walkTestFiles(root) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch (err) {
    console.error(`error: cannot read ${root}: ${err.message}`);
    process.exit(2);
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.test.ts')) continue;
    const dir = entry.parentPath ?? entry.path ?? root;
    const abs = join(dir, entry.name);
    out.push(toPosix(relative(REPO_ROOT, abs)));
  }
  return out.sort();
}

function countMocksInFile(absOrRel) {
  const abs = absOrRel.startsWith('/') ? absOrRel : join(REPO_ROOT, absOrRel);
  let src;
  try {
    src = readFileSync(abs, 'utf-8');
  } catch (err) {
    console.error(`error: cannot read ${absOrRel}: ${err.message}`);
    process.exit(2);
  }
  const sites = [];
  for (const m of src.matchAll(MOCK_PATTERN)) {
    // Skip `typeof vi.fn` type references — not call sites.
    const before = src.slice(Math.max(0, m.index - 16), m.index);
    if (TYPEOF_BEFORE.test(before)) continue;
    sites.push({ index: m.index, match: m[0] });
  }
  return { count: sites.length, sites, src };
}

function locateSite(src, byteIndex) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < byteIndex; i++) {
    if (src.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  const col = byteIndex - lineStart + 1;
  let lineEnd = src.indexOf('\n', byteIndex);
  if (lineEnd < 0) lineEnd = src.length;
  const snippet = src.slice(lineStart, lineEnd).trim();
  return { line, col, snippet };
}

function formatSites(path, src, sites) {
  const shown = sites.slice(0, MAX_SITES_PRINTED);
  const lines = shown.map((s) => {
    const { line, col, snippet } = locateSite(src, s.index);
    return `    ${path}:${line}:${col}: ${snippet}`;
  });
  if (sites.length > shown.length) {
    lines.push(`    ... and ${sites.length - shown.length} more`);
  }
  return lines.join('\n');
}

function loadBudget() {
  if (!existsSync(BUDGET_PATH)) {
    if (MODE_UPDATE) return {};
    console.error(
      `error: ${toPosix(relative(REPO_ROOT, BUDGET_PATH))} not found — run with --update to seed`,
    );
    process.exit(2);
  }
  let raw;
  try {
    raw = readFileSync(BUDGET_PATH, 'utf-8');
  } catch (err) {
    console.error(`error: cannot read .mock-budget.json: ${err.message}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`error: .mock-budget.json is not valid JSON: ${err.message}`);
    process.exit(2);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`error: .mock-budget.json must be a JSON object`);
    process.exit(2);
  }
  const budget = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k === '_comment') continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      console.error(
        `error: .mock-budget.json["${k}"] must be a non-negative integer (got ${JSON.stringify(v)})`,
      );
      process.exit(2);
    }
    budget[k] = v;
  }
  return budget;
}

function writeBudget(counts) {
  const keys = Object.keys(counts).sort();
  const body = { _comment: BUDGET_COMMENT };
  for (const k of keys) body[k] = counts[k];
  writeFileSync(BUDGET_PATH, JSON.stringify(body, null, 2) + '\n');
}

function main() {
  const files = walkTestFiles(PACKAGES_DIR);
  const counts = {};
  const sources = {};
  const sites = {};
  for (const f of files) {
    const { count, sites: s, src } = countMocksInFile(f);
    if (count > 0) {
      counts[f] = count;
      sources[f] = src;
      sites[f] = s;
    }
  }

  if (MODE_UPDATE) {
    writeBudget(counts);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(
      `wrote .mock-budget.json: ${Object.keys(counts).length} files, ${total} mock sites`,
    );
    process.exit(0);
  }

  const budget = loadBudget();

  if (MODE_VERBOSE) {
    console.log('current mock counts:');
    let total = 0;
    for (const f of files) {
      const c = counts[f] ?? 0;
      const b = budget[f];
      const marker = b === undefined ? (c > 0 ? ' (new)' : '') : ` (budget ${b})`;
      console.log(`  ${c.toString().padStart(3)}  ${f}${marker}`);
      total += c;
    }
    console.log(`total: ${total} sites across ${files.length} files`);
    console.log('');
  }

  const overBudget = [];
  const newFiles = [];
  const shrinkable = [];
  const stale = [];

  for (const [f, c] of Object.entries(counts)) {
    const b = budget[f];
    if (b === undefined) {
      newFiles.push({ path: f, count: c });
    } else if (c > b) {
      overBudget.push({ path: f, count: c, budget: b });
    } else if (c < b) {
      shrinkable.push({ path: f, count: c, budget: b });
    }
  }
  for (const [f, b] of Object.entries(budget)) {
    const exists = existsSync(join(REPO_ROOT, f));
    if (!exists) {
      stale.push({ path: f, budget: b });
    }
  }
  for (const f of Object.keys(budget)) {
    if (existsSync(join(REPO_ROOT, f)) && counts[f] === undefined) {
      if (budget[f] > 0) shrinkable.push({ path: f, count: 0, budget: budget[f] });
    }
  }

  for (const s of shrinkable) {
    console.log(
      `notice: ${s.path} is ${s.count}/${s.budget} mocks — run \`pnpm mock:budget:update\` to lock in progress`,
    );
  }

  const violationFileCount = overBudget.length + newFiles.length + stale.length;
  if (violationFileCount === 0) {
    if (!MODE_VERBOSE) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`mock budget ok: ${total} sites across ${Object.keys(counts).length} files`);
    }
    process.exit(0);
  }

  const totalOver = overBudget.reduce((a, x) => a + (x.count - x.budget), 0);
  const totalNew = newFiles.reduce((a, x) => a + x.count, 0);
  console.error(
    `budget violations: ${violationFileCount} file(s), +${totalOver + totalNew} mocks over floor`,
  );

  if (overBudget.length > 0) {
    console.error('');
    console.error('over-budget files:');
    for (const v of overBudget) {
      console.error(
        `  ${v.path}: ${v.count}/${v.budget} mocks (+${v.count - v.budget} over floor)`,
      );
      console.error(formatSites(v.path, sources[v.path], sites[v.path]));
    }
  }

  if (newFiles.length > 0) {
    console.error('');
    console.error('new files with mocks (not in budget):');
    for (const v of newFiles) {
      console.error(`  ${v.path}: ${v.count} mocks`);
      console.error(formatSites(v.path, sources[v.path], sites[v.path]));
    }
    console.error('  run `pnpm mock:budget:update` if the new mocks are intentional');
  }

  if (stale.length > 0) {
    console.error('');
    console.error('stale budget keys (file not found on disk):');
    for (const v of stale) {
      console.error(`  ${v.path}: listed with budget ${v.budget}`);
    }
    console.error('  run `pnpm mock:budget:update` to remove');
  }

  process.exit(1);
}

main();
