#!/usr/bin/env node
/**
 * Trigger synthetic user-visible alert scenarios against the running daemon.
 *
 * Every scenario dispatches via the `dev_trigger_alert_event` IPC through
 * the same `insertNotification` + `ipcServer.broadcast` pair the real
 * evaluators emit. No state pollution — synthetic triggers do NOT mutate
 * the real alert-row `last_triggered_reset_ts` or the SpendTracker's
 * paused set, so you can run any scenario repeatedly without affecting
 * production alert behavior.
 *
 * Two scenarios have documented divergences from live behavior:
 *   - `account-switched` — the live path is broadcast-only (no Alerts-tab
 *     row). The synthetic scenario inserts a row so the event is visible
 *     from the Alerts history.
 *   - `account-unpaused` — broadcast-only by design, matching live.
 *
 * Usage:
 *   pnpm alerts:test <scenario>
 *   pnpm alerts:test --list
 *   pnpm alerts:test --help
 */
import net from 'net';
import path from 'path';
import os from 'os';

// ─── Scenarios ────────────────────────────────────────────────────────
const SCENARIOS = {
  'usage-account': {
    description:
      'Per-account usage alert (threshold crossed). Fires alert_triggered + usage_alert notification.',
  },
  'usage-pool': {
    description: 'Pool-wide usage alert (round-robin pool-average).',
  },
  'usage-budget': {
    description:
      'Budget-scope spend alert (per-account weekly cap). Carries spendUsd/budgetUsd for the UI.',
  },
  'overage-entered': {
    description:
      'Account enters overage. Fires overage_entered broadcast + notification + OS notification.',
  },
  'overage-disabled': {
    description:
      'Overage cap hit / disabled. Fires overage_disabled broadcast + notification + OS notification.',
  },
  'account-switched': {
    description:
      'Active-account switch. Diverges from live: synthetic inserts a history row for verifiability.',
  },
  'account-paused': {
    description: 'Account paused on spend cap (SpendTracker-style broadcast + usage_alert row).',
  },
  'account-unpaused': {
    description:
      'Account unpaused after window rolled. Broadcast only — no history row (mirrors live).',
  },
};

// ─── CLI ─────────────────────────────────────────────────────────────

function printHelp() {
  console.log(
    `
pnpm alerts:test <scenario>

Fires a synthetic user-visible alert scenario against the running daemon.
Results appear in the Alerts tab and (when configured) as OS notifications.

Flags:
  --list      Show every scenario with its description.
  --help      This message.

Synthetic triggers are safe to run repeatedly — they do not mutate real
alert state. See the module docstring for the account-switched /
account-unpaused behavioral notes.
`.trim(),
  );
}

function printList() {
  console.log('\nAvailable scenarios:\n');
  const namePad = Math.max(...Object.keys(SCENARIOS).map((n) => n.length));
  for (const [name, s] of Object.entries(SCENARIOS)) {
    console.log(`  ${name.padEnd(namePad)}  ${s.description}`);
  }
  console.log();
}

const arg = process.argv[2];

if (!arg || arg === '--help' || arg === '-h') {
  printHelp();
  process.exit(0);
}
if (arg === '--list' || arg === '-l') {
  printList();
  process.exit(0);
}

const scenario = SCENARIOS[arg];
if (!scenario) {
  console.error(`Unknown scenario: ${arg}`);
  console.error(`Run \`pnpm alerts:test --list\` to see the available scenarios.`);
  process.exit(1);
}

// ─── Delivery: IPC ────────────────────────────────────────────────────

function runIpc() {
  const sockPath =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\sentinel'
      : path.join(os.homedir(), '.sentinel', 'daemon.sock');
  const socket = net.connect(sockPath);
  const msg = { type: 'dev_trigger_alert_event', scenario: arg };
  let buf = '';
  socket.setEncoding('utf-8');
  socket.on('connect', () => {
    socket.write(JSON.stringify(msg) + '\n');
  });
  socket.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.requestType === msg.type) {
          if (parsed.success) {
            console.log(
              `[${arg}] ✓ Synthetic alert fired. Check the Alerts tab + OS notifications.`,
            );
          } else {
            console.error(`[${arg}] daemon returned error: ${parsed.error ?? 'unknown'}`);
          }
          socket.destroy();
          process.exit(parsed.success ? 0 : 1);
        }
      } catch {
        /* broadcast or malformed — ignore */
      }
    }
  });
  socket.on('error', (err) => {
    console.error(`[ipc] socket error: ${err.message}`);
    console.error('Is Sentinel running? If yes, quit and restart it with the latest build.');
    process.exit(1);
  });
  setTimeout(() => {
    console.error(`[ipc] timed out waiting for daemon response on ${sockPath}`);
    socket.destroy();
    process.exit(1);
  }, 5000);
}

runIpc();
