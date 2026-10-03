// The standalone page of the change screen (src/ui/standalone): a Report
// embedded in the HTML, the screen mounted from it, every asset bundled. Built
// only for tests in phase 3 (`npm run build:standalone`, run by the e2e global
// setup); the product build (vite.config.ts) never includes it. The output
// opens from file://, so it is one classic script with a relative base: a
// module script is blocked from a file origin.

import { defineConfig, type Plugin } from 'vite';

/** `<script type="module" crossorigin>` becomes a deferred classic script, `crossorigin` is dropped from the stylesheet link. */
const classicScript = (): Plugin => ({
  name: 'diffcity-classic-script',
  enforce: 'post',
  transformIndexHtml: (html) => html.replaceAll(' type="module" crossorigin', ' defer').replaceAll(' crossorigin', ''),
});

export default defineConfig({
  root: 'src/ui/standalone',
  base: './',
  // No public/ copy: nothing in this entry is served as-is.
  publicDir: false,
  plugins: [classicScript()],
  build: {
    outDir: '../../../.tmp/standalone',
    emptyOutDir: true,
    // Fonts stay files: an inlined woff2 would hide them from the network check.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
    rollupOptions: { output: { format: 'iife' } },
  },
});
