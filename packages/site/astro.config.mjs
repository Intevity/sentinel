import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

// GitHub Pages project site. The repo deploys to
// https://intevity.github.io/claude-sentinel/, so `base` must be the repo
// name; every internal link/asset is resolved against `import.meta.env.BASE_URL`
// (which is `/claude-sentinel/`). A custom domain would set base back to '/'.
export default defineConfig({
  site: 'https://intevity.github.io',
  base: '/claude-sentinel',
  output: 'static',
  // We own the full stylesheet (src/styles/global.css ships its own @tailwind
  // directives, theme tokens, and component layer), so disable the integration's
  // injected base to avoid a duplicate preflight.
  integrations: [react(), tailwind({ applyBaseStyles: false })],
});
