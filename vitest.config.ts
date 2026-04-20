import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        'vitest.config.ts',
        'eslint.config.js',
        // CLI entry points and external-integration modules (hard to unit test)
        'packages/daemon/src/cli.ts',
        'packages/daemon/src/index.ts',
        // Rate-limit probe: fires an HTTP request through the running proxy.
        // Extracted from index.ts into its own file to avoid a circular import
        // with usage-probe.ts; inherits index.ts's coverage exemption.
        'packages/daemon/src/rate-limit-probe.ts',
        // OAuth orchestration: opens browser, spins up local HTTP server, and
        // makes external API calls — better covered by integration tests.
        'packages/daemon/src/oauth.ts',
        // Shared types-only files (no runtime logic)
        'packages/shared/src/**',
        // App frontend (requires browser/Tauri)
        'packages/app/src/**',
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
