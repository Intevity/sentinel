#!/usr/bin/env node
/**
 * Enforce the commit-message convention that GitHub release notes are
 * generated from (see scripts/release-notes.mjs): every non-merge commit
 * subject becomes a release-note bullet verbatim, and body lines starting
 * with `- ` become its sub-bullets. Dependency-free — runs in CI on every PR
 * so the convention holds no matter who (or which tool) authored the commit.
 *
 * Required subject shape:
 *   <type>(<scope>)?: <description>
 * where <type> is one of feat|fix|perf|refactor|docs|test|ci|build|chore|style|revert,
 * the description is non-empty, and the whole subject is <= 120 chars.
 *
 * Usage: node scripts/commit-lint.mjs <baseRef> [headRef]
 *   Lints every non-merge commit in baseRef..headRef (headRef defaults HEAD).
 */
import { execFileSync } from 'node:child_process';

const TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'ci',
  'build',
  'chore',
  'style',
  'revert',
];
const SUBJECT = new RegExp(`^(?:${TYPES.join('|')})(?:\\([^)]+\\))?!?: \\S.*$`);
const MAX_SUBJECT = 120;

const base = process.argv[2];
const head = process.argv[3] ?? 'HEAD';
if (!base) {
  console.error('Usage: node scripts/commit-lint.mjs <baseRef> [headRef]');
  process.exit(1);
}

const raw = execFileSync(
  'git',
  ['log', '--no-merges', '--pretty=format:%h%x09%s', `${base}..${head}`],
  { encoding: 'utf8' },
).trim();
const commits = raw
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const tab = line.indexOf('\t');
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  });

const failures = [];
for (const { sha, subject } of commits) {
  if (!SUBJECT.test(subject)) {
    failures.push(`${sha}  ${subject}\n      not a conventional commit subject`);
  } else if (subject.length > MAX_SUBJECT) {
    failures.push(
      `${sha}  ${subject.slice(0, 60)}…\n      subject is ${subject.length} chars (max ${MAX_SUBJECT}); move detail into body bullets`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    [
      `commit-lint: ${failures.length} of ${commits.length} commit(s) failed.`,
      '',
      ...failures.map((f) => `  ${f}`),
      '',
      'Release notes are generated verbatim from commit messages:',
      '  <type>(<scope>): <summary that reads as a release-note bullet>',
      '',
      '  - one body bullet per distinct feature/fix in the commit',
      '',
      `  type: ${TYPES.join(' | ')}`,
      'See CLAUDE.md "Commit messages" for the full convention.',
    ].join('\n'),
  );
  process.exit(1);
}
console.log(`commit-lint ok: ${commits.length} commit(s) checked`);
