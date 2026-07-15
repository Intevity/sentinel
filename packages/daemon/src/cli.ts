#!/usr/bin/env node

const command = process.argv[2];

switch (command) {
  // stdio ⇄ HTTP MCP bridge for Claude Desktop (which only spawns stdio MCP
  // servers). Imported lazily so the bridge process doesn't pay the daemon's
  // full module graph on every spawn — Desktop starts one per session.
  case 'mcp-stdio':
    import('./mcp-stdio-bridge.js')
      .then(({ mcpStdioMain }) => mcpStdioMain())
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err: unknown) => {
        console.error('[Sentinel] mcp-stdio bridge error:', err);
        process.exit(1);
      });
    break;

  case 'start':
  case undefined:
    import('./index.js')
      .then(({ startDaemon }) => startDaemon())
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
    console.error('Usage: sentinel [start|mcp-stdio]');
    process.exit(1);
}
