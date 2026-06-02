#!/usr/bin/env node
// Poll Apple's Notary API (App Store Connect Notary v2) until every submission
// reaches a terminal state. This runs on a cheap 1x ubuntu runner so the 10x
// macOS build leg never blocks on Apple's notarization queue.
//
// Usage:
//   node scripts/notary-poll.mjs [--once] <dir-of-notary-json | submissionId> [...more]
//
// Each <dir> is scanned for *.json files shaped { arch, submissionId, dmg }
// (written by the build leg's "Submit to notary" step). A bare UUID argument is
// treated as a single submission id, which makes local dry-runs trivial:
//   APPLE_API_KEY_PATH=AuthKey.p8 APPLE_API_KEY=<kid> APPLE_API_ISSUER=<iss> \
//     node scripts/notary-poll.mjs <accepted-submission-id>
//
// --once: do a single status pass and exit (used by the scheduled notarize-poll
//         workflow). Without it, the script loops every NOTARY_POLL_INTERVAL_MS
//         up to NOTARY_POLL_TIMEOUT_MS (used by the short inline notarize-wait).
//
// Auth env (one key source + the two ids):
//   APPLE_API_KEY_CONTENT  base64 of the .p8 (CI secret), OR
//   APPLE_API_KEY_PATH     path to the .p8 on disk (local dry-run)
//   APPLE_API_KEY          key id (kid)
//   APPLE_API_ISSUER       issuer id
//
// Exit codes (so callers can branch on the outcome):
//   0  all submissions Accepted        -> finalize now
//   2  still pending (In Progress / transient poll error / loop timeout reached)
//                                       -> not done; retry later (hand off to cron)
//   1  Invalid/Rejected or fatal error -> stop and surface the failure

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NOTARY_BASE = 'https://appstoreconnect.apple.com/notary/v2';
const POLL_INTERVAL_MS = Number(process.env.NOTARY_POLL_INTERVAL_MS || 30_000);
const POLL_TIMEOUT_MS = Number(process.env.NOTARY_POLL_TIMEOUT_MS || 90 * 60_000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

// Not done yet, but not an error — caller should retry later (exit 2).
function deferred(msg) {
  console.log(`::notice::${msg}`);
  process.exit(2);
}

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function loadPrivateKeyPem() {
  const content = process.env.APPLE_API_KEY_CONTENT;
  const path = process.env.APPLE_API_KEY_PATH;
  if (content) return Buffer.from(content, 'base64').toString('utf8');
  if (path) return readFileSync(path, 'utf8');
  return fail('Set APPLE_API_KEY_CONTENT (base64 .p8) or APPLE_API_KEY_PATH (file path).');
}

// Mint a fresh ES256 JWT for each request — cheap, and side-steps token expiry
// over a multi-hour poll. dsaEncoding 'ieee-p1363' produces the raw r‖s pair
// JWS requires; Node's default DER encoding would be rejected by Apple.
function mintToken() {
  const keyId = process.env.APPLE_API_KEY;
  const issuer = process.env.APPLE_API_ISSUER;
  if (!keyId || !issuer) fail('APPLE_API_KEY (key id) and APPLE_API_ISSUER are required.');
  const key = createPrivateKey(loadPrivateKeyPem());
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: issuer, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }),
  );
  const signingInput = `${header}.${payload}`;
  const sig = cryptoSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

function collectSubmissions(args) {
  const subs = [];
  for (const arg of args) {
    if (UUID_RE.test(arg)) {
      subs.push({ arch: 'cli', submissionId: arg });
      continue;
    }
    let st;
    try {
      st = statSync(arg);
    } catch {
      fail(`Argument is neither a submission id nor a readable path: ${arg}`);
    }
    const files = st.isDirectory()
      ? readdirSync(arg)
          .filter((f) => f.endsWith('.json'))
          .map((f) => join(arg, f))
      : [arg];
    if (!files.length) fail(`No *.json submission files in ${arg}`);
    for (const f of files) {
      const obj = JSON.parse(readFileSync(f, 'utf8'));
      if (!obj.submissionId) fail(`${f} has no submissionId`);
      subs.push({ arch: obj.arch || f, submissionId: obj.submissionId });
    }
  }
  if (!subs.length) fail('No submissions to poll.');
  return subs;
}

async function apiGet(path) {
  const res = await fetch(`${NOTARY_BASE}${path}`, {
    headers: { Authorization: `Bearer ${mintToken()}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function getStatus(id) {
  const j = await apiGet(`/submissions/${id}`);
  return j?.data?.attributes?.status ?? 'Unknown';
}

async function printLog(id) {
  try {
    const j = await apiGet(`/submissions/${id}/logs`);
    const url = j?.data?.attributes?.developerLogUrl;
    if (url) {
      const log = await fetch(url).then((r) => r.text());
      console.error(`--- notary log for ${id} ---\n${log}\n--- end log ---`);
    }
  } catch (e) {
    console.error(`(could not fetch notary log for ${id}: ${e.message})`);
  }
}

const isAccepted = (s) => /^accepted$/i.test(s);
const isTerminalBad = (s) => /^(invalid|rejected)$/i.test(s);

async function main() {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');
  const subs = collectSubmissions(argv.filter((a) => a !== '--once'));
  console.log(`Polling ${subs.length} notarization submission(s)${once ? ' (single pass)' : ''}:`);
  for (const s of subs) console.log(`  ${s.arch}: ${s.submissionId}`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const accepted = new Set();

  for (;;) {
    let sawError = false;
    for (const s of subs) {
      if (accepted.has(s.submissionId)) continue;
      let status;
      try {
        status = await getStatus(s.submissionId);
      } catch (e) {
        sawError = true;
        console.warn(`  [${s.arch}] poll error (will retry): ${e.message}`);
        continue;
      }
      console.log(`  [${s.arch}] ${s.submissionId} -> ${status}`);
      if (isAccepted(status)) {
        accepted.add(s.submissionId);
      } else if (isTerminalBad(status)) {
        await printLog(s.submissionId);
        fail(`Notarization ${status} for ${s.arch} (${s.submissionId}).`);
      }
    }

    if (accepted.size === subs.length) {
      console.log('All submissions Accepted.');
      return; // exit 0
    }

    const pending = subs
      .filter((s) => !accepted.has(s.submissionId))
      .map((s) => `${s.arch}:${s.submissionId}`)
      .join(', ');

    // --once: single status pass for the scheduled poller; "not done" is exit 2, not failure.
    if (once) {
      deferred(
        `Still pending${sawError ? ' (with transient poll errors)' : ''}: ${pending}. ` +
          `Will retry on the next scheduled poll.`,
      );
    }
    // Loop mode (short inline wait): on timeout, defer to the scheduled poller — not a failure.
    if (Date.now() > deadline) {
      deferred(
        `Not finished within ${Math.round(POLL_TIMEOUT_MS / 60000)} min; still pending: ` +
          `${pending}. Handing off to the scheduled notarize-poll workflow.`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => fail(e.stack || e.message));
