#!/usr/bin/env node
/**
 * Wipe the `staging/` update channel between dry-runs (see the staging dry-run runbook).
 *
 * Safe by construction: it ONLY ever operates on the `staging/` prefix — never `stable/` —
 * of the bucket named by the S3_BUCKET repo variable (or --bucket). Optionally also deletes
 * the throwaway draft GitHub release left by a staging run.
 *
 *   node scripts/staging-cleanup.mjs                    # wipe s3://<bucket>/staging/**
 *   node scripts/staging-cleanup.mjs --version v0.5.1   # also delete the draft release v0.5.1
 *   node scripts/staging-cleanup.mjs --bucket my-bucket --dry-run
 *
 * Requires the AWS CLI (configured); --version also needs the gh CLI.
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const dryRun = has('--dry-run');
const version = valueOf('--version');

function run(cmd, cmdArgs) {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  if (dryRun) return;
  execFileSync(cmd, cmdArgs, { stdio: 'inherit' });
}

let bucket = valueOf('--bucket');
if (!bucket) {
  try {
    bucket = execFileSync('gh', ['variable', 'get', 'S3_BUCKET'], { encoding: 'utf8' }).trim();
  } catch {
    console.error(
      'Could not resolve the bucket. Pass --bucket <name> or set the S3_BUCKET repo variable (via gh).',
    );
    process.exit(1);
  }
}

// Hard guard: this tool only ever operates on the staging/ prefix; stable/ is never touched.
const stagingUri = `s3://${bucket}/staging/`;
console.log(`Wiping the staging channel at ${stagingUri}${dryRun ? ' [dry-run]' : ''}`);
run('aws', ['s3', 'rm', stagingUri, '--recursive']);

if (version) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  console.log(`Deleting the throwaway draft release ${tag} (if present)`);
  try {
    run('gh', ['release', 'delete', tag, '--yes']);
  } catch {
    console.log(`  (no release ${tag} to delete)`);
  }
}

console.log('Staging cleanup done.');
