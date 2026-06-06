#!/usr/bin/env node
/**
 * Generate concise bullet-point release notes for a tag from conventional
 * commits. Pure git parsing — no network calls and no LLM, so it is free,
 * deterministic, and reviewable. Used by the release workflow's
 * `prepare-notes` job to populate the GitHub release body that the
 * tauri-action draft release is created with.
 *
 * Usage:
 *   node scripts/release-notes.mjs <tag> [prevTag]
 *
 *   <tag>     The tag being released (vX.Y.Z), or `HEAD` to preview the notes
 *             an upcoming release would get.
 *   [prevTag] Range start override; defaults to the highest semver tag below
 *             <tag> (or the highest overall when <tag> is HEAD).
 *
 * Output: markdown grouped by commit type, one bullet per commit. Lines in a
 * commit BODY that start with `- ` become nested sub-bullets, so a
 * squash-merged PR can enumerate its individual features/fixes without
 * inflating the subject line. Trailers (Co-Authored-By etc.) never match the
 * bullet prefix, so they are dropped automatically.
 */
import { execFileSync } from 'node:child_process';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).replace(/\n+$/, '');
}

function semverParts(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpParts(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const tag = process.argv[2] ?? '';
const isPreview = tag === 'HEAD';
const tagParts = semverParts(tag);
if (!isPreview && !tagParts) {
  console.error('Usage: node scripts/release-notes.mjs <vX.Y.Z|HEAD> [prevTag]');
  process.exit(1);
}

let prev = process.argv[3] ?? '';
if (!prev) {
  const candidates = git('tag', '--list', 'v[0-9]*')
    .split('\n')
    .filter((t) => {
      const p = semverParts(t);
      return p !== null && (isPreview || cmpParts(p, tagParts) < 0);
    })
    .sort((x, y) => cmpParts(semverParts(y), semverParts(x)));
  prev = candidates[0] ?? '';
}

// %x00 record separator + %x01 subject/body separator: both are impossible in
// commit text, so parsing never trips on blank lines inside bodies.
const raw = git(
  'log',
  '--no-merges',
  '--pretty=format:%s%x01%b%x00',
  prev ? `${prev}..${tag}` : tag,
);
const records = raw
  .split('\u0000')
  .map((r) => r.trim())
  .filter(Boolean);

const SECTIONS = [
  { title: 'Features', types: ['feat'] },
  { title: 'Bug fixes', types: ['fix'] },
  { title: 'Performance', types: ['perf'] },
  { title: 'CI & build', types: ['ci', 'build'] },
  { title: 'Maintenance', types: ['refactor', 'chore', 'docs', 'test', 'style', 'revert'] },
];
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/;

/** Body lines starting with `- `/`* ` become nested sub-bullets; subsequent
 *  non-blank lines are wrap continuations and are joined back on. A blank
 *  line closes the current bullet, which also keeps trailers
 *  (Co-Authored-By etc., conventionally preceded by a blank line) out of
 *  the notes. */
function bodyBullets(body) {
  const bullets = [];
  let open = false;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const m = /^[-*]\s+(\S.*)$/.exec(line);
    if (m) {
      bullets.push(m[1]);
      open = true;
    } else if (line === '') {
      open = false;
    } else if (open && bullets.length > 0) {
      bullets[bullets.length - 1] += ` ${line}`;
    }
  }
  return bullets.map((b) => `  - ${b}`);
}

const grouped = new Map(SECTIONS.map((s) => [s.title, []]));
const other = [];
for (const record of records) {
  const [subject = '', body = ''] = record.split('\u0001');
  const subBullets = bodyBullets(body);

  const m = CONVENTIONAL.exec(subject.trim());
  const section = m ? SECTIONS.find((s) => s.types.includes(m[1])) : undefined;
  const bullet = section ? `- ${m[2] ? `**${m[2]}:** ` : ''}${m[3]}` : `- ${subject.trim()}`;
  (section ? grouped.get(section.title) : other).push(bullet, ...subBullets);
}

const out = [];
for (const s of SECTIONS) {
  const items = grouped.get(s.title);
  if (items.length > 0) out.push(`### ${s.title}`, ...items, '');
}
if (other.length > 0) out.push('### Other', ...other, '');
if (out.length === 0) out.push('_No changes since the previous release._', '');

const repo =
  process.env.GITHUB_REPOSITORY ??
  (() => {
    try {
      const url = git('remote', 'get-url', 'origin');
      return /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1] ?? '';
    } catch {
      return '';
    }
  })();
if (repo && prev) {
  out.push(`**Full changelog**: https://github.com/${repo}/compare/${prev}...${tag}`);
}

process.stdout.write(out.join('\n') + '\n');
