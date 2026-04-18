import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

// Resolve the version string shown in the app footer.
//   1. On a tagged CI build, GitHub Actions sets GITHUB_REF_TYPE=tag and
//      GITHUB_REF_NAME to the tag (e.g. "v0.2.0") — use that directly.
//   2. On a tagged local build, `git describe --tags --exact-match` returns
//      the tag.
//   3. Otherwise (untagged local dev), fall back to "dev".
function getAppVersion(): string {
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }
  try {
    const tag = execSync('git describe --tags --exact-match HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (tag) return tag;
  } catch {
    // HEAD is not on a tag — fall through.
  }
  return 'dev';
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(getAppVersion()),
  },
  // Vite dev server port must not conflict with the daemon (47284)
  server: {
    port: 5173,
    strictPort: true,
  },
  // Tauri expects a fixed output directory
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Resolve workspace packages
  resolve: {
    alias: {
      '@claude-sentinel/shared': '../shared/src/index.ts',
    },
  },
});
