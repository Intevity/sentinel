#!/usr/bin/env node
/**
 * Capture real Anthropic response bodies from the daemon's request-log-db
 * and write them as fixtures under packages/test-harness/src/fixtures/.
 *
 * Usage:
 *   node scripts/record-fixtures.mjs --from-db
 *   node scripts/record-fixtures.mjs --from-db --db ~/.claude-sentinel/request-logs.db
 *
 * The daemon captures request/response pairs in ~/.claude-sentinel/request-logs.db
 * when request logging is enabled. This script picks the most recent successful
 * response for each fixture endpoint and overwrites the hand-authored references.
 *
 * Fixture endpoints (match keys in packages/test-harness/src/fixtures/):
 *   /api/oauth/profile            -> profile.response.json
 *   /api/oauth/usage              -> usage.response.json
 *   /v1/messages (non-SSE 200)    -> messages.response.json
 *   /v1/code/routines/run-budget  -> run-budget.response.json
 *
 * Token exchange response is never captured — access tokens should never
 * be recorded. token.response.json stays hand-authored.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'packages', 'test-harness', 'src', 'fixtures');

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--from-db') args.set('from-db', true);
  if (a === '--db') args.set('db', process.argv[++i]);
  if (a === '--help' || a === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').slice(0, 1200));
    process.exit(0);
  }
}

if (!args.has('from-db')) {
  console.error('Usage: node scripts/record-fixtures.mjs --from-db [--db PATH]');
  process.exit(1);
}

const dbPath = args.get('db') ?? join(homedir(), '.claude-sentinel', 'request-logs.db');
if (!existsSync(dbPath)) {
  console.error(`request-logs.db not found at ${dbPath}`);
  console.error('Run the daemon with request logging enabled to populate it, then retry.');
  process.exit(1);
}

const require = createRequire(import.meta.url);
let Database;
try {
  Database = require('better-sqlite3');
} catch (err) {
  console.error('better-sqlite3 not installed in root; run from packages/daemon:');
  console.error(
    '  pnpm --filter @claude-sentinel/daemon exec node ../../scripts/record-fixtures.mjs --from-db',
  );
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const ENDPOINTS = [
  { path: '/api/oauth/profile', method: 'GET', file: 'profile.response.json' },
  { path: '/api/oauth/usage', method: 'GET', file: 'usage.response.json' },
  { path: '/v1/code/routines/run-budget', method: 'GET', file: 'run-budget.response.json' },
  { path: '/v1/messages', method: 'POST', file: 'messages.response.json', nonSse: true },
];

let recorded = 0;
for (const ep of ENDPOINTS) {
  const stmt = db.prepare(`
    SELECT response_body, response_headers, is_sse, status_code, timestamp
    FROM request_logs
    WHERE url_path LIKE ? AND method = ? AND status_code = 200
    ${ep.nonSse ? 'AND is_sse = 0' : ''}
    AND response_body IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT 1
  `);
  const row = stmt.get(`${ep.path}%`, ep.method);
  if (!row) {
    console.warn(`[skip] no successful ${ep.method} ${ep.path} in log`);
    continue;
  }
  const bodyStr = row.response_body.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(bodyStr);
  } catch (err) {
    console.warn(`[skip] ${ep.path} body is not JSON (${err.message})`);
    continue;
  }
  // Scrub likely-PII fields before writing. Add more as needed.
  const scrubbed = scrub(parsed);
  scrubbed._source = `recorded from ${dbPath} at ${new Date().toISOString()}`;
  scrubbed._matches = `capture of ${ep.method} ${ep.path}`;
  const out = join(FIXTURES_DIR, ep.file);
  writeFileSync(out, JSON.stringify(scrubbed, null, 2) + '\n');
  console.log(`[write] ${ep.file}`);
  recorded++;
}

db.close();
console.log(`\nRecorded ${recorded} fixture(s).`);

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'email' && typeof val === 'string') {
        out[k] = 'test@example.com';
      } else if ((k === 'display_name' || k === 'name') && typeof val === 'string') {
        out[k] = k === 'display_name' ? 'Test User' : 'Test Org';
      } else if (k === 'access_token' || k === 'refresh_token') {
        out[k] = '[scrubbed]';
      } else {
        out[k] = scrub(val);
      }
    }
    return out;
  }
  return v;
}
