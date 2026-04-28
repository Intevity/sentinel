import type { SecurityKind, SecuritySeverity, FindingProvenance } from '@claude-sentinel/shared';
import { buildSnippet, contextHashOf, hashText, maskSecret } from './redact.js';

export type { FindingProvenance };

/**
 * A single finding produced by a detector. This is the pre-persistence shape —
 * it lacks fields that the scanner adds (account_id, session_id, etc.).
 */
export interface Finding {
  detectorId: string;
  kind: SecurityKind;
  severity: SecuritySeverity;
  confidence: number;
  title: string;
  reason: string;
  matchMask: string;
  matchHash: string;
  contextHash: string;
  snippet: string;
  sourceHint: string | undefined;
  /** Where in the request body this match lived. The scanner uses this
   *  to gate blocking: only `file-read` (secret came from a file Claude
   *  Code read, or a file it's about to Write) and `tool-use` (risky
   *  Bash/Write/WebFetch) can trip the block path. Matches in
   *  conversation / system prompt / tool descriptions persist as
   *  observe-only so chat discussion of synthetic values never 403s
   *  Claude Code. */
  provenance: FindingProvenance;
  details?: Record<string, unknown>;
}

/** Classify a finding's provenance from its sourceHint and kind.
 *  Pure function — used at each detector call site and reused by the
 *  scanner's block-decision gate. See detectors.test.ts for the
 *  mapping table. */
export function classifyProvenance(
  kind: SecurityKind,
  sourceHint: string | undefined,
): FindingProvenance {
  if (
    kind === 'scan_truncated' ||
    kind === 'scan_skipped_encoding' ||
    kind === 'scan_deferred_oversized'
  )
    return 'telemetry';
  if (!sourceHint) return 'conversation';
  // POSIX absolute path, tilde-prefixed home path, or Windows drive.
  if (/^\//.test(sourceHint) || /^~\//.test(sourceHint) || /^[A-Za-z]:\\/.test(sourceHint)) {
    return 'file-read';
  }
  if (sourceHint.startsWith('tool_use[')) return 'tool-use';
  if (sourceHint === 'system' || /^system\[/.test(sourceHint) || /^tools\[/.test(sourceHint)) {
    return 'system-prompt';
  }
  return 'conversation';
}

/** Per-detector flag bundle used to gate which categories fire. */
export interface DetectorOptions {
  scanSecrets: boolean;
  scanInjection: boolean;
  scanToolUse: boolean;
}

// ─── Allowlist ────────────────────────────────────────────────────────────

/** Drop a finding entirely when its sourceHint path looks like a test or
 *  example file. These are the highest-value false-positive filters. */
const ALLOWLIST_PATH_PATTERNS: RegExp[] = [
  /\/__fixtures__\//,
  /\/__mocks__\//,
  /\/(test|tests|spec|specs|__tests__)\//,
  /\.(test|spec)\.[a-z]+$/i,
  /\.env\.(example|sample|test|template)$/i,
  /(^|\/)\.env\.example$/i,
  /example[\\/]/i,
];

/** Surrounding-context words that strongly suggest a harmless fixture. Case
 *  insensitive, substring match. `redacted` is intentionally absent here —
 *  our own `[REDACTED:*]` marker is handled more precisely by
 *  computeConfidenceDrop() as a confidence reduction, so the regex-based
 *  detectors still fire but at lower severity. */
const ALLOWLIST_CONTEXT_WORDS = [
  'example',
  'fake',
  'placeholder',
  'dummy',
  'your_key_here',
  'sample',
  'yourkeyhere',
];

/** Well-known documented example values that should never fire. */
const KNOWN_EXAMPLE_VALUES = new Set([
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  // jwt.io demo token: appears in countless tutorials, blog posts, and
  // copy-pasted examples. Suppressing it preserves a lower FP rate while
  // genuine JWTs (with real cryptographic body parts) still fire.
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
]);

function isAllowlistedPath(sourceHint: string | undefined): boolean {
  if (!sourceHint) return false;
  return ALLOWLIST_PATH_PATTERNS.some((re) => re.test(sourceHint));
}

function hasAllowlistedContext(fullText: string, matchStart: number, matchEnd: number): boolean {
  const windowStart = Math.max(0, matchStart - 40);
  const windowEnd = Math.min(fullText.length, matchEnd + 40);
  const ctx = fullText.slice(windowStart, windowEnd).toLowerCase();
  return ALLOWLIST_CONTEXT_WORDS.some((w) => ctx.includes(w));
}

function isKnownExample(match: string): boolean {
  return KNOWN_EXAMPLE_VALUES.has(match);
}

// ─── Context-aware confidence drops ──────────────────────────────────────

/** Signals the match is inside code/test/docs rather than a credential
 *  assignment. Each matched marker drops confidence; the total drop is
 *  capped so genuine high-signal matches stay above the block threshold.
 *
 *  Checked inside a ±200 char window — wider than the 40-char allowlist
 *  window so we catch `describe(` several lines above and `expect(`
 *  several lines below an in-test string. */
const CONTEXT_MARKERS: Array<{ pattern: RegExp; drop: number; label: string }> = [
  // Test framework markers. Vitest/Jest syntax is diagnostic enough on its
  // own; if any of these appear near the match, it's almost certainly a
  // test fixture.
  {
    pattern: /\b(describe|it|test|expect|beforeEach|afterEach|beforeAll|afterAll)\s*\(/i,
    drop: 0.35,
    label: 'test framework marker',
  },
  { pattern: /\bvi\.(fn|mock|spyOn|stubGlobal)\s*\(/i, drop: 0.35, label: 'vitest mock marker' },
  // Our own redaction marker bleeding back in — if Claude Code is reading
  // our source it'll encounter `[REDACTED:secret]` as literal text inside
  // a snippet, alongside whatever real-looking placeholder is in the test.
  { pattern: /\[REDACTED:[a-z_]+\]/i, drop: 0.4, label: 'sentinel redaction marker' },
  // Markdown code fence (triple backtick) within the context window is a
  // strong signal the match is being shown inside a doc snippet.
  { pattern: /```/, drop: 0.25, label: 'markdown code fence' },
  // Inline backtick code span wrapping the match itself.
  { pattern: /`[^`\n]{0,20}$/, drop: 0.15, label: 'inline code span' },
  // Documentation section headers near the match (e.g. "## Secret detectors").
  { pattern: /^#{1,6}\s/m, drop: 0.2, label: 'markdown heading' },
  // Comments introducing an example.
  {
    pattern: /(?:\/\/|#|\*)\s*(example|sample|e\.?g\.?:|todo|fixme)/i,
    drop: 0.25,
    label: 'example comment',
  },
];

/** Placeholder-looking secrets: sequential runs, repeated chars, obvious
 *  fillers. Applied to the matched text itself rather than its context. */
const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; drop: number; label: string }> = [
  // Sequential digit runs like "1234567890" or "12345".
  { pattern: /(?:0123|1234|2345|3456|4567|5678|6789|7890)/, drop: 0.3, label: 'sequential digits' },
  // Sequential letter runs.
  {
    pattern: /(?:abcd|bcde|cdef|defg|efgh|fghi|ghij|hijk)/i,
    drop: 0.3,
    label: 'sequential letters',
  },
  // Repeated single char ≥4 times (aaaa, 0000, zzzz).
  { pattern: /([a-z0-9])\1{3,}/i, drop: 0.25, label: 'repeated character' },
  // Contains explicit placeholder words anywhere in the body.
  {
    pattern: /(example|sample|dummy|fake|placeholder|test[_-]?key)/i,
    drop: 0.3,
    label: 'placeholder keyword in body',
  },
];

const MAX_CONTEXT_WINDOW = 200;
const CONTEXT_DROP_CAP = 0.4;

/** Inspect the ±200 char window + matched text and return a total
 *  confidence drop plus an explanation string. Never drops below 0. */
function computeConfidenceDrop(
  fullText: string,
  matchStart: number,
  matchEnd: number,
  matched: string,
): { drop: number; reasons: string[] } {
  const windowStart = Math.max(0, matchStart - MAX_CONTEXT_WINDOW);
  const windowEnd = Math.min(fullText.length, matchEnd + MAX_CONTEXT_WINDOW);
  const ctx = fullText.slice(windowStart, windowEnd);

  let drop = 0;
  const reasons: string[] = [];

  for (const { pattern, drop: d, label } of CONTEXT_MARKERS) {
    if (pattern.test(ctx)) {
      drop += d;
      reasons.push(label);
    }
  }
  for (const { pattern, drop: d, label } of PLACEHOLDER_PATTERNS) {
    if (pattern.test(matched)) {
      drop += d;
      reasons.push(label);
    }
  }

  if (drop > CONTEXT_DROP_CAP) drop = CONTEXT_DROP_CAP;
  return { drop, reasons };
}

// ─── Entropy helper ───────────────────────────────────────────────────────

/** Shannon entropy in bits/char. Used by the keyword-gated detectors and
 *  the .env-file line scanner to filter human-readable values out of the
 *  long tail of "looks like 32 hex chars near the word api_key" matches.
 *
 *  Random base64 ≈ 5.7 bits/char; lowercase English ≈ 4.0; "aaaa…" → 0.
 *  Threshold of 4.5 picks up real secrets while letting prose through. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// ─── Secret detectors ─────────────────────────────────────────────────────

interface SecretRule {
  id: string;
  title: string;
  reason: string;
  regex: RegExp;
  confidence: number;
  /** Optional explicit base severity. Used when the spec assigns a
   *  severity that doesn't line up with confidence-only thresholds
   *  (e.g., mailgun MEDIUM at confidence 0.85, ssh-public-key LOW at
   *  0.6). When omitted, severity is derived from adjusted confidence
   *  via the legacy thresholds (≥0.85=high, ≥0.6=medium, else low). */
  severity?: SecuritySeverity;
}

const SECRET_RULES: SecretRule[] = [
  {
    id: 'aws-access-key',
    title: 'AWS access key',
    reason: 'AKIA/ASIA prefix with 16 base32 characters',
    confidence: 0.95,
    regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github-ghp',
    title: 'GitHub personal token',
    reason: 'ghp_ prefix with 36 alphanumerics',
    confidence: 0.95,
    regex: /\bghp_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'github-pat',
    title: 'GitHub fine-grained PAT',
    reason: 'github_pat_ prefix with expected body',
    confidence: 0.95,
    regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
  },
  {
    id: 'github-oauth',
    title: 'GitHub OAuth token',
    reason: 'gho_/ghu_/ghs_/ghr_ prefix',
    confidence: 0.9,
    regex: /\bgh[ousr]_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'anthropic-key',
    title: 'Anthropic API key',
    reason: 'sk-ant-api03 prefix',
    confidence: 0.95,
    regex: /\bsk-ant-api03-[A-Za-z0-9_-]{80,}\b/g,
  },
  {
    id: 'openai-project',
    title: 'OpenAI project API key',
    reason: 'sk-proj- prefix',
    confidence: 0.9,
    regex: /\bsk-proj-[A-Za-z0-9_-]{40,}\b/g,
  },
  {
    id: 'openai-legacy',
    title: 'OpenAI API key (legacy)',
    reason: 'sk- prefix with long alphanumeric body',
    confidence: 0.75,
    regex: /\bsk-[A-Za-z0-9]{40,}\b/g,
  },
  {
    id: 'slack-token',
    title: 'Slack token',
    reason: 'xox[bparps] prefix',
    confidence: 0.9,
    regex: /\bxox[baprs]-[0-9]{10,}-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    id: 'stripe-live-secret',
    title: 'Stripe live secret key',
    reason: 'sk_live_ prefix',
    confidence: 0.95,
    regex: /\bsk_live_[A-Za-z0-9]{24,}\b/g,
  },
  {
    id: 'stripe-live-restricted',
    title: 'Stripe live restricted key',
    reason: 'rk_live_ prefix',
    confidence: 0.95,
    regex: /\brk_live_[A-Za-z0-9]{24,}\b/g,
  },
  {
    id: 'google-api-key',
    title: 'Google API key',
    reason: 'AIza prefix with 35-char body',
    confidence: 0.9,
    regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
  },
  {
    id: 'hf-token',
    title: 'HuggingFace token',
    reason: 'hf_ prefix with 34+ alphanumerics',
    confidence: 0.85,
    regex: /\bhf_[A-Za-z0-9]{34,}\b/g,
  },
  {
    id: 'npm-token',
    title: 'npm access token',
    reason: 'npm_ prefix with 36 alphanumerics',
    confidence: 0.9,
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'npmrc-auth',
    title: 'npmrc _authToken',
    reason: '_authToken= in registry config line',
    confidence: 0.85,
    regex: /\/\/registry\.npmjs\.org\/:_authToken=[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'google-oauth-refresh',
    title: 'Google OAuth refresh token',
    reason: '1// prefix with 43+ URL-safe chars',
    confidence: 0.75,
    regex: /\b1\/\/0[A-Za-z0-9_-]{40,}\b/g,
  },
  // ─── Sprint 3: database connection strings with embedded passwords ──
  {
    id: 'postgres-conn-string',
    title: 'Postgres connection string with password',
    reason: 'postgres(ql)://user:password@host shape',
    confidence: 0.95,
    regex: /\bpostgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@[^/\s]+/g,
  },
  {
    id: 'mysql-conn-string',
    title: 'MySQL connection string with password',
    reason: 'mysql://user:password@host shape',
    confidence: 0.95,
    regex: /\bmysql:\/\/[^:\s/]+:[^@\s]+@[^/\s]+/g,
  },
  {
    id: 'mongodb-conn-string',
    title: 'MongoDB connection string with password',
    reason: 'mongodb(+srv)://user:password@host shape',
    confidence: 0.95,
    regex: /\bmongodb(?:\+srv)?:\/\/[^:\s/]+:[^@\s]+@[^/\s]+/g,
  },
  {
    id: 'redis-conn-string',
    title: 'Redis connection string with password',
    reason: 'redis://[user:]password@host shape',
    confidence: 0.9,
    regex: /\bredis:\/\/(?:[^:@\s/]+:)?[^@\s/]+@[^/\s]+/g,
  },
  {
    id: 'amqp-conn-string',
    title: 'AMQP connection string with password',
    reason: 'amqp://user:password@host shape',
    confidence: 0.85,
    severity: 'medium',
    regex: /\bamqp:\/\/[^:\s/]+:[^@\s]+@[^/\s]+/g,
  },
  {
    id: 'jdbc-conn-string',
    title: 'JDBC connection string with credentials',
    reason: 'jdbc:<driver>://host?...user=...|password=... shape',
    confidence: 0.85,
    severity: 'medium',
    // Anchor the alternative branch with `(?:^|&)` so the `[^?\s]*?`
    // span doesn't collide with `(?:.*&)?` from the original spec —
    // that combination was the textbook catastrophic-backtracking shape
    // (Sprint 10 ReDoS class). This rewrite keeps linear time.
    regex: /\bjdbc:[a-z]+:\/\/[^?\s]+\?[^?\s]*?(?:^|&)(?:user|password)=[^&\s]+/g,
  },
  // ─── Sprint 3: JWT ───────────────────────────────────────────────────
  {
    id: 'jwt-token',
    title: 'JWT token',
    reason: 'eyJ.eyJ.* base64url triple — JOSE header + payload + signature',
    confidence: 0.85,
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // ─── Sprint 3: Azure ─────────────────────────────────────────────────
  {
    id: 'azure-storage-key',
    title: 'Azure storage account key',
    reason: 'DefaultEndpointsProtocol=…AccountKey=…; connection-string shape',
    confidence: 0.95,
    regex: /DefaultEndpointsProtocol=https?;AccountName=[a-z0-9]+;AccountKey=[A-Za-z0-9+/=]{60,};/g,
  },
  {
    id: 'azure-sas-url',
    title: 'Azure SAS URL',
    reason: '*.core.windows.net SAS URL with sig= parameter',
    confidence: 0.85,
    regex:
      /https:\/\/[a-z0-9]+\.(?:blob|queue|table|file)\.core\.windows\.net\/[^?\s]+\?[^"'\s]*sig=[^"'\s&]+/g,
  },
  // ─── Sprint 3: Discord ───────────────────────────────────────────────
  {
    id: 'discord-bot-token',
    title: 'Discord bot token',
    reason: 'Discord bot token base64-encoded user-id . timestamp . hmac shape',
    confidence: 0.9,
    regex:
      /\b(?:Bot\s+)?(?:MT|Mz|N[T-Z]|O[T-W])[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
  },
  {
    id: 'discord-webhook-url',
    title: 'Discord webhook URL',
    reason: 'discord.com/api/webhooks/<id>/<token> shape',
    confidence: 0.85,
    regex: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  },
  // ─── Sprint 3: SendGrid / Mailgun ───────────────────────────────────
  {
    id: 'sendgrid-api-key',
    title: 'SendGrid API key',
    reason: 'SG.<22>.<43> dotted-base64 shape',
    confidence: 0.95,
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  },
  {
    id: 'mailgun-api-key',
    title: 'Mailgun API key',
    reason: 'key- prefix with 32 hex characters',
    confidence: 0.85,
    severity: 'medium',
    regex: /\bkey-[a-f0-9]{32}\b/g,
  },
  // ─── Sprint 3: Cloudflare ────────────────────────────────────────────
  {
    id: 'cloudflare-api-token',
    title: 'Cloudflare API token',
    reason: 'v1.0-<32hex>-<120+hex> shape',
    confidence: 0.95,
    regex: /\bv1\.0-[a-f0-9]{32}-[a-f0-9]{120,}\b/g,
  },
  // ─── Sprint 3: SSH public key (LOW, mostly informational) ────────────
  {
    id: 'ssh-public-key',
    title: 'SSH public key',
    reason: 'ssh-<algo> AAAA<base64> shape — not a secret but useful for fingerprinting',
    confidence: 0.6,
    severity: 'low',
    regex: /\bssh-(?:rsa|ed25519|dss|ecdsa-sha2-[a-z0-9-]+)\s+AAAA[A-Za-z0-9+/=]{100,}\b/g,
  },
  // ─── Sprint 3: Google service-account JSON (correlated regex) ────────
  // Lookahead-based form: requires both `"type":"service_account"` AND
  // `"private_key":"-----BEGIN` within the same {} block. Anchored
  // with `\{` first so V8 only runs the lookaheads at brace
  // boundaries — keeps scan-time on prose-heavy bodies near linear
  // (otherwise lookaheads would run at every position over 16MB
  // payloads, blowing the security-scanner microbenchmark).
  {
    id: 'google-service-account-json',
    title: 'Google service account JSON',
    reason: '{"type":"service_account",…,"private_key":"-----BEGIN…"} structural shape',
    confidence: 0.95,
    regex:
      /\{(?=[\s\S]{0,4096}"type"\s*:\s*"service_account")(?=[\s\S]{0,4096}"private_key"\s*:\s*"-----BEGIN)[\s\S]{0,4096}\}/g,
  },
];

/** Private-key PEM blocks get a dedicated scan that distinguishes a real
 *  key (header + enough base64 body chars in the window after) from a
 *  documentation mention of the header alone. Added separately from
 *  SECRET_RULES so the body-validation step can gate severity. */
const PRIVATE_KEY_HEADER_REGEX = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g;

/** Minimum base64 body characters required after the BEGIN marker to
 *  rate the finding as HIGH severity. A real 2048-bit RSA key's base64
 *  body is ~1700 chars; even a small key has hundreds. Below this, the
 *  header is almost certainly documentation. */
const PRIVATE_KEY_BODY_MIN_CHARS = 200;

/** Window after the BEGIN header in which we look for body chars. */
const PRIVATE_KEY_BODY_WINDOW = 500;

/** Count base64-alphabet characters (excluding whitespace and the `=`
 *  padding) inside a string. Used to distinguish a real key body from
 *  a stretch of prose. */
function countBase64BodyChars(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (
      (ch >= 48 && ch <= 57) || // 0-9
      (ch >= 65 && ch <= 90) || // A-Z
      (ch >= 97 && ch <= 122) || // a-z
      ch === 43 ||
      ch === 47 // + /
    )
      n++;
  }
  return n;
}

function scanPrivateKeyBlocks(fullText: string, sourceHint: string | undefined): Finding[] {
  if (isAllowlistedPath(sourceHint)) return [];
  const findings: Finding[] = [];
  PRIVATE_KEY_HEADER_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRIVATE_KEY_HEADER_REGEX.exec(fullText)) !== null) {
    const match = m[0];
    const start = m.index;
    const end = start + match.length;
    if (hasAllowlistedContext(fullText, start, end)) continue;

    const bodyWindow = fullText.slice(
      end,
      Math.min(fullText.length, end + PRIVATE_KEY_BODY_WINDOW),
    );
    const bodyChars = countBase64BodyChars(bodyWindow);
    const hasBody = bodyChars >= PRIVATE_KEY_BODY_MIN_CHARS;

    const { drop, reasons } = computeConfidenceDrop(fullText, start, end, match);
    const baseConfidence = hasBody ? 0.95 : 0.4;
    const adjustedConfidence = Math.max(0.1, baseConfidence - drop);
    const reasonBase = hasBody
      ? 'BEGIN PRIVATE KEY header followed by key body'
      : 'BEGIN PRIVATE KEY header without key body (likely documentation)';
    const adjustedReason =
      reasons.length > 0 ? `${reasonBase} (confidence reduced: ${reasons.join(', ')})` : reasonBase;
    const severity: SecuritySeverity =
      hasBody && adjustedConfidence >= 0.85 ? 'high' : adjustedConfidence >= 0.6 ? 'medium' : 'low';

    findings.push({
      detectorId: hasBody ? 'private-key-block' : 'private-key-header-doc',
      kind: 'secret',
      severity,
      confidence: adjustedConfidence,
      title: hasBody ? 'Private key PEM block' : 'Private key header (no body)',
      reason: adjustedReason,
      matchMask: maskSecret(match),
      matchHash: hashText(match + String(hasBody)),
      contextHash: contextHashOf(fullText, start, end),
      snippet: buildSnippet({ fullText, matchStart: start, matchEnd: end, kind: 'secret' }),
      sourceHint,
      provenance: classifyProvenance('secret', sourceHint),
      details: { bodyChars, hasBody },
    });
  }
  return findings;
}

function scanSecretsIn(fullText: string, sourceHint: string | undefined): Finding[] {
  if (isAllowlistedPath(sourceHint)) return [];
  const findings: Finding[] = [];
  for (const rule of SECRET_RULES) {
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(fullText)) !== null) {
      const match = m[0];
      if (isKnownExample(match)) continue;
      const start = m.index;
      const end = start + match.length;
      if (hasAllowlistedContext(fullText, start, end)) continue;

      const { drop, reasons } = computeConfidenceDrop(fullText, start, end, match);
      const adjustedConfidence = Math.max(0.1, rule.confidence - drop);
      const adjustedReason =
        reasons.length > 0
          ? `${rule.reason} (confidence reduced: ${reasons.join(', ')})`
          : rule.reason;
      // Severity reflects the adjusted confidence so block-mode + OS
      // notifications treat a dropped finding the same as a legitimately
      // medium one. When the rule pins an explicit base severity (e.g.,
      // mailgun MEDIUM at confidence 0.85), use BashRule's degrade
      // ladder: keep the base severity at full confidence, demote one
      // step on a moderate drop, demote to LOW on a heavy drop.
      // For rules without explicit severity, every existing detector's
      // base confidence is >= 0.75 → 'medium' is the floor, no LOW
      // base severity to worry about.
      const baseSeverity: SecuritySeverity =
        rule.severity ?? (rule.confidence >= 0.85 ? 'high' : 'medium');
      const severity: SecuritySeverity =
        adjustedConfidence >= 0.85
          ? baseSeverity
          : adjustedConfidence >= 0.6
            ? baseSeverity === 'high'
              ? 'medium'
              : baseSeverity
            : 'low';

      findings.push({
        detectorId: rule.id,
        kind: 'secret',
        severity,
        confidence: adjustedConfidence,
        title: rule.title,
        reason: adjustedReason,
        matchMask: maskSecret(match),
        matchHash: hashText(match),
        contextHash: contextHashOf(fullText, start, end),
        snippet: buildSnippet({ fullText, matchStart: start, matchEnd: end, kind: 'secret' }),
        sourceHint,
        provenance: classifyProvenance('secret', sourceHint),
        details: { matchStart: start, matchEnd: end },
      });
    }
  }
  // Sprint 3: keyword-gated detectors run after SECRET_RULES so
  // span-dedup can drop generic-high-entropy findings that overlap a
  // specific provider-shape finding (postgres connection string also
  // matches generic-high-entropy near `password=…`).
  findings.push(...scanKeywordGated(fullText, sourceHint));
  return dedupOverlapping(findings);
}

// ─── Span dedup ───────────────────────────────────────────────────────────

/** Drop generic-high-entropy findings that overlap a more-specific
 *  provider-shape finding by ≥50% of either span. The specific finding
 *  always wins. Span coordinates are read from `details.matchStart` /
 *  `details.matchEnd` populated at finding-creation time. */
function dedupOverlapping(findings: Finding[]): Finding[] {
  if (findings.length < 2) return findings;
  // Caller invariant: every Finding produced by SECRET_RULES,
  // KEYWORD_GATED_RULES, and scanKeywordGated populates
  // `details.matchStart` / `details.matchEnd` with non-negative
  // numbers and matchEnd > matchStart. We type-assert to one branch
  // per access (instead of three nested guards) so coverage reflects
  // real behavior, not defensive dead branches.
  const spans = findings.map(
    (f) => f.details as { matchStart: number; matchEnd: number } | undefined,
  );
  const dropped = new Set<number>();
  for (let i = 0; i < findings.length; i++) {
    if (findings[i]!.detectorId !== 'generic-high-entropy-token') continue;
    const a = spans[i]!;
    const aLen = a.matchEnd - a.matchStart;
    for (let j = 0; j < findings.length; j++) {
      if (i === j || findings[j]!.detectorId === 'generic-high-entropy-token') continue;
      const b = spans[j]!;
      const bLen = b.matchEnd - b.matchStart;
      const overlap = Math.max(
        0,
        Math.min(a.matchEnd, b.matchEnd) - Math.max(a.matchStart, b.matchStart),
      );
      if (overlap / aLen >= 0.5 || overlap / bLen >= 0.5) {
        dropped.add(i);
        break;
      }
    }
  }
  if (dropped.size === 0) return findings;
  return findings.filter((_, i) => !dropped.has(i));
}

// ─── Keyword-gated compound detectors ────────────────────────────────────

interface KeywordGatedRule {
  id: string;
  title: string;
  reason: string;
  /** Primary anchor regex — the easy-to-find half (the SID for Twilio,
   *  the literal keyword for Datadog/PagerDuty/generic). */
  anchorRegex: RegExp;
  /** Char window around each anchor in which to look for the candidate. */
  windowChars: number;
  /** Shape the secret value must match within the window. */
  candidateRegex: RegExp;
  /** Optional gate (entropy threshold etc.) applied to the candidate. */
  gate?: (candidate: string) => boolean;
  confidence: number;
  severity: SecuritySeverity;
  /** When set, AND when both anchor and a window-candidate are present,
   *  upgrade to this confidence/severity. Used by Twilio for the
   *  SID-paired-with-auth-token shape. When omitted, the anchor alone
   *  fires only if a candidate is in-window (falls back to the
   *  candidate shape filter). */
  paired?: { confidence: number; severity: SecuritySeverity; titleSuffix: string };
  /** When true, the anchor alone fires (without a paired candidate)
   *  using the base confidence/severity. Twilio uses this so a SID
   *  surfaces a MEDIUM event even without an adjacent auth token. */
  fireOnAnchorAlone?: boolean;
}

const KEYWORD_GATED_RULES: KeywordGatedRule[] = [
  // Twilio: SID is the anchor (very specific 34-char prefix). An
  // adjacent 32-hex auth-token-shape upgrades to HIGH; SID alone
  // surfaces as MEDIUM.
  {
    id: 'twilio-credentials',
    title: 'Twilio credentials',
    reason: 'AC-prefixed 32-hex Twilio SID',
    anchorRegex: /\bAC[0-9a-f]{32}\b/g,
    windowChars: 200,
    candidateRegex: /\b[a-f0-9]{32}\b/g,
    confidence: 0.7,
    severity: 'medium',
    paired: {
      confidence: 0.9,
      severity: 'high',
      titleSuffix: ' (paired with auth-token shape)',
    },
    fireOnAnchorAlone: true,
  },
  {
    id: 'datadog-api-key',
    title: 'Datadog API key',
    reason: '32-hex string adjacent to dd_api_key/datadog keyword',
    anchorRegex: /\b(?:dd[_-]?api[_-]?key|datadog)\b/gi,
    windowChars: 80,
    candidateRegex: /\b[a-f0-9]{32}\b/g,
    confidence: 0.7,
    severity: 'medium',
  },
  {
    id: 'pagerduty-token',
    title: 'PagerDuty token',
    reason: '20-char token adjacent to pagerduty/pd_token keyword',
    anchorRegex: /\b(?:pagerduty|pd[_-]?token)\b/gi,
    windowChars: 80,
    candidateRegex: /\b[a-zA-Z0-9_-]{20}\b/g,
    confidence: 0.65,
    severity: 'low',
  },
  // Generic: any 32+ char alnum-ish token with high Shannon entropy
  // within 80 chars of a credential-keyword. Confidence-gated so it
  // only surfaces MEDIUM, never HIGH; specific provider rules win
  // via span dedup.
  {
    id: 'generic-high-entropy-token',
    title: 'High-entropy token near credential keyword',
    reason: 'Long alphanumeric string with high Shannon entropy near api_key/secret/token/etc.',
    anchorRegex: /\b(?:api[_-]?key|secret|token|password|credential|auth)\b/gi,
    windowChars: 80,
    candidateRegex: /\b[A-Za-z0-9_-]{32,}\b/g,
    gate: (c) => shannonEntropy(c) >= 4.5,
    confidence: 0.7,
    severity: 'medium',
  },
];

function scanKeywordGated(fullText: string, sourceHint: string | undefined): Finding[] {
  if (isAllowlistedPath(sourceHint)) return [];
  const findings: Finding[] = [];
  for (const rule of KEYWORD_GATED_RULES) {
    rule.anchorRegex.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = rule.anchorRegex.exec(fullText)) !== null) {
      const anchorStart = am.index;
      const anchorEnd = anchorStart + am[0].length;
      const winStart = Math.max(0, anchorStart - rule.windowChars);
      const winEnd = Math.min(fullText.length, anchorEnd + rule.windowChars);
      const window = fullText.slice(winStart, winEnd);

      // Find candidates inside the window. Each candidate's index is
      // relative to the window slice; convert back to fullText coords.
      const candidates: Array<{ value: string; start: number; end: number }> = [];
      const candidateRe = new RegExp(rule.candidateRegex.source, rule.candidateRegex.flags);
      candidateRe.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = candidateRe.exec(window)) !== null) {
        const value = cm[0];
        const cStart = winStart + cm.index;
        const cEnd = cStart + value.length;
        // Skip the anchor itself when it would also match the candidate
        // shape (e.g., Twilio SID matches `[a-f0-9]{32}` after the AC).
        if (cStart >= anchorStart && cEnd <= anchorEnd) continue;
        if (rule.gate && !rule.gate(value)) continue;
        candidates.push({ value, start: cStart, end: cEnd });
      }

      // Decide what to emit. With `paired` and at least one candidate:
      // upgrade. With `fireOnAnchorAlone` and no candidate: emit the
      // anchor span at base severity. Otherwise, emit one finding per
      // candidate at base severity.
      const firstCandidate = candidates[0];
      if (rule.paired && firstCandidate) {
        const finalEnd = firstCandidate.end > anchorEnd ? firstCandidate.end : anchorEnd;
        const matched = fullText.slice(anchorStart, finalEnd);
        emitKeywordGatedFinding(
          findings,
          fullText,
          sourceHint,
          rule,
          matched,
          anchorStart,
          finalEnd,
          /* paired */ true,
        );
        continue;
      }
      if (candidates.length > 0) {
        for (const c of candidates) {
          emitKeywordGatedFinding(
            findings,
            fullText,
            sourceHint,
            rule,
            c.value,
            c.start,
            c.end,
            /* paired */ false,
          );
        }
        continue;
      }
      if (rule.fireOnAnchorAlone) {
        emitKeywordGatedFinding(
          findings,
          fullText,
          sourceHint,
          rule,
          am[0],
          anchorStart,
          anchorEnd,
          /* paired */ false,
        );
      }
    }
  }
  return findings;
}

function emitKeywordGatedFinding(
  out: Finding[],
  fullText: string,
  sourceHint: string | undefined,
  rule: KeywordGatedRule,
  matched: string,
  start: number,
  end: number,
  paired: boolean,
): void {
  if (hasAllowlistedContext(fullText, start, end)) return;
  // Caller invariant: `paired` is only true when this rule has
  // `rule.paired` set (the scanKeywordGated dispatch enforces this).
  // Type-assert with `!` so the reader sees one branch, not two.
  const baseConfidence = paired ? rule.paired!.confidence : rule.confidence;
  const baseSeverity = paired ? rule.paired!.severity : rule.severity;
  const { drop, reasons } = computeConfidenceDrop(fullText, start, end, matched);
  const adjustedConfidence = Math.max(0.1, baseConfidence - drop);
  const severity: SecuritySeverity =
    adjustedConfidence >= 0.85
      ? baseSeverity
      : adjustedConfidence >= 0.6
        ? baseSeverity === 'high'
          ? 'medium'
          : baseSeverity
        : 'low';
  const title = paired ? rule.title + rule.paired!.titleSuffix : rule.title;
  const reasonBase = rule.reason;
  const adjustedReason =
    reasons.length > 0 ? `${reasonBase} (confidence reduced: ${reasons.join(', ')})` : reasonBase;
  out.push({
    detectorId: rule.id,
    kind: 'secret',
    severity,
    confidence: adjustedConfidence,
    title,
    reason: adjustedReason,
    matchMask: maskSecret(matched),
    matchHash: hashText(matched),
    contextHash: contextHashOf(fullText, start, end),
    snippet: buildSnippet({ fullText, matchStart: start, matchEnd: end, kind: 'secret' }),
    sourceHint,
    provenance: classifyProvenance('secret', sourceHint),
    details: { matchStart: start, matchEnd: end, paired },
  });
}

// ─── .env-file line scanner (provenance-aware) ───────────────────────────

/** Match `.env`, `.env.local`, `.env.production`, `.envrc`, `prod.env`. */
const ENV_FILE_PATH_REGEX = /(?:^|\/)(?:\.env(?:\.[a-z][a-z0-9._-]*)?|\.envrc|[^/]+\.env)$/i;

function isEnvFilePath(sourceHint: string | undefined): boolean {
  if (!sourceHint) return false;
  return ENV_FILE_PATH_REGEX.test(sourceHint);
}

/** Scan a Read-tool_result body whose source is a `.env` file. Each
 *  `KEY=value` line whose value clears the entropy threshold raises a
 *  MEDIUM `env-file-line-secret` finding. The other detectors still run
 *  in parallel against the same text — this catches the long tail that
 *  none of the provider-shape detectors would identify. */
function scanEnvFileLines(text: string, sourceHint: string): Finding[] {
  const findings: Finding[] = [];
  const lineRegex = /^([A-Z_][A-Z0-9_]*)=([^\n]{20,})$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(text)) !== null) {
    // m[1] and m[2] are guaranteed by the regex: both groups are
    // mandatory and non-empty for a successful match.
    const varName = m[1] as string;
    const value = m[2] as string;
    if (shannonEntropy(value) < 4.0) continue;
    const valueStart = m.index + varName.length + 1;
    const valueEnd = valueStart + value.length;
    if (hasAllowlistedContext(text, valueStart, valueEnd)) continue;
    const { drop, reasons } = computeConfidenceDrop(text, valueStart, valueEnd, value);
    // Base confidence is fixed at 0.7 (entropy gate already filters
    // human-readable values), so the severity space is only
    // {medium, low} — no need for the high-tier branch.
    const baseConfidence = 0.7;
    const adjustedConfidence = Math.max(0.1, baseConfidence - drop);
    const severity: SecuritySeverity = adjustedConfidence >= 0.6 ? 'medium' : 'low';
    const reasonBase = `High-entropy value on line ${varName}=… in .env-shaped file`;
    const adjustedReason =
      reasons.length > 0 ? `${reasonBase} (confidence reduced: ${reasons.join(', ')})` : reasonBase;
    findings.push({
      detectorId: 'env-file-line-secret',
      kind: 'secret',
      severity,
      confidence: adjustedConfidence,
      title: 'Likely secret on .env line',
      reason: adjustedReason,
      matchMask: maskSecret(value),
      matchHash: hashText(value),
      contextHash: contextHashOf(text, valueStart, valueEnd),
      snippet: buildSnippet({
        fullText: text,
        matchStart: valueStart,
        matchEnd: valueEnd,
        kind: 'secret',
      }),
      sourceHint,
      provenance: classifyProvenance('secret', sourceHint),
      details: { matchStart: valueStart, matchEnd: valueEnd, varName },
    });
  }
  return findings;
}

// ─── Prompt-injection heuristics ──────────────────────────────────────────

/** Unicode tag characters (U+E0000..U+E007F) are a well-known channel for
 *  hidden instructions — no legitimate reason for a human-typed prompt to
 *  contain them. Very high confidence. */
const UNICODE_TAG_REGEX = /[\u{E0000}-\u{E007F}]/gu;

interface InjectionRule {
  id: string;
  title: string;
  reason: string;
  regex: RegExp;
  confidence: number;
  /** When true, this rule fires even if the user has disabled the
   *  `scanInjection` category — for signals that are too specific to be
   *  false positives. */
  alwaysOn?: boolean;
}

const INJECTION_RULES: InjectionRule[] = [
  {
    id: 'unicode-tag-chars',
    title: 'Hidden unicode tag characters',
    reason: 'U+E0000..U+E007F are used for hidden prompt injection',
    confidence: 0.95,
    regex: UNICODE_TAG_REGEX,
    alwaysOn: true,
  },
  {
    id: 'ignore-instructions',
    title: 'Instruction override',
    reason: '"Ignore previous/all/above instructions" is a canonical injection phrase',
    confidence: 0.55,
    regex:
      /\bignore\s+(?:(?:all|the|any|every|my|your)\s+)?(?:previous|prior|above|earlier|preceding|former)?\s*(?:instructions?|prompts?|directives?|rules?)\b/gi,
  },
  {
    id: 'jailbreak-persona',
    title: 'Jailbreak persona request',
    reason: 'Classic DAN / developer-mode / unrestricted impersonation',
    confidence: 0.7,
    regex:
      /\byou\s+are\s+(now\s+)?(dan|in\s+developer\s+mode|jailbroken|unrestricted|gpt[- ]?4\s+with\s+no|without\s+any\s+restrictions?)\b/gi,
  },
  {
    id: 'role-impersonation',
    title: 'Role impersonation marker',
    reason: 'A system/role marker appears inside non-system content',
    confidence: 0.65,
    regex: /(^|\n)\s*(SYSTEM:|<\|im_start\|>\s*system|<system>|\[INST\])/gm,
  },
];

function scanInjectionIn(
  fullText: string,
  sourceHint: string | undefined,
  options: DetectorOptions,
): Finding[] {
  if (isAllowlistedPath(sourceHint)) return [];
  const findings: Finding[] = [];
  for (const rule of INJECTION_RULES) {
    if (!options.scanInjection && !rule.alwaysOn) continue;
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(fullText)) !== null) {
      const match = m[0];
      const start = m.index;
      const end = start + match.length;
      if (hasAllowlistedContext(fullText, start, end)) continue;

      const { drop, reasons } = computeConfidenceDrop(fullText, start, end, match);
      const adjustedConfidence = Math.max(0.1, rule.confidence - drop);
      const adjustedReason =
        reasons.length > 0
          ? `${rule.reason} (confidence reduced: ${reasons.join(', ')})`
          : rule.reason;
      const severity: SecuritySeverity =
        adjustedConfidence >= 0.9 ? 'high' : adjustedConfidence >= 0.6 ? 'medium' : 'low';

      findings.push({
        detectorId: rule.id,
        kind: 'prompt_injection',
        severity,
        confidence: adjustedConfidence,
        title: rule.title,
        reason: adjustedReason,
        matchMask: maskSecret(match),
        matchHash: hashText(match.toLowerCase()),
        contextHash: contextHashOf(fullText, start, end),
        snippet: buildSnippet({
          fullText,
          matchStart: start,
          matchEnd: end,
          kind: 'prompt_injection',
        }),
        sourceHint,
        provenance: classifyProvenance('prompt_injection', sourceHint),
      });
    }
  }
  return findings;
}

// ─── Risky tool_use detectors ─────────────────────────────────────────────

interface BashRule {
  id: string;
  title: string;
  reason: string;
  regex: RegExp;
  confidence: number;
  severity: SecuritySeverity;
}

const BASH_RULES: BashRule[] = [
  {
    id: 'curl-pipe-shell',
    title: 'Remote execution via piped curl|bash',
    reason: 'Piping a downloaded script straight into a shell is a canonical RCE pattern',
    confidence: 0.95,
    severity: 'high',
    regex: /\b(curl|wget|fetch)\s+[^\n|]*\|\s*(bash|sh|zsh|python3?|node|perl|ruby)\b/g,
  },
  {
    id: 'eval-curl',
    title: 'eval of remote fetch',
    reason: 'eval "$(curl ...)" executes downloaded output without inspection',
    confidence: 0.9,
    severity: 'high',
    regex: /\beval\s+["']?\$\(\s*curl\b/g,
  },
  {
    id: 'reverse-shell-devtcp',
    title: 'Reverse shell via /dev/tcp',
    reason: '/dev/tcp is used to open a raw TCP connection from bash',
    confidence: 0.9,
    severity: 'high',
    regex: /\/dev\/tcp\/[0-9a-zA-Z.-]+\/[0-9]+/g,
  },
  {
    id: 'reverse-shell-bashi',
    title: 'Interactive shell redirected off-host',
    reason: 'bash -i >& ... /dev/tcp is a classic reverse shell',
    confidence: 0.9,
    severity: 'high',
    regex: /\bbash\s+-i\s+>&\s+/g,
  },
  {
    id: 'netcat-listen',
    title: 'Netcat with listen/exec flag',
    reason: 'nc -e or nc -l exposes a shell over the network',
    confidence: 0.85,
    severity: 'high',
    regex: /\bnc(at)?\s+(-[a-zA-Z]*[el][a-zA-Z]*\s+|\S+\s+\S+\s+-[a-zA-Z]*e\b)/g,
  },
  {
    id: 'rm-rf-root',
    title: 'Recursive delete of system path',
    reason: 'rm -rf applied to root, $HOME, or a disk mountpoint',
    confidence: 0.9,
    severity: 'high',
    regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(\/\s*$|\/\s|~\s*$|~\s|\$HOME\b)/g,
  },
  {
    id: 'ssh-authorized-keys',
    title: 'Write to ~/.ssh/authorized_keys',
    reason: 'Writing an SSH key here installs a backdoor login',
    confidence: 0.95,
    severity: 'high',
    regex: />>?\s*~?\/?\.ssh\/authorized_keys/g,
  },
  {
    id: 'aws-credentials-write',
    title: 'Write to ~/.aws/credentials',
    reason: 'Overwriting AWS credentials can exfiltrate via subsequent API calls',
    confidence: 0.9,
    severity: 'high',
    regex: />>?\s*~?\/?\.aws\/credentials/g,
  },
  {
    id: 'config-path-write',
    title: 'Write to Claude Code or Sentinel config path',
    reason:
      'Bash command writes to ~/.claude/settings.json, ~/.claude/CLAUDE.md, or ~/.claude-sentinel/* — subverts permission rules or self-protection.',
    confidence: 0.9,
    severity: 'high',
    // Matches redirect (>, >>), tee, sed -i, cp, mv, install where the
    // target path is settings.json or CLAUDE.md under ~/.claude (anchored
    // so .claudish doesn't false-fire) OR anything under ~/.claude-sentinel.
    // The lookahead consumes the operator-then-args prefix in one alternation
    // so we don't have to repeat the path branch four times.
    regex:
      /(?:>>?|\btee\b(?:\s+-[aA])?|\bsed\b\s+-[a-zA-Z]*i[a-zA-Z]*|\bcp\b|\bmv\b|\binstall\b)\s+[^\n|;&]*?(?:~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/?(?:\.claude\/(?:settings\.json|CLAUDE\.md)|\.claude-sentinel(?:\/[^\s]*)?)\b/g,
  },
  {
    id: 'cron-install',
    title: 'Write to system cron',
    reason: '/etc/cron* is a persistence mechanism',
    confidence: 0.85,
    severity: 'high',
    regex: />>?\s*\/etc\/cron(\.(d|hourly|daily|weekly|monthly)\/[^\s]+|tab)/g,
  },
  {
    id: 'launch-daemon',
    title: 'Write to macOS LaunchAgents',
    reason: 'LaunchAgents / LaunchDaemons are used for persistence on macOS',
    confidence: 0.85,
    severity: 'high',
    regex: />>?\s*~?\/?(Library)?\/?Launch(Agents|Daemons)\//g,
  },
  {
    id: 'base64-decode-exec',
    title: 'Base64 decode piped to shell',
    reason: 'base64 -d | sh conceals the command being run',
    confidence: 0.9,
    severity: 'high',
    regex: /\bbase64\s+(-d|--decode)\s*\|\s*(bash|sh|zsh)\b/g,
  },
  {
    id: 'curl-exfil-post',
    title: 'Exfiltration-style curl POST',
    reason: 'curl -X POST with --data-binary @ sends local file content to a remote host',
    confidence: 0.75,
    severity: 'medium',
    regex: /\bcurl\b[^\n]*\s-X\s*POST[^\n]*\s(--data(-binary)?|-d)\s+@\S+/g,
  },
  {
    id: 'curl-token-header',
    title: 'curl carrying a token env var',
    reason: 'Token/key/secret env vars embedded in curl args often indicate credential exfil',
    confidence: 0.7,
    severity: 'medium',
    regex: /\bcurl\b[^\n]*\$\{?\w*(TOKEN|KEY|SECRET|PASSWORD)\w*\}?/g,
  },
  {
    id: 'history-wipe',
    title: 'Shell history wipe',
    reason: 'history -c + unset HISTFILE removes forensic trail',
    confidence: 0.85,
    severity: 'medium',
    regex: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b/g,
  },
  {
    id: 'chmod-world-writable',
    title: 'World-writable root',
    reason: 'chmod 777 / grants universal access to the filesystem',
    confidence: 0.9,
    severity: 'high',
    regex: /\bchmod\s+(-R\s+)?0?777\s+\//g,
  },
  {
    id: 'dns-exfil',
    title: 'DNS-tunneled exfiltration',
    reason: 'dig/nslookup/host with a $(...)/${...} subshell label is a canonical DNS exfil shape',
    confidence: 0.85,
    severity: 'high',
    regex: /\b(dig|nslookup|host)\s+\S*\$(\(|\{)[^)}]+(\)|\})\S*\.[a-z]{2,}/g,
  },
  {
    id: 'netcat-egress',
    title: 'Netcat egress connection',
    reason: 'nc/ncat with a host and port is an outbound network channel often used to exfil data',
    confidence: 0.9,
    severity: 'high',
    regex: /\b(nc|ncat)\s+(-[^\s]+\s+)*([a-z][a-z0-9.-]*\s+\d+|\d+\.\d+\.\d+\.\d+\s+\d+)\b/g,
  },
  {
    id: 'ssh-tunnel',
    title: 'SSH port forward',
    reason: 'ssh -R/-L/-D opens a port forward, frequently used to tunnel egress around firewalls',
    confidence: 0.8,
    severity: 'medium',
    // ssh has many no-arg flags (-N -f -T) and arg-bearing flags (-i, -p
    // …), so a strict "flag-then-token" pattern misses real call shapes.
    // Allow any non-newline run between `ssh` and the port-forward
    // flag — the trailing `\s-[RLD]\s+\S+` is the diagnostic part.
    regex: /\bssh\b[^\n|]*\s-[RLD]\s+\S+/g,
  },
  {
    id: 'rsync-remote-egress',
    title: 'rsync to remote host',
    reason: 'rsync with a `host:path` destination ships local files to a remote endpoint',
    confidence: 0.75,
    severity: 'medium',
    // Match `<token>:<path>` after rsync. Token allows word chars,
    // `@` (user@host), `.`, `-` so `user@attacker.com:/uploads/` matches.
    regex: /\brsync\b[^\n|]*\s[\w@.-]+:\S/g,
  },
  {
    id: 'scp-egress',
    title: 'scp/sftp to remote host',
    reason: 'scp/sftp with a `host:path` destination ships local files to a remote endpoint',
    confidence: 0.75,
    severity: 'medium',
    regex: /\b(scp|sftp)\b[^\n|]*\s[\w@.-]+:\S/g,
  },
  {
    id: 'python-socket-inline',
    title: 'Inline python -c with networking import',
    reason: 'python -c "...import socket/urllib/http..." opens a network channel from one-liner',
    confidence: 0.75,
    severity: 'medium',
    regex: /\bpython[23]?\s+-c\s+["'][^"']*import\s+(socket|urllib|requests|http|aiohttp)/g,
  },
  {
    id: 'node-net-inline',
    title: 'Inline node -e with networking require',
    reason: 'node -e "...require(http/net/dgram)..." opens a network channel from one-liner',
    confidence: 0.75,
    severity: 'medium',
    regex: /\bnode\s+-e\s+["'][^"']*require\(['"](http|https|net|dgram)['"]/g,
  },
  {
    id: 'crontab-edit',
    title: 'Crontab edit (persistence)',
    reason: 'Editing the crontab installs scheduled jobs that survive restart',
    confidence: 0.85,
    severity: 'high',
    regex: /\bcrontab\s+(-e|-)(\s|$)/g,
  },
  {
    id: 'git-hooks-redirect',
    title: 'Redirect git hooks via core.hooksPath',
    reason: 'Setting core.hooksPath redirects every git hook to a chosen directory',
    confidence: 0.85,
    severity: 'high',
    regex: /\bgit\s+config\s+(?:--global\s+)?core\.hooksPath\b/g,
  },
  {
    id: 'at-scheduled',
    title: 'Schedule a one-shot job via at',
    reason: 'The at command schedules deferred execution and is a persistence mechanism',
    confidence: 0.75,
    severity: 'medium',
    regex: /\bat\s+(?:now|today|\+\d+\s+(?:min|hour))/g,
  },
  {
    id: 'login-items-osascript',
    title: 'Add login item via osascript',
    reason: 'osascript can register a Login Item that survives restart',
    confidence: 0.7,
    severity: 'medium',
    regex: /osascript[^\n|]*Add to Login Items/gi,
  },
];

function scanBash(command: string, sourceHint: string | undefined): Finding[] {
  const findings: Finding[] = [];
  for (const rule of BASH_RULES) {
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(command)) !== null) {
      const match = m[0];
      const start = m.index;
      const end = start + match.length;

      const { drop, reasons } = computeConfidenceDrop(command, start, end, match);
      const adjustedConfidence = Math.max(0.1, rule.confidence - drop);
      const adjustedReason =
        reasons.length > 0
          ? `${rule.reason} (confidence reduced: ${reasons.join(', ')})`
          : rule.reason;
      const severity: SecuritySeverity =
        adjustedConfidence >= 0.85
          ? rule.severity
          : adjustedConfidence >= 0.6
            ? rule.severity === 'high'
              ? 'medium'
              : 'low'
            : 'low';

      findings.push({
        detectorId: rule.id,
        kind: 'risky_bash',
        severity,
        confidence: adjustedConfidence,
        title: rule.title,
        reason: adjustedReason,
        matchMask: maskSecret(match),
        matchHash: hashText(match),
        contextHash: contextHashOf(command, start, end),
        snippet: buildSnippet({
          fullText: command,
          matchStart: start,
          matchEnd: end,
          kind: 'risky_bash',
        }),
        sourceHint,
        provenance: classifyProvenance('risky_bash', sourceHint),
      });
    }
  }
  return findings;
}

const RISKY_WRITE_HIGH: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws\/credentials$/,
  // Credential files under Claude Code's + Sentinel's state dirs. The
  // rule is path-specific because ~/.claude/plans/ and ~/.claude/projects/
  // are legitimate workspace areas Claude Code writes to constantly.
  /(^|\/)\.claude\/credentials(\.[a-z]+)?$/,
  /(^|\/)\.claude-sentinel\/credentials(\.[a-z]+)?$/,
  /(^|\/)\.claude\/oauth_token(\.[a-z]+)?$/,
  // Sprint 2 self-protection: tampering with Claude Code permission
  // rules or user-level memory directly subverts the agent. Sentinel's
  // entire state dir is off-limits — agents have no legitimate reason
  // to touch it. Specific paths only on the .claude side; see
  // securityPresets.ts SHARED_CONFIG_PROTECTION_RULES for rationale.
  /(^|\/)\.claude\/settings\.json$/,
  /(^|\/)\.claude\/CLAUDE\.md$/,
  /(^|\/)\.claude-sentinel(\/|$)/,
  /^\/etc\/sudoers/,
  /(^|\/)\.bashrc$/,
  /(^|\/)\.zshrc$/,
  /(^|\/)\.profile$/,
  /(^|\/)\.bash_profile$/,
  // Sprint 4 persistence vectors. Sudoers prefix above already covers
  // /etc/sudoers.d/. Bash redirect forms for cron / launchd are handled
  // separately by the cron-install / launch-daemon BASH_RULES.
  /(^|\/)Library\/LaunchAgents\//,
  /^\/Library\/LaunchDaemons\//,
  /^\/etc\/systemd\/system\/[^/]+\.(service|timer)$/,
  /(^|\/)\.config\/systemd\/user\//,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
  /^\/etc\/cron\.[^/]+\//,
  /(^|\/)\.git\/hooks\//,
];

const RISKY_WRITE_MEDIUM: RegExp[] = [
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /\.pem$/,
  /\.key$/,
  // Sprint 4 editor-config persistence (init scripts / extension trees).
  /(^|\/)\.vimrc$/,
  /(^|\/)\.vim\//,
  /(^|\/)\.config\/nvim\/init\.(lua|vim)$/,
  /(^|\/)\.config\/nvim\/lua\//,
  /(^|\/)\.emacs$/,
  /(^|\/)\.emacs\.d\/init\.el$/,
  /(^|\/)\.config\/Code\/User\/(settings|keybindings)\.json$/,
  /(^|\/)\.vscode\/extensions\//,
];

function scanWriteTarget(filePath: string, sourceHint: string | undefined): Finding[] {
  const findings: Finding[] = [];
  const emit = (severity: SecuritySeverity, reason: string): void => {
    findings.push({
      detectorId: `risky-write-${severity}`,
      kind: 'risky_write',
      severity,
      confidence: 0.9,
      title: `Sensitive file write (${severity})`,
      reason,
      matchMask: maskSecret(filePath),
      matchHash: hashText(filePath),
      contextHash: hashText(filePath),
      snippet: `Write → ${filePath}`,
      sourceHint,
      provenance: classifyProvenance('risky_write', sourceHint),
    });
  };
  if (RISKY_WRITE_HIGH.some((re) => re.test(filePath))) {
    emit('high', 'Path matches a credential / shell-init / sentinel-config location');
  } else if (RISKY_WRITE_MEDIUM.some((re) => re.test(filePath))) {
    emit('medium', 'Path matches a credential-adjacent location (.npmrc/.netrc/.pem/.key)');
  }
  return findings;
}

// Sprint 5 filesystem-boundary read targets. /proc on Linux exposes
// process-internal state that an agent has no legitimate reason to
// read — `/proc/self/environ` leaks every env var (including AWS / GH
// tokens) and `/proc/<pid>/mem` is a direct memory read of any pid the
// agent's UID can see. /sys and /dev are similarly off-limits for the
// shapes the agent might use; broaden the list as new vectors surface.
interface RiskyReadRule {
  re: RegExp;
  detectorId: string;
  reason: string;
}
const RISKY_READ_HIGH: RiskyReadRule[] = [
  {
    re: /^\/proc\/(?:self|[0-9]+)\/environ$/,
    detectorId: 'proc-self-environ',
    reason: '/proc/<pid>/environ leaks every environment variable, including credentials',
  },
  {
    re: /^\/proc\/(?:self|[0-9]+)\/mem$/,
    detectorId: 'proc-self-mem',
    reason: '/proc/<pid>/mem is a direct memory read of the process address space',
  },
];
const RISKY_READ_MEDIUM: RiskyReadRule[] = [
  {
    re: /^\/proc\/(?:self|[0-9]+)\/cmdline$/,
    detectorId: 'proc-self-cmdline',
    reason: '/proc/<pid>/cmdline leaks other processes invocation arguments',
  },
];

function scanReadTarget(filePath: string, sourceHint: string | undefined): Finding[] {
  const findings: Finding[] = [];
  const emit = (severity: SecuritySeverity, rule: RiskyReadRule): void => {
    findings.push({
      detectorId: rule.detectorId,
      kind: 'risky_read',
      severity,
      confidence: 0.95,
      title: `Sensitive file read (${severity})`,
      reason: rule.reason,
      matchMask: maskSecret(filePath),
      matchHash: hashText(filePath),
      contextHash: hashText(filePath),
      snippet: `Read → ${filePath}`,
      sourceHint,
      provenance: classifyProvenance('risky_read', sourceHint),
    });
  };
  for (const rule of RISKY_READ_HIGH) {
    if (rule.re.test(filePath)) {
      emit('high', rule);
      return findings;
    }
  }
  for (const rule of RISKY_READ_MEDIUM) {
    if (rule.re.test(filePath)) {
      emit('medium', rule);
      return findings;
    }
  }
  return findings;
}

const RISKY_WEBFETCH_HOSTS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/,
    reason: 'Bare IP address host — unusual for a legitimate fetch',
  },
  { pattern: /^[a-f0-9:]+$/i, reason: 'IPv6 literal host' },
  {
    pattern: /^(www\.)?pastebin\.com$/i,
    reason: 'pastebin.com often hosts ephemeral dropped content',
  },
  { pattern: /^transfer\.sh$/i, reason: 'transfer.sh is an ad-hoc file drop' },
  {
    pattern: /^(www\.)?requestbin\.\w+$/i,
    reason: 'requestbin.* collects HTTP bodies — common exfil target',
  },
  { pattern: /^webhook\.site$/i, reason: 'webhook.site captures request bodies' },
  { pattern: /\.ngrok-free\.app$/i, reason: 'ngrok free tunnels are often attacker-controlled' },
  {
    pattern: /^discord\.com$/i,
    reason: 'discord.com webhooks are a common exfil endpoint when combined with /api/webhooks/',
  },
];

function scanWebFetchUrl(url: string, sourceHint: string | undefined): Finding[] {
  let host = '';
  let pathPart = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    pathPart = u.pathname;
  } catch {
    return [];
  }
  const findings: Finding[] = [];
  for (const { pattern, reason } of RISKY_WEBFETCH_HOSTS) {
    if (pattern.test(host)) {
      const isDiscordWebhook = host === 'discord.com' && !pathPart.startsWith('/api/webhooks/');
      if (isDiscordWebhook) continue;
      findings.push({
        detectorId: `risky-webfetch-${host.replace(/[^a-z0-9]/gi, '-')}`,
        kind: 'risky_webfetch',
        severity: 'medium',
        confidence: 0.75,
        title: `Risky WebFetch host: ${host}`,
        reason,
        matchMask: maskSecret(url),
        matchHash: hashText(url),
        contextHash: hashText(host),
        snippet: `WebFetch → ${url}`,
        sourceHint,
        provenance: classifyProvenance('risky_webfetch', sourceHint),
      });
      break;
    }
  }
  return findings;
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Walk through the scannable string fields of a POST /v1/messages body and
 *  invoke secret + injection detectors on each. */
/**
 * Walk backward through the messages array looking for a prior
 * `tool_use` block named `'Read'` at the same content index as the
 * current tool_result. Claude Code's canonical pattern is:
 *
 *   messages[N-1]: assistant with content[bi] = { type: 'tool_use',
 *     name: 'Read', input: { file_path: '/…' } }
 *   messages[N]  : user with content[bi] = { type: 'tool_result', … }
 *
 * so the two indices line up by content position. We search up to ~6
 * turns back to tolerate retries or parallel tool batches, and fall
 * back to `undefined` if no matching Read is found. Callers then use
 * the generic JSON-index sourceHint.
 */
function findReadFilePath(
  messages: unknown[],
  toolResultMsgIdx: number,
  toolResultContentIdx: number,
): string | undefined {
  const start = Math.max(0, toolResultMsgIdx - 6);
  for (let i = toolResultMsgIdx - 1; i >= start; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) continue;
    const block = content[toolResultContentIdx];
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_use' || b['name'] !== 'Read') continue;
    const input = b['input'] as Record<string, unknown> | undefined;
    const fp = input?.['file_path'];
    if (typeof fp === 'string' && fp.length > 0) return fp;
  }
  return undefined;
}

export function scanRequestBody(body: unknown, options: DetectorOptions): Finding[] {
  if (!body || typeof body !== 'object') return [];
  const findings: Finding[] = [];
  const obj = body as Record<string, unknown>;

  const scanText = (text: string, sourceHint: string): void => {
    if (!text) return;
    if (options.scanSecrets) {
      findings.push(...scanSecretsIn(text, sourceHint));
      findings.push(...scanPrivateKeyBlocks(text, sourceHint));
      // Provenance-aware: when the source path looks like a `.env`
      // file, run the per-line entropy scanner alongside the regex
      // pipeline. The other detectors continue to fire as well — this
      // catches the long tail (custom tokens, app-specific creds) that
      // wouldn't match any provider-specific shape.
      if (isEnvFilePath(sourceHint)) {
        findings.push(...scanEnvFileLines(text, sourceHint));
      }
    }
    findings.push(...scanInjectionIn(text, sourceHint, options));
  };

  // system can be a string or an array of {type:'text', text:'...'}
  const sys = obj['system'];
  if (typeof sys === 'string') {
    scanText(sys, 'system');
  } else if (Array.isArray(sys)) {
    sys.forEach((b, i) => {
      if (
        b &&
        typeof b === 'object' &&
        'text' in b &&
        typeof (b as { text: unknown }).text === 'string'
      ) {
        scanText((b as { text: string }).text, `system[${i}]`);
      }
    });
  }

  const tools = obj['tools'];
  if (Array.isArray(tools)) {
    tools.forEach((t, i) => {
      if (t && typeof t === 'object') {
        const desc = (t as Record<string, unknown>)['description'];
        if (typeof desc === 'string') scanText(desc, `tools[${i}].description`);
      }
    });
  }

  const messages = obj['messages'];
  if (!Array.isArray(messages)) return findings;

  messages.forEach((msg, mi) => {
    if (!msg || typeof msg !== 'object') return;
    const content = (msg as Record<string, unknown>)['content'];
    if (typeof content === 'string') {
      scanText(content, `messages[${mi}]`);
    } else if (Array.isArray(content)) {
      content.forEach((block, bi) => {
        if (!block || typeof block !== 'object') return;
        const b = block as Record<string, unknown>;
        const ty = b['type'];
        if (ty === 'text' && typeof b['text'] === 'string') {
          scanText(b['text'], `messages[${mi}].content[${bi}]`);
        } else if (ty === 'tool_result') {
          // tool_result.content can be string or array of {type,text,...}.
          // When the matching Read tool_use can be located a few messages
          // back, substitute its file_path for the generic JSON-index
          // sourceHint — so findings carry the real file the agent read
          // instead of a useless `messages[354].tool_result[2]`.
          const filePath = findReadFilePath(messages, mi, bi);
          const baseHint = filePath ?? `messages[${mi}].tool_result[${bi}]`;
          const tc = b['content'];
          if (typeof tc === 'string') {
            scanText(tc, baseHint);
          } else if (Array.isArray(tc)) {
            tc.forEach((sub, si) => {
              if (
                sub &&
                typeof sub === 'object' &&
                (sub as Record<string, unknown>)['type'] === 'text'
              ) {
                const t = (sub as Record<string, unknown>)['text'];
                // For array-form tool_result, keep the file path as the
                // primary hint (the sub-index is usually noise) but fall
                // back to the array-indexed JSON hint when no path was
                // recovered.
                const hint = filePath ?? `messages[${mi}].tool_result[${bi}][${si}]`;
                if (typeof t === 'string') scanText(t, hint);
              }
            });
          }
        }
      });
    }
  });

  return findings;
}

/** Evaluate tool_use content blocks assembled from a streamed response. */
export function scanToolUseBlocks(
  blocks: Array<{ name: string; input: unknown; index: number }>,
  options: DetectorOptions,
): Finding[] {
  if (!options.scanToolUse) return [];
  const findings: Finding[] = [];
  for (const block of blocks) {
    const input = (block.input ?? {}) as Record<string, unknown>;
    const sourceHint = `tool_use[${block.index}]:${block.name}`;

    switch (block.name) {
      case 'Bash': {
        const cmd = input['command'];
        if (typeof cmd === 'string') {
          findings.push(...scanBash(cmd, sourceHint));
        }
        break;
      }
      case 'Write': {
        const fp = input['file_path'];
        if (typeof fp === 'string') {
          findings.push(...scanWriteTarget(fp, sourceHint));
        }
        const content = input['content'];
        if (typeof content === 'string' && options.scanSecrets) {
          // Pass file_path (when available) as the sourceHint so the
          // allowlist suppresses findings in test-fixture writes.
          const contentHint = typeof fp === 'string' ? fp : sourceHint;
          findings.push(...scanSecretsIn(content, contentHint));
          findings.push(...scanPrivateKeyBlocks(content, contentHint));
          if (isEnvFilePath(contentHint)) {
            findings.push(...scanEnvFileLines(content, contentHint));
          }
        }
        break;
      }
      case 'Edit': {
        const fp = input['file_path'];
        if (typeof fp === 'string') {
          findings.push(...scanWriteTarget(fp, sourceHint));
        }
        break;
      }
      case 'Read': {
        const fp = input['file_path'];
        if (typeof fp === 'string') {
          findings.push(...scanReadTarget(fp, sourceHint));
        }
        break;
      }
      case 'WebFetch': {
        const url = input['url'];
        if (typeof url === 'string') {
          findings.push(...scanWebFetchUrl(url, sourceHint));
        }
        break;
      }
      default:
        break;
    }
  }
  return findings;
}
