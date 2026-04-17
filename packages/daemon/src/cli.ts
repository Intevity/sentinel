#!/usr/bin/env node
import { startDaemon } from './index.js';

const command = process.argv[2];

switch (command) {
  case 'start':
  case undefined:
    startDaemon().catch((err: unknown) => {
      console.error('[Sentinel] Fatal error:', err);
      process.exit(1);
    });
    break;

  default:
    console.error(`[Sentinel] Unknown command: ${command}`);
    console.error('Usage: claude-sentinel [start]');
    process.exit(1);
}
