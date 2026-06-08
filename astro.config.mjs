// @ts-check
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Update this to your real domain — used for the sitemap, RSS feed, and canonical URLs.
  site: 'https://snowmead.com',

  markdown: {
    // Astro 6.4's new pluggable Markdown pipeline, using the Rust-based Sätteri processor.
    // GFM, smart punctuation, frontmatter and heading IDs are on by default.
    processor: satteri(),
    // Sätteri auto-wires Shiki from this config. Dual themes + `defaultColor: false`
    // emit CSS variables so code blocks follow the site's light/dark toggle (see global.css).
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
      wrap: true,
    },
  },

  integrations: [sitemap()],

  vite: {
    plugins: [tailwindcss()],
  },
});
