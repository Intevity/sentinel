#!/usr/bin/env node
/**
 * Mock IPC bridge for demo recordings.
 *
 * Speaks the exact protocol the real frontend expects in E2E mode
 * (packages/app/src/lib/ipc.ts):
 *   POST /        → request/response; body is an AppToDaemonMessage,
 *                   reply is IpcResponse = { requestType, success, data }.
 *   GET  /events  → SSE stream of DaemonToAppMessage broadcasts.
 *
 * Unlike the real e2e bridge (which proxies a live daemon socket), this
 * serves canned, sanitized-but-realistic fixtures so we can drive the real
 * React UI in a browser and screen-record it. Compression totals are seeded
 * from the user's real compression-stats.db aggregates; account identities
 * are fake.
 *
 * Driver-only control message:
 *   { type: '__demo_ramp' } → start the "savings climbing" animation: ramp the
 *   compression totals from RAMP_FROM→1.0 over RAMP_MS, emitting
 *   compression_metrics_updated on each step so the panel refetches and the
 *   numbers tick up live.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.BRIDGE_PORT ?? 47999);

// --- static assets for the macOS-desktop recording stage ---
const here = path.dirname(fileURLToPath(import.meta.url));
const STAGE_HTML = path.join(here, 'stage.html');
// Real brand assets, served straight from the repo so the stage chrome stays
// faithful (the menu-bar tray shield and the dock mascot).
const ASSETS = {
  '/asset/tray-icon.png': {
    file: path.join(here, '..', 'src-tauri', 'icons', 'tray-icon.png'),
    type: 'image/png',
  },
  '/asset/mascot.png': {
    file: path.join(here, '..', '..', 'site', 'public', 'sentinel-mascot.png'),
    type: 'image/png',
  },
};

// --- real compression aggregates (from ~/.sentinel/compression-stats.db) ---
// Tuned so the headline reduction ratio (savedTokens / gross optimized tokens,
// and bytesOut / bytesIn) lands in the user's real ~75% range. estTokensSaved /
// estCostSavedUsd / bytesIn are the user-accepted "saved" magnitudes and stay
// fixed; the gross (estTokensIn) and compressed output (bytesOut) set the ratio.
const REAL = {
  bytesIn: 10123799017,
  bytesOut: 2530949754, // 25% of bytesIn -> 75% bytes removed
  estTokensIn: 1839000000, // gross compressed tokens; 1374M saved / 1839M = ~75%
  estTokensSaved: 1374024081,
  estCostSavedUsd: 15951.72,
  requestsCompressed: 42274,
  requestsSkipped: 15214,
  estTokensPotential: 5869245,
  estCostPotential: 84.36,
};
const RATIO = REAL.bytesOut / REAL.bytesIn;

// Savings-climb ramp.
const RAMP_FROM = 0.9;
const RAMP_MS = 6000;
const RAMP_STEP_MS = 300;
let ramp = RAMP_FROM;

function compressionMetrics() {
  const f = ramp;
  const daily = buildDaily(f);
  return {
    totals: {
      bytesIn: Math.round(REAL.bytesIn * f),
      bytesOut: Math.round(REAL.bytesOut * f),
      estTokensIn: Math.round(REAL.estTokensIn * f),
      estTokensSaved: Math.round(REAL.estTokensSaved * f),
      estCostSavedUsd: +(REAL.estCostSavedUsd * f).toFixed(2),
      requestsCompressed: Math.round(REAL.requestsCompressed * f),
      requestsSkipped: REAL.requestsSkipped,
      ratio: RATIO,
      estTokensPotential: REAL.estTokensPotential,
      estCostPotential: REAL.estCostPotential,
    },
    daily,
    byTool: [
      {
        tool: 'Bash',
        bytesIn: 4_550_000_000,
        bytesOut: 1_137_500_000,
        blocks: 18800,
        estTokensSaved: 640_000_000,
      },
      {
        tool: 'Read',
        bytesIn: 3_100_000_000,
        bytesOut: 775_000_000,
        blocks: 12400,
        estTokensSaved: 410_000_000,
      },
      {
        tool: 'Grep',
        bytesIn: 1_500_000_000,
        bytesOut: 375_000_000,
        blocks: 7100,
        estTokensSaved: 196_000_000,
      },
      {
        tool: 'WebFetch',
        bytesIn: 970_000_000,
        bytesOut: 242_500_000,
        blocks: 3974,
        estTokensSaved: 128_000_000,
      },
    ].map((t) => ({ ...t, estTokensSaved: Math.round(t.estTokensSaved * f) })),
    byRule: [
      { rule: 'collapse-whitespace', bytesSaved: 2_993_000_000, hits: 38000 },
      { rule: 'strip-ansi', bytesSaved: 2_205_000_000, hits: 21000 },
      { rule: 'truncate-logs', bytesSaved: 1_544_000_000, hits: 15400 },
      { rule: 'dedupe-lines', bytesSaved: 851_000_000, hits: 9200 },
    ],
    errors: [
      { skipReason: 'no_gain', count: 9100 },
      { skipReason: 'oversized', count: 4200 },
      { skipReason: 'already_compressed', count: 1914 },
    ],
    cacheHealth: {
      cacheReadTokens: 1_840_000_000,
      cacheCreateTokens: 142_000_000,
      hitRatio: 0.928,
    },
  };
}

// A believable 14-day daily series that trends up; scaled by the ramp factor.
function buildDaily(f) {
  const base = [62, 41, 73, 58, 90, 120, 84, 66, 102, 138, 96, 150, 118, 168]; // relative weights, newest last
  const days = [];
  // Fixed anchor date so renders are deterministic (no Date.now()).
  const anchor = Date.UTC(2026, 5, 26); // 2026-06-26
  const sum = base.reduce((a, b) => a + b, 0);
  for (let i = 0; i < base.length; i++) {
    const d = new Date(anchor - (base.length - 1 - i) * 86400000);
    const day = d.toISOString().slice(0, 10);
    const w = (base[i] / sum) * f;
    days.push({
      day,
      bytesIn: Math.round(REAL.bytesIn * w),
      bytesOut: Math.round(REAL.bytesOut * w),
      estTokensSaved: Math.round(REAL.estTokensSaved * w),
      estCostSavedUsd: +(REAL.estCostSavedUsd * w).toFixed(2),
      ratio: RATIO,
    });
  }
  return days;
}

// --- sanitized accounts ---
const ACCOUNTS = [
  {
    id: 'org-acme',
    accountUuid: 'acc-1111',
    email: 'alex@acme.dev',
    displayName: 'Alex Rivera',
    orgUuid: 'org-acme',
    orgName: 'Acme Labs',
    planType: 'max',
    isActive: true,
    createdAt: 1739000000000,
    color: '#007AFF',
  },
  {
    id: 'org-acme-team',
    accountUuid: 'acc-2222',
    email: 'alex@acme-team.dev',
    displayName: 'Acme Team',
    orgUuid: 'org-team',
    orgName: 'Acme Team',
    planType: 'team',
    isActive: false,
    createdAt: 1739500000000,
    color: '#32D74B',
  },
  {
    id: 'usr-side',
    accountUuid: 'acc-3333',
    email: 'alex@hey.dev',
    displayName: 'Alex (Pro)',
    orgUuid: 'usr-side',
    orgName: 'Personal',
    planType: 'pro',
    isActive: false,
    createdAt: 1740000000000,
    color: '#FF9F0A',
  },
];

// --- settings: start from the user's real settings.json, override demo bits ---
function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(readFileSync(path.join(os.homedir(), '.sentinel', 'settings.json'), 'utf8'));
  } catch {
    s = {};
  }
  return {
    ...s,
    theme: 'dark', // bookends are dark; keep the app on-brand regardless of OS pref
    switchingMode: 'manual', // demo starts Manual so the accounts/switching clips can flip to Auto
    compressionEnabled: true,
    compressionLevel: 'aggressive',
    compressionRetrievalEnabled: true,
    optimizeSubTab: 'compression',
    optimizeUnits: 'tokens',
    poolExcludedIds: [],
    budgetWeeklyUsdByAccount: { 'org-acme': 100 },
    budgetWeeklyUsdGlobal: null,
    isolationPolicy: {
      enabled: true,
      syncToClaudeCode: true,
      enforceCodeMode: true,
      network: {
        allowedDomains: ['api.github.com', 'registry.npmjs.org', 'pypi.org'],
        deniedDomains: [],
      },
      filesystem: {
        allowWrite: ['~/work/acme-api', '/tmp/claude'],
        denyWrite: ['~/.ssh', '~/.aws'],
        denyRead: ['~/.ssh/id_rsa'],
        allowRead: [],
      },
      credentials: {
        files: ['~/.aws/credentials', '~/.config/gh/hosts.yml'],
        envVars: ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN'],
      },
    },
  };
}
let settings = loadSettings();

const RETRIEVAL = {
  installed: true,
  toolName: 'mcp__sentinel__retrieve',
  url: 'http://127.0.0.1:47284/mcp',
  installs: [{ scope: 'user', directory: null, installedAt: 1780330101553 }],
};

const EMPTY_OPT_METRICS = {
  totals: {
    savingsUsdRealized: 0,
    savingsUsdPotential: 0,
    tokensRealized: 0,
    tokensPotential: 0,
    hypotheticalInputTokens: 0,
    opportunities: 0,
    installs: 0,
  },
  daily: [],
  bySubagent: [],
  dailyBySubagent: [],
  byPattern: [],
};

// ---- dashboard fixtures (sanitized, realistic shapes) ----
const SEC = () => Math.floor(Date.now() / 1000);
const MS = () => Date.now();
const HOUR = 3600;
const DAY = 86400;
const ANCHOR = Date.UTC(2026, 5, 26); // deterministic-ish series anchor

// Per-account rate-limit windows. utilization 0..1; reset = unix SECONDS.
function rateLimits() {
  const now = SEC();
  const win = (name, util, resetIn) => ({
    name,
    status: 'allowed',
    utilization: util,
    limit: null,
    remaining: null,
    reset: now + resetIn,
    inUse: false,
    lastUpdated: MS(),
  });
  return {
    'org-acme': [
      win('unified-5h', 0.62, Math.round(2.4 * HOUR)),
      win('unified-7d', 0.38, Math.round(4.1 * DAY)),
      win('unified-7d_oi', 0.71, Math.round(2.4 * HOUR)),
      win('unified-overage', 0.42, Math.round(12 * DAY)),
    ],
    'org-acme-team': [
      win('unified-5h', 0.41, Math.round(3.2 * HOUR)),
      win('unified-7d', 0.55, Math.round(5.0 * DAY)),
      win('unified-7d_oi', 0.33, Math.round(3.2 * HOUR)),
    ],
    'usr-side': [
      win('unified-5h', 0.78, Math.round(1.3 * HOUR)),
      win('unified-7d', 0.62, Math.round(2.6 * DAY)),
    ],
  };
}

function claudeAiUsage(accountId) {
  const iso = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const snap = {
    'org-acme': {
      fiveHourUtilization: 0.62,
      fiveHourResetsAt: iso(2.4),
      sevenDayUtilization: 0.38,
      sevenDayResetsAt: iso(98),
      sevenDayFableUtilization: 0.71,
      sevenDayFableResetsAt: iso(2.4),
      extraUsage: {
        isEnabled: true,
        limitUsd: 100,
        usedUsd: 42.18,
        utilizationPct: 42,
        currency: 'USD',
      },
      perUserBudget: null,
      fetchedAt: MS(),
    },
    'org-acme-team': {
      fiveHourUtilization: 0.41,
      fiveHourResetsAt: iso(3.2),
      sevenDayUtilization: 0.55,
      sevenDayResetsAt: iso(120),
      sevenDayFableUtilization: 0.33,
      sevenDayFableResetsAt: iso(3.2),
      extraUsage: {
        isEnabled: true,
        limitUsd: 500,
        usedUsd: 218.4,
        utilizationPct: 44,
        currency: 'USD',
      },
      perUserBudget: { limitUsd: 75, usedUsd: 31.5 },
      fetchedAt: MS(),
    },
    'usr-side': {
      fiveHourUtilization: 0.78,
      fiveHourResetsAt: iso(1.3),
      sevenDayUtilization: 0.62,
      sevenDayResetsAt: iso(62),
      sevenDayFableUtilization: null,
      sevenDayFableResetsAt: null,
      extraUsage: null,
      perUserBudget: null,
      fetchedAt: MS(),
    },
  };
  return { snapshot: snap[accountId] ?? snap['org-acme'], error: null };
}

function metricsSummary() {
  const w = [0.5, 0.7, 0.6, 0.9, 1.1, 0.8, 0.6, 1.0, 1.3, 0.9, 1.4, 1.1, 1.6, 1.2];
  const byDayModel = {};
  const promptsPerDay = {};
  for (let i = 0; i < w.length; i++) {
    const day = new Date(ANCHOR - (w.length - 1 - i) * 86400000).toISOString().slice(0, 10);
    byDayModel[day] = {
      'claude-sonnet-4-6': {
        costUsd: +(18 * w[i]).toFixed(2),
        inputTokens: Math.round(120000 * w[i]),
        outputTokens: Math.round(38000 * w[i]),
        cacheReadTokens: Math.round(2_400_000 * w[i]),
        cacheCreationTokens: Math.round(180000 * w[i]),
      },
      'claude-opus-4-6': {
        costUsd: +(34 * w[i]).toFixed(2),
        inputTokens: Math.round(60000 * w[i]),
        outputTokens: Math.round(22000 * w[i]),
        cacheReadTokens: Math.round(1_100_000 * w[i]),
        cacheCreationTokens: Math.round(90000 * w[i]),
      },
    };
    promptsPerDay[day] = { count: 20 + ((i * 7) % 28), avgLength: 320 + ((i * 11) % 180) };
  }
  const promptsTotal = Object.values(promptsPerDay).reduce((a, b) => a + b.count, 0);
  return {
    days: 14,
    accountId: 'org-acme',
    scope: { kind: 'account', id: 'org-acme' },
    byDayModel,
    cacheHitRate: {
      'claude-sonnet-4-6': { cacheRead: 31_000_000, input: 1_680_000, rate: 0.949 },
      'claude-opus-4-6': { cacheRead: 14_300_000, input: 820_000, rate: 0.946 },
    },
    errors: { byDay: {}, retryExhaustedCount: 0 },
    tools: [
      { toolName: 'Bash', calls: 1840, successRate: 0.97, p50Ms: 120, p95Ms: 880, topError: null },
      { toolName: 'Read', calls: 1320, successRate: 0.995, p50Ms: 30, p95Ms: 140, topError: null },
      {
        toolName: 'Edit',
        calls: 760,
        successRate: 0.93,
        p50Ms: 45,
        p95Ms: 210,
        topError: 'string not found',
      },
      { toolName: 'Grep', calls: 540, successRate: 0.99, p50Ms: 60, p95Ms: 240, topError: null },
    ],
    activity: {
      sessionsPerDay: {},
      commitsPerDay: {},
      prsPerDay: {},
      linesPerDay: {},
      activeTimePerDay: {},
    },
    editAcceptRate: { overall: { accepts: 712, rejects: 48, rate: 0.937 }, byLanguage: {} },
    toolDecisions: { overall: { accepts: 0, rejects: 0, rate: 0 }, byTool: {}, bySource: {} },
    prompts: { total: promptsTotal, avgLength: 412, perDay: promptsPerDay },
    skills: [],
    plugins: [],
    cacheTtl: { byDayModel: {}, bySession: [] },
  };
}

function optMetrics() {
  const w = [0.4, 0.6, 0.5, 0.8, 1.0, 0.7, 0.9, 1.2, 0.8, 1.3, 1.0, 1.5, 1.1, 1.6];
  const daily = w.map((wi, i) => ({
    day: new Date(ANCHOR - (w.length - 1 - i) * 86400000).toISOString().slice(0, 10),
    savingsRealized: +(6.2 * wi).toFixed(2),
    savingsPotential: +(3.1 * wi).toFixed(2),
    tokensRealized: Math.round(480000 * wi),
    tokensPotential: Math.round(240000 * wi),
  }));
  return {
    totals: {
      savingsUsdRealized: 612.48,
      savingsUsdPotential: 318.96,
      tokensRealized: 48_900_000,
      tokensPotential: 23_400_000,
      hypotheticalInputTokens: 61_200_000,
      opportunities: 1284,
      installs: 3,
    },
    daily,
    bySubagent: [
      {
        curatedId: 'file-explorer',
        savingsRealized: 286.4,
        savingsPotential: 120.2,
        tokensRealized: 22_800_000,
        tokensPotential: 9_600_000,
        opportunities: 612,
      },
      {
        curatedId: 'log-analyzer',
        savingsRealized: 198.7,
        savingsPotential: 96.5,
        tokensRealized: 15_300_000,
        tokensPotential: 7_400_000,
        opportunities: 402,
      },
      {
        curatedId: 'bulk-reader',
        savingsRealized: 127.4,
        savingsPotential: 102.3,
        tokensRealized: 10_800_000,
        tokensPotential: 6_400_000,
        opportunities: 270,
      },
    ],
    dailyBySubagent: [],
    byPattern: [
      {
        pattern: 'short_turn_after_large_read',
        opportunities: 740,
        savingsRealized: 312.1,
        savingsPotential: 150.0,
        tokensRealized: 24_000_000,
        tokensPotential: 11_000_000,
      },
      {
        pattern: 'repeated_log_grep',
        opportunities: 544,
        savingsRealized: 300.4,
        savingsPotential: 168.9,
        tokensRealized: 24_900_000,
        tokensPotential: 12_400_000,
      },
    ],
  };
}

function mcpContextCosts() {
  const insight = (server, projects, bytes, tokens, tools, reqs, calls, bridgeStatus, recs) => ({
    server,
    projects,
    mcpJsonProjects: [],
    enabled: true,
    global: server === 'github',
    managed: true,
    definition: { bytes, estTokens: tokens, toolCount: tools, requestCount: reqs, measured: true },
    usage7d: { calls, bytesIn: calls * 36000, bytesOut: calls * 14000, estTokens: calls * 9000 },
    cacheWriteEstUsd: +(tokens / 650).toFixed(1),
    recommendations: recs,
    bridgeStatus,
  });
  return {
    insights: [
      insight('github', ['acme-web', 'acme-api'], 48200, 12050, 26, 880, 142, 'native', [
        { kind: 'code-mode' },
      ]),
      insight('linear', ['acme-web'], 21400, 5350, 11, 410, 38, 'native', [{ kind: 'unused' }]),
      insight('playwright', ['acme-web'], 33600, 8400, 18, 300, 64, 'bridged', []),
    ],
    nativeDefBytes: 28400,
    measuredRequests: 1280,
    savings: {
      realized: { estTokens: 9_400_000, estUsd: 121.7 },
      potential: { estTokens: 14_800_000, estUsd: 192.4 },
      byServer: [
        { server: 'github', estTokens: 6_200_000, estUsd: 80.6, requests: 880 },
        { server: 'playwright', estTokens: 3_200_000, estUsd: 41.1, requests: 300 },
      ],
    },
  };
}

const CODE_MODE_STATUS = {
  enabled: true,
  skillInstalled: true,
  migrations: [],
  endpointUrl: 'http://127.0.0.1:47284/code-mode',
  workspaceDir: '/Users/alex/.sentinel/code-mode',
};
function codeModeAudit() {
  const now = MS();
  return [
    {
      ts: now - 120000,
      server: 'github',
      tool: 'create_issue',
      ok: true,
      bytesOut: 1840,
      durationMs: 312,
    },
    {
      ts: now - 300000,
      server: 'github',
      tool: 'list_prs',
      ok: true,
      bytesOut: 9200,
      durationMs: 540,
    },
    {
      ts: now - 900000,
      server: 'playwright',
      tool: 'navigate',
      ok: true,
      bytesOut: 420,
      durationMs: 1180,
    },
  ];
}

// ---- Batch B interaction fixtures (security / rules / sandbox / alerts) ----

// Synthesize the OAuthAccount the `account_switched` broadcast carries from an
// AccountInfo row (mirrors the app's accountInfoToOAuth helper).
function toOAuth(a) {
  const iso = new Date(a.createdAt).toISOString();
  return {
    accountUuid: a.accountUuid,
    emailAddress: a.email,
    organizationUuid: a.orgUuid,
    hasExtraUsageEnabled: a.planType !== 'pro',
    billingType: a.planType,
    accountCreatedAt: iso,
    subscriptionCreatedAt: iso,
    displayName: a.displayName,
    organizationRole: 'owner',
    workspaceRole: null,
    organizationName: a.orgName,
  };
}

let secId = 100;
function secEvent(o) {
  const now = MS();
  return {
    id: secId++,
    ts: o.ts ?? now,
    lastSeenTs: o.ts ?? now,
    accountId: o.accountId ?? 'org-acme',
    sessionId: 'sess-demo',
    direction: o.direction ?? 'outbound',
    severity: o.severity ?? 'medium',
    kind: o.kind ?? 'secret',
    detectorId: o.detectorId ?? 'demo-detector-v1',
    confidence: o.confidence ?? 0.95,
    title: o.title,
    reason: o.reason ?? '',
    matchMask: o.matchMask ?? null,
    matchHash: `h${secId}`,
    contextHash: null,
    snippet: o.snippet ?? null,
    sourceHint: o.sourceHint ?? null,
    details: null,
    occurrences: o.occurrences ?? 1,
    blocked: o.blocked ?? false,
    approved: false,
    acknowledged: false,
    provenance: o.provenance ?? 'conversation',
    resolution: o.resolution ?? null,
  };
}
function seedSecurityEvents() {
  const m = 60000,
    h = 3600000;
  return [
    secEvent({
      ts: MS() - 4 * m,
      severity: 'high',
      kind: 'secret',
      detectorId: 'aws-access-key-v1',
      title: 'AWS access key',
      reason: 'A live-looking AWS access key id appeared in a file Claude was about to read.',
      matchMask: 'AKIA…[16 redacted]…AB12',
      sourceHint: 'config/prod.env',
      provenance: 'file-read',
      blocked: true,
      resolution: 'user_deny',
    }),
    secEvent({
      ts: MS() - 22 * m,
      severity: 'high',
      kind: 'prompt_injection',
      detectorId: 'inject-marker-v2',
      title: 'Prompt-injection marker in tool output',
      reason: 'Fetched web content tried to issue instructions to the agent.',
      matchMask: 'ignore previous instructions',
      sourceHint: 'WebFetch(docs.example.com)',
      direction: 'tool_use',
      provenance: 'tool-result',
      occurrences: 3,
    }),
    secEvent({
      ts: MS() - 51 * m,
      severity: 'medium',
      kind: 'pii',
      detectorId: 'email-v1',
      title: 'Email address',
      reason: 'A customer email address was about to leave the machine in a prompt.',
      matchMask: 'a…[9 redacted]…m',
      sourceHint: 'messages[4].content',
      provenance: 'conversation',
    }),
    secEvent({
      ts: MS() - 2 * h,
      severity: 'high',
      kind: 'risky_bash',
      detectorId: 'risky-bash-v1',
      title: 'Risky shell command',
      reason: 'A recursive force-remove was staged as a Bash tool call.',
      matchMask: 'rm -rf ./build',
      sourceHint: 'Bash',
      provenance: 'tool-use',
    }),
    secEvent({
      ts: MS() - 5 * h,
      severity: 'medium',
      kind: 'secret',
      detectorId: 'slack-webhook-v1',
      title: 'Slack webhook URL',
      reason: 'A Slack incoming-webhook secret was detected in an outbound request.',
      matchMask: 'https://hooks.slack.com/…/[redacted]',
      sourceHint: 'WebFetch',
      provenance: 'tool-use',
      occurrences: 2,
    }),
  ];
}
let securityEvents = seedSecurityEvents();

function rule(decision, tool, pattern, note, source = 'local', priority = 100) {
  const raw = pattern ? `${tool}(${pattern})` : tool;
  return {
    id: `rule-${raw}`,
    decision,
    tool,
    pattern: pattern ?? null,
    raw,
    note: note ?? null,
    enabled: true,
    priority,
    createdAt: MS() - 86400000,
    source,
    projectScope: null,
  };
}
function seedRules() {
  return [
    rule('deny', 'Bash', 'rm -rf *', 'Never let an agent recursively force-remove.'),
    rule('deny', 'Bash', 'curl * | sh', 'Block pipe-to-shell installers.'),
    rule('deny', 'WebFetch', 'http://*', 'No plaintext HTTP exfiltration.', 'claude-code'),
    rule('ask', 'Bash', 'npm publish *', 'Hold publishes for a human.'),
    rule('ask', 'Write', '/etc/**', 'Confirm writes outside the project.'),
    rule('allow', 'Read', '//**', 'Reads are always fine.', 'local', 50),
    rule('allow', 'Bash', 'git *', 'Git is trusted.', 'local', 50),
  ];
}
let permissionRules = seedRules();

const SANDBOX_CAPABILITY = {
  platform: 'darwin',
  capability: 'full',
  reasons: [],
  dependencies: [
    { name: 'sandbox-exec', present: true },
    { name: 'ripgrep', present: true },
  ],
};
function sandboxSyncStatus() {
  return { active: true, lastPulledAt: MS() - 90000, lastPushedAt: MS() - 45000, lastError: null };
}

function seedAlerts() {
  return [
    {
      id: 1,
      scope: 'account',
      accountId: 'org-acme',
      thresholdPct: 80,
      enabled: true,
      lastTriggeredResetTs: null,
      createdAt: MS() - 5 * 86400000,
    },
    {
      id: 2,
      scope: 'pool',
      accountId: null,
      thresholdPct: 90,
      enabled: true,
      lastTriggeredResetTs: null,
      createdAt: MS() - 3 * 86400000,
    },
    {
      id: 3,
      scope: 'account',
      accountId: 'usr-side',
      thresholdPct: 75,
      enabled: true,
      lastTriggeredResetTs: MS() - 7200000,
      createdAt: MS() - 6 * 86400000,
    },
  ];
}
let alerts = seedAlerts();
let alertSeq = 100;

let notifId = 200;
function seedNotifications() {
  return [
    {
      id: notifId++,
      ts: MS() - 8 * 60000,
      accountId: 'usr-side',
      type: 'usage_alert',
      title: 'Alex (Pro) at 78%',
      body: 'Crossed your 75% threshold on the 5-hour window.',
      acknowledged: false,
    },
    {
      id: notifId++,
      ts: MS() - 95 * 60000,
      accountId: 'org-acme',
      type: 'security_high',
      title: 'AWS access key blocked',
      body: 'A live-looking AWS key was held before it left your machine.',
      acknowledged: false,
    },
    {
      id: notifId++,
      ts: MS() - 4 * 3600000,
      accountId: 'org-acme',
      type: 'account_switched',
      title: 'Switched to Alex Rivera',
      body: 'Auto mode routed to the account resetting soonest.',
      acknowledged: true,
    },
    {
      id: notifId++,
      ts: MS() - 9 * 3600000,
      accountId: 'org-acme',
      type: 'overage_entered',
      title: 'Entered overage',
      body: 'Acme Labs crossed into paid overage; $42.18 of $100 used.',
      acknowledged: true,
    },
  ];
}
let notifications = seedNotifications();

function handle(msg) {
  switch (msg.type) {
    case 'get_settings':
      return settings;
    case 'get_accounts':
      return ACCOUNTS;
    case 'refresh_accounts':
      return ACCOUNTS;
    case 'get_removed_accounts':
      return [];
    case 'get_compression_metrics':
      return compressionMetrics();
    case 'get_retrieval_mcp_status':
      return RETRIEVAL;
    case 'get_optimization_metrics':
      return optMetrics();
    case 'get_optimization_opportunities':
      return [];
    case 'list_optimization_events':
      return { events: [], total: 0 };
    case 'list_installed_subagents':
      return [];
    case 'get_curated_library':
      return [];
    case 'get_processed_tokens':
      return 61_200_000;
    case 'get_all_rate_limits':
      return rateLimits();
    case 'get_rate_limits': {
      // UsageView fetches the singular form: scoped to msg.accountId when a
      // specific account is picked, else the active account's windows.
      const all = rateLimits();
      const id = msg.accountId ?? ACCOUNTS.find((a) => a.isActive)?.id ?? ACCOUNTS[0].id;
      return all[id] ?? [];
    }
    case 'get_claude_ai_usage':
      return claudeAiUsage(msg.accountId);
    case 'get_metrics_summary':
      return metricsSummary();
    case 'get_mcp_context_costs':
      return mcpContextCosts();
    case 'get_code_mode_status':
      return CODE_MODE_STATUS;
    case 'get_code_mode_audit':
      return codeModeAudit();
    // --- Batch B: security / rules / sandbox / alerts ---
    case 'get_security_events': {
      let evs = securityEvents.slice().sort((a, b) => b.ts - a.ts);
      if (!msg.includeWeakSignals) evs = evs.filter((e) => e.confidence >= 0.7);
      if (msg.severity) evs = evs.filter((e) => e.severity === msg.severity);
      if (Array.isArray(msg.kinds) && msg.kinds.length)
        evs = evs.filter((e) => msg.kinds.includes(e.kind));
      if (msg.search) {
        const q = String(msg.search).toLowerCase();
        evs = evs.filter((e) => (e.title + e.reason).toLowerCase().includes(q));
      }
      if (typeof msg.beforeTs === 'number') evs = evs.filter((e) => e.ts < msg.beforeTs);
      return evs.slice(0, msg.limit ?? 50);
    }
    case 'list_pending_blocks':
      return [];
    case 'get_detector_stats':
      return { byDetector: [], total: securityEvents.length };
    case 'approve_blocked_request':
      broadcast({ type: 'security_block_resolved', pendingId: msg.pendingId, outcome: 'approve' });
      return { ok: true };
    case 'deny_blocked_request':
      broadcast({ type: 'security_block_resolved', pendingId: msg.pendingId, outcome: 'deny' });
      return { ok: true };
    case 'list_permission_rules':
      return permissionRules;
    case 'upsert_permission_rule': {
      const r = msg.rule ?? msg;
      const raw = r.raw ?? (r.pattern ? `${r.tool}(${r.pattern})` : r.tool);
      const idx = permissionRules.findIndex((x) => x.raw === raw);
      const merged = {
        ...rule(
          r.decision,
          r.tool,
          r.pattern ?? null,
          r.note ?? null,
          r.source ?? 'local',
          r.priority ?? 100,
        ),
        ...(idx >= 0
          ? { id: permissionRules[idx].id, createdAt: permissionRules[idx].createdAt }
          : {}),
      };
      if (idx >= 0) permissionRules[idx] = merged;
      else permissionRules = [merged, ...permissionRules];
      broadcast({ type: 'permission_rules_changed', rules: permissionRules });
      return merged;
    }
    case 'delete_permission_rule':
      permissionRules = permissionRules.filter((x) => x.id !== msg.id && x.raw !== msg.raw);
      broadcast({ type: 'permission_rules_changed', rules: permissionRules });
      return { ok: true };
    case 'get_sandbox_status':
      return sandboxSyncStatus();
    case 'get_sandbox_capability':
      return SANDBOX_CAPABILITY;
    case 'list_alerts': {
      const s = msg.scope;
      return alerts.filter(
        (a) =>
          a.scope === s &&
          (s === 'pool' ||
            s === 'pool-weekly' ||
            a.accountId === msg.accountId ||
            msg.accountId === undefined),
      );
    }
    case 'upsert_alert': {
      const idx = alerts.findIndex(
        (a) =>
          (msg.id != null && a.id === msg.id) ||
          (a.scope === msg.scope && a.accountId === (msg.accountId ?? null)),
      );
      const merged = {
        id: idx >= 0 ? alerts[idx].id : ++alertSeq,
        scope: msg.scope ?? 'account',
        accountId: msg.accountId ?? null,
        thresholdPct: msg.thresholdPct,
        enabled: msg.enabled ?? true,
        lastTriggeredResetTs: idx >= 0 ? alerts[idx].lastTriggeredResetTs : null,
        createdAt: idx >= 0 ? alerts[idx].createdAt : MS(),
        ...(msg.budgetScope ? { budgetScope: msg.budgetScope } : {}),
      };
      if (idx >= 0) alerts[idx] = merged;
      else alerts = [...alerts, merged];
      return merged;
    }
    case 'delete_alert':
      alerts = alerts.filter((a) => a.id !== msg.id);
      return { ok: true };
    case 'get_notifications': {
      let ns = notifications.slice().sort((a, b) => b.ts - a.ts);
      if (msg.accountId !== undefined) ns = ns.filter((n) => n.accountId === msg.accountId);
      if (Array.isArray(msg.types) && msg.types.length)
        ns = ns.filter((n) => msg.types.includes(n.type));
      return ns.slice(0, msg.limit ?? 50);
    }
    case 'acknowledge_notification':
      notifications = notifications.map((n) =>
        n.id === msg.id ? { ...n, acknowledged: true } : n,
      );
      return { ok: true };
    case 'acknowledge_all_notifications':
      notifications = notifications.map((n) =>
        msg.accountId === undefined || n.accountId === msg.accountId
          ? { ...n, acknowledged: true }
          : n,
      );
      return { ok: true };
    case 'update_settings':
      settings = { ...settings, ...(msg.settings ?? {}) };
      broadcast({ type: 'settings_changed', settings });
      return settings;
    default:
      return null; // permissive: components guard on success && data
  }
}

// --- SSE plumbing ---
const sseClients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      /* dropped */
    }
  }
}

let rampTimer = null;
function startRamp(from = RAMP_FROM, ms = RAMP_MS) {
  if (rampTimer) return;
  ramp = from;
  broadcast({ type: 'compression_metrics_updated' }); // snap to the low value first
  const t0 = Date.now();
  rampTimer = setInterval(() => {
    const p = Math.min(1, (Date.now() - t0) / ms);
    ramp = from + (1 - from) * (1 - Math.pow(1 - p, 3));
    broadcast({ type: 'compression_metrics_updated' });
    if (p >= 1) {
      clearInterval(rampTimer);
      rampTimer = null;
    }
  }, RAMP_STEP_MS);
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve the macOS-desktop stage page, templating the app iframe URL.
  if (req.method === 'GET' && req.url && req.url.startsWith('/stage')) {
    const appUrl =
      new URL(req.url, `http://localhost:${PORT}`).searchParams.get('app') ||
      'http://localhost:5180';
    let html;
    try {
      html = readFileSync(STAGE_HTML, 'utf8').replaceAll('%%APP_URL%%', appUrl);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }

  // Serve the real brand assets referenced by the stage chrome.
  if (req.method === 'GET' && req.url && ASSETS[req.url.split('?')[0]]) {
    const a = ASSETS[req.url.split('?')[0]];
    try {
      const buf = readFileSync(a.file);
      res.writeHead(200, { 'Content-Type': a.type, 'Cache-Control': 'no-cache' });
      res.end(buf);
    } catch (e) {
      res.writeHead(404);
      res.end(String(e));
    }
    return;
  }

  if (req.method === 'GET' && req.url && req.url.startsWith('/events')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const ka = setInterval(() => {
      try {
        res.write(': ka\n\n');
      } catch {
        /* */
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(ka);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('POST or GET /events');
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let msg;
  try {
    msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: String(e) }));
    return;
  }

  if (msg.type === '__demo_ramp') {
    startRamp(
      typeof msg.from === 'number' ? msg.from : undefined,
      typeof msg.ms === 'number' ? msg.ms : undefined,
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (msg.type === '__demo_ramp_set') {
    // Freeze the savings totals at a fixed fraction (no timer) so a recipe can
    // mount the panel showing a low number, then trigger __demo_ramp to climb.
    if (rampTimer) {
      clearInterval(rampTimer);
      rampTimer = null;
    }
    ramp = typeof msg.value === 'number' ? msg.value : RAMP_FROM;
    broadcast({ type: 'compression_metrics_updated' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (msg.type === '__demo_reset') {
    ramp = RAMP_FROM;
    settings = loadSettings();
    securityEvents = seedSecurityEvents();
    permissionRules = seedRules();
    alerts = seedAlerts();
    notifications = seedNotifications();
    ACCOUNTS.forEach((a) => {
      a.isActive = a.id === 'org-acme';
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (msg.type === '__demo_security_event') {
    const ev = secEvent({
      ts: MS(),
      severity: msg.severity ?? 'high',
      kind: msg.kind ?? 'secret',
      detectorId: msg.detectorId ?? 'demo-live-v1',
      title: msg.title ?? 'Live finding',
      reason: msg.reason ?? 'Caught in flight as the request passed through the proxy.',
      matchMask: msg.matchMask ?? null,
      sourceHint: msg.sourceHint ?? null,
      provenance: msg.provenance ?? 'tool-use',
      blocked: msg.blocked ?? false,
    });
    securityEvents = [ev, ...securityEvents];
    broadcast({
      type: 'security_event_detected',
      accountId: ev.accountId,
      severity: ev.severity,
      kind: ev.kind,
      title: ev.title,
      blocked: ev.blocked,
      eventId: ev.id,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: ev.id }));
    return;
  }
  if (msg.type === '__demo_security_block') {
    const pending = {
      pendingId: msg.pendingId ?? `pb-${MS()}`,
      accountId: msg.accountId ?? 'org-acme',
      severity: msg.severity ?? 'high',
      title: msg.title ?? 'Tool blocked: Bash(rm -rf *)',
      blockReason: msg.blockReason ?? 'A deny rule matched this tool call.',
      matchMask: msg.matchMask ?? 'Bash(rm -rf *)',
      detectorId: msg.detectorId ?? 'permission-rule',
      expiresAt: MS() + (msg.ttlMs ?? 60000),
      source: msg.source ?? 'permissions_tool_use',
      toolName: msg.toolName ?? 'Bash',
      toolInputFields: msg.toolInputFields ?? { command: 'rm -rf ./build' },
      provenance: msg.provenance ?? {
        createdAt: MS() - 86400000,
        source: 'local',
        ruleId: 'rule-Bash(rm -rf *)',
      },
    };
    broadcast({ type: 'security_block_pending', pending });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pendingId: pending.pendingId }));
    return;
  }
  if (msg.type === '__demo_route') {
    const target = ACCOUNTS.find((a) => a.id === msg.accountId) ?? ACCOUNTS[0];
    ACCOUNTS.forEach((a) => {
      a.isActive = a.id === target.id;
    });
    broadcast({ type: 'routed_account_changed', accountId: target.id });
    broadcast({ type: 'account_switched', to: toOAuth(target) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, accountId: target.id }));
    return;
  }
  if (msg.type === '__demo_spend') {
    broadcast({
      type: 'spend_update',
      perAccount: msg.perAccount ?? { 'org-acme': 92.4, 'org-acme-team': 31.5, 'usr-side': null },
      global: msg.global ?? 123.9,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (msg.type === '__demo_pause') {
    broadcast({
      type: 'account_paused',
      accountId: msg.accountId ?? 'org-acme',
      reason: msg.reason ?? 'sentinel_budget',
      resetsAt: msg.resetsAt ?? SEC() + Math.round(2.4 * HOUR),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (msg.type === '__demo_alert') {
    const n = {
      id: notifId++,
      ts: MS(),
      accountId: msg.accountId ?? 'org-acme',
      type: 'usage_alert',
      title: msg.title ?? 'Acme Labs at 80%',
      body: msg.body ?? 'Crossed your 80% threshold on the 5-hour window.',
      acknowledged: false,
    };
    notifications = [n, ...notifications];
    broadcast({
      type: 'alert_triggered',
      alertId: msg.alertId ?? 1,
      accountId: msg.accountId ?? 'org-acme',
      scope: msg.scope ?? 'account',
      thresholdPct: msg.thresholdPct ?? 80,
      utilization: msg.utilization ?? 0.82,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const data = handle(msg);
  const body = { requestType: msg.type, success: true, data };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-bridge listening http://127.0.0.1:${PORT}`);
});
