import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
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
