import { openUrl } from '@tauri-apps/plugin-opener';
import type { LogEntry, LogRequestSummary } from '@sentinel/shared';

const REPO = 'Intevity/sentinel';
const ISSUE_URL = `https://github.com/${REPO}/issues/new`;

// GitHub URLs hold up to ~8KB before browsers / servers start complaining.
// We cap the body well under that so the URL, title, and encoding overhead
// always fit. 6000 pre-encode chars becomes roughly 7-7.5KB once
// percent-encoded, leaving headroom.
const MAX_BODY_CHARS = 6000;

export type CrashSource = 'manual' | 'error-boundary' | 'daemon-error';

export interface ReportError {
  message: string;
  stack?: string;
  componentStack?: string;
}

export interface BugReportContext {
  source: CrashSource;
  error?: ReportError;
  daemonErrors?: LogEntry[];
  /** Last ~50 daemon log entries of any level. Provides the INFO/WARN
   *  context that surrounds an error and is often what makes the failure
   *  reproducible. Renders as a separate collapsible section and is the
   *  first thing trimmed when the body overruns the URL budget. */
  recentEntries?: LogEntry[];
  /** Metadata for proxy requests that errored — fetched via the
   *  `get_request_summaries` IPC at the moment the user clicks Report.
   *  Pairs each errored requestId surfaced in `daemonErrors` with its
   *  status, duration, and SSE-flag so a `read ETIMEDOUT` row tells the
   *  reader whether the failure was pre-headers or mid-stream. Bodies
   *  are intentionally NOT carried here — they may contain user prompts. */
  requestSummaries?: LogRequestSummary[];
}

interface EnvInfo {
  appVersion: string;
  userAgent: string;
}

function collectEnv(): EnvInfo {
  return {
    appVersion: __APP_VERSION__,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  };
}

function formatLogEntry(e: LogEntry): string {
  const ts = new Date(e.timestamp).toISOString();
  // `e.tag` is denormalized from the message via regex by the daemon
  // logger; the message itself already begins with `[tag]` when tagged.
  // Emit only the message so output matches daemon.log's wire format
  // and we don't produce `[proxy] [proxy] …`.
  return `${ts} ${e.level.toUpperCase()} ${e.message}`;
}

export function buildTitle(ctx: BugReportContext): string {
  if (ctx.source === 'error-boundary' && ctx.error) {
    const firstLine = ctx.error.message.split('\n')[0]?.slice(0, 120) ?? '';
    return `[crash] ${firstLine}`;
  }
  if (ctx.source === 'daemon-error' && ctx.daemonErrors && ctx.daemonErrors.length > 0) {
    const latest = ctx.daemonErrors[ctx.daemonErrors.length - 1]!;
    const tag = latest.tag ? `[${latest.tag}] ` : '';
    const firstLine = latest.message.split('\n')[0]?.slice(0, 120) ?? '';
    return `[daemon] ${tag}${firstLine}`.trim();
  }
  return '[bug] ';
}

interface BodySection {
  // Fixed sections always render. Truncatable sections shrink in priority
  // order to keep the body under MAX_BODY_CHARS: 'context' (non-error
  // surrounding entries) first, then 'logs' (the error entries
  // themselves), then 'stack'. Most actionable content survives.
  // 'summaries' is also fixed-ish: tiny per row, never the truncation
  // bottleneck and the most directly diagnostic structured payload.
  kind: 'fixed' | 'summaries' | 'context' | 'logs' | 'stack';
  content: string;
}

function envSection(env: EnvInfo): string {
  return [
    '## Environment',
    `- Sentinel: ${env.appVersion}`,
    `- User agent: ${env.userAgent}`,
  ].join('\n');
}

function logsSection(entries: LogEntry[]): string {
  const lines = entries.slice(-20).map(formatLogEntry).join('\n');
  return [
    '<details><summary>Recent daemon errors (last 20)</summary>',
    '',
    '```',
    lines,
    '```',
    '',
    '</details>',
  ].join('\n');
}

function contextSection(entries: LogEntry[]): string {
  const lines = entries.slice(-50).map(formatLogEntry).join('\n');
  return [
    '<details><summary>Recent daemon activity (last 50 entries, all levels)</summary>',
    '',
    '```',
    lines,
    '```',
    '',
    '</details>',
  ].join('\n');
}

function formatRequestSummary(s: LogRequestSummary): string {
  const status = s.statusCode === null ? 'no-response' : String(s.statusCode);
  const dur = s.durationMs === null ? 'no-duration' : `${(s.durationMs / 1000).toFixed(2)}s`;
  const sse = s.isSse ? ' isSse=true' : '';
  const lines = [
    `${s.requestId}  ${s.method} ${s.urlPath}  status=${status}  duration=${dur}${sse}`,
  ];
  if (s.errorMessage) lines.push(`  error: ${s.errorMessage}`);
  return lines.join('\n');
}

function requestSummariesSection(summaries: LogRequestSummary[]): string {
  const lines = summaries.map(formatRequestSummary).join('\n');
  return [
    '<details><summary>Failed proxy requests</summary>',
    '',
    '```',
    lines,
    '```',
    '',
    '</details>',
  ].join('\n');
}

function stackSection(error: ReportError): string {
  const parts = [error.message];
  if (error.stack) {
    parts.push('', error.stack);
  }
  if (error.componentStack) {
    parts.push('', 'Component stack:', error.componentStack);
  }
  return [
    '<details><summary>UI error & stack</summary>',
    '',
    '```',
    parts.join('\n'),
    '```',
    '',
    '</details>',
  ].join('\n');
}

// Reduce a string to a maximum length, keeping the tail (most recent
// lines / end of stack trace are usually more actionable than the head).
function truncateTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const keep = Math.max(0, maxChars - 32);
  return `…[truncated ${s.length - keep} chars]…\n${s.slice(-keep)}`;
}

export function buildBody(ctx: BugReportContext): string {
  const env = collectEnv();
  const intro =
    ctx.source === 'error-boundary'
      ? '<!-- The app hit a render error. Add any context that helps us reproduce. -->'
      : ctx.source === 'daemon-error'
        ? '<!-- Recent daemon errors were detected. Add any context that helps us reproduce. -->'
        : '<!-- Describe the problem here. -->';

  const sections: BodySection[] = [
    { kind: 'fixed', content: intro },
    { kind: 'fixed', content: '## Steps to reproduce\n1. \n2. \n3. ' },
    { kind: 'fixed', content: '## Expected behavior\n' },
    { kind: 'fixed', content: '## Actual behavior\n' },
    { kind: 'fixed', content: envSection(env) },
  ];

  if (ctx.requestSummaries && ctx.requestSummaries.length > 0) {
    sections.push({
      kind: 'summaries',
      content: requestSummariesSection(ctx.requestSummaries),
    });
  }
  if (ctx.daemonErrors && ctx.daemonErrors.length > 0) {
    sections.push({ kind: 'logs', content: logsSection(ctx.daemonErrors) });
  }
  if (ctx.recentEntries && ctx.recentEntries.length > 0) {
    sections.push({ kind: 'context', content: contextSection(ctx.recentEntries) });
  }
  if (ctx.error) {
    sections.push({ kind: 'stack', content: stackSection(ctx.error) });
  }

  const join = (parts: BodySection[]): string => parts.map((s) => s.content).join('\n\n');
  let body = join(sections);
  if (body.length <= MAX_BODY_CHARS) return body;

  // Over budget. Shrink in priority order — context first (the
  // surrounding INFO/WARN is supplemental), then the error logs
  // themselves, then the stack. This protects the most actionable
  // content.
  for (const kind of ['context', 'logs', 'stack'] as const) {
    const idx = sections.findIndex((s) => s.kind === kind);
    if (idx < 0) continue;
    const others = sections
      .filter((_, i) => i !== idx)
      .reduce((n, s) => n + s.content.length + 2, 0);
    const budget = Math.max(200, MAX_BODY_CHARS - others);
    sections[idx] = {
      kind,
      content: truncateTail(sections[idx]!.content, budget),
    };
    body = join(sections);
    if (body.length <= MAX_BODY_CHARS) return body;
  }

  // Final guard: hard-truncate the whole body if the fixed sections alone
  // somehow still exceed the cap.
  return body.length <= MAX_BODY_CHARS ? body : truncateTail(body, MAX_BODY_CHARS);
}

export function buildIssueUrl(ctx: BugReportContext): string {
  const params = new URLSearchParams({
    title: buildTitle(ctx),
    body: buildBody(ctx),
    labels: 'bug',
  });
  return `${ISSUE_URL}?${params.toString()}`;
}

export async function openBugReport(ctx: BugReportContext): Promise<void> {
  await openUrl(buildIssueUrl(ctx));
}
