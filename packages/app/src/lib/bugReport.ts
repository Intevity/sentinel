import { openUrl } from '@tauri-apps/plugin-opener';
import type { LogEntry } from '@claude-sentinel/shared';

const REPO = 'Intevity/claude-sentinel';
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
  const tag = e.tag ? `[${e.tag}] ` : '';
  return `${ts} ${e.level.toUpperCase()} ${tag}${e.message}`;
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
  // Fixed sections always render. Truncatable sections can be shortened
  // (logs first, stack second) to keep the body under MAX_BODY_CHARS.
  kind: 'fixed' | 'logs' | 'stack';
  content: string;
}

function envSection(env: EnvInfo): string {
  return [
    '## Environment',
    `- Claude Sentinel: ${env.appVersion}`,
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

  if (ctx.daemonErrors && ctx.daemonErrors.length > 0) {
    sections.push({ kind: 'logs', content: logsSection(ctx.daemonErrors) });
  }
  if (ctx.error) {
    sections.push({ kind: 'stack', content: stackSection(ctx.error) });
  }

  const join = (parts: BodySection[]): string => parts.map((s) => s.content).join('\n\n');
  let body = join(sections);
  if (body.length <= MAX_BODY_CHARS) return body;

  // Over budget. Shrink logs first — older error lines are least actionable
  // since the most recent entries usually capture the failure that
  // triggered the report.
  const logsIdx = sections.findIndex((s) => s.kind === 'logs');
  if (logsIdx >= 0) {
    const others = sections.filter((_, i) => i !== logsIdx).reduce((n, s) => n + s.content.length + 2, 0);
    const budget = Math.max(200, MAX_BODY_CHARS - others);
    sections[logsIdx] = {
      kind: 'logs',
      content: truncateTail(sections[logsIdx]!.content, budget),
    };
    body = join(sections);
    if (body.length <= MAX_BODY_CHARS) return body;
  }

  // Still over budget — shrink the stack trace.
  const stackIdx = sections.findIndex((s) => s.kind === 'stack');
  if (stackIdx >= 0) {
    const others = sections.filter((_, i) => i !== stackIdx).reduce((n, s) => n + s.content.length + 2, 0);
    const budget = Math.max(200, MAX_BODY_CHARS - others);
    sections[stackIdx] = {
      kind: 'stack',
      content: truncateTail(sections[stackIdx]!.content, budget),
    };
    body = join(sections);
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
