import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// Starlight reads its pages from the `docs` content collection. Every entry
// lives under `src/content/docs/docs/**`, so slugs start with `docs/` and the
// site renders them at `/sentinel/docs/...` — leaving the marketing homepage
// (`src/pages/index.astro`) in sole possession of the site root.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
