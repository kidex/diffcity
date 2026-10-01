// Design exploration for the 3D city (three visual directions). A separate
// Vite build so it never touches the app's own config or dist/ui.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: './',
  // three ships its addons as plain ESM; nothing to pre-bundle beyond the defaults.
  build: {
    outDir: resolve(root, '../../dist/design-directions'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      input: {
        index: resolve(root, 'index.html'),
        a: resolve(root, 'a/index.html'),
        b: resolve(root, 'b/index.html'),
        c: resolve(root, 'c/index.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4400,
    strictPort: true,
    fs: {
      // The pages read the golden Report in test/fixtures and the app's
      // tokens and fonts in src/ui, both outside this root.
      allow: [resolve(root, '../..')],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4400,
  },
});
