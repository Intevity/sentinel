#!/usr/bin/env node
// Poll Apple's Notary API (App Store Connect Notary v2) until every submission
// reaches a terminal state. This runs on a cheap 1x ubuntu runner so the 10x
// macOS build leg never blocks on Apple's notarization queue.
//
// Usage:
//   node scripts/notary-poll.mjs <dir-of-notary-json | submissionId> [...more]
//
// Each <dir> is scanned for *.json files shaped { arch, submissionId, dmg }
// (written by the build leg's "Submit to notary" step). A bare UUID argument is
// treated as a single submission id, which makes local dry-runs trivial:
//   APPLE_API_KEY_PATH=AuthKey.p8 APPLE_API_KEY=<kid> APPLE_API_ISSUER=<iss> \
//     node scripts/notary-poll.mjs <accepted-submission-id>
//
// Auth env (one key source + the two ids):
//   APPLE_API_KEY_CONTENT  base64 of the .p8 (CI secret), OR
//   APPLE_API_KEY_PATH     path to the .p8 on disk (local dry-run)
//   APPLE_API_KEY          key id (kid)
//   APPLE_API_ISSUER       issuer id
//
// Exit 0 when ALL submissions are Accepted; exit 1 on any Invalid/Rejected
// (after printing Apple's developer log) or when the overall timeout elapses.

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
  const subs = collectSubmissions(process.argv.slice(2));
  console.log(`Polling ${subs.length} notarization submission(s):`);
  for (const s of subs) console.log(`  ${s.arch}: ${s.submissionId}`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const accepted = new Set();

  for (;;) {
    for (const s of subs) {
      if (accepted.has(s.submissionId)) continue;
      let status;
      try {
        status = await getStatus(s.submissionId);
      } catch (e) {
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
      return;
    }
    if (Date.now() > deadline) {
      const pending = subs
        .filter((s) => !accepted.has(s.submissionId))
        .map((s) => `${s.arch}:${s.submissionId}`);
      fail(
        `Timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)} min; still pending: ` +
          `${pending.join(', ')}. Re-run notarize-finalize once Apple completes.`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => fail(e.stack || e.message));
