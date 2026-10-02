// The browser UI (ADR-022): built into dist/ui, served by the daemon. `base`
// is relative so the same assets work under the daemon and, later, inlined in
// the single-file export (ADR-002).

import { defineConfig } from 'vite';

const daemonUrl = process.env.DIFFCITY_DAEMON_URL ?? 'http://127.0.0.1:4321';

export default defineConfig({
  root: 'src/ui',
  base: './',
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    sourcemap: true,
    // The change screen chunk carries three.js (about 600 kB); Fleet and Repo never load it.
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: daemonUrl, changeOrigin: true },
    },
  },
  preview: {
    host: '127.0.0.1',
  },
});
