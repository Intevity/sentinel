#!/usr/bin/env node
import { startDaemon } from './index.js';

const command = process.argv[2];

switch (command) {
  case 'start':
  case undefined:
    startDaemon()
      .then((handle) => {
        // Register signal handlers AFTER startup completes so signals
        // delivered mid-startup don't race with partially-wired subsystems
        // (matches the prior behavior where process.on was the last line
        // of startDaemon). shutdown() is idempotent, so a second signal
        // while the first cleanup is in flight is a safe no-op.
        const stop = async () => {
          try {
            await handle.shutdown();
          } finally {
            process.exit(0);
          }
        };
        process.on('SIGTERM', stop);
        process.on('SIGINT', stop);
      })
      .catch((err: unknown) => {
        console.error('[Sentinel] Fatal error:', err);
        process.exit(1);
      });
    break;

  default:
    console.error(`[Sentinel] Unknown command: ${command}`);
    console.error('Usage: sentinel [start]');
    process.exit(1);
}
