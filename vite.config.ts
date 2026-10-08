// The browser UI (ADR-022): built into dist/ui, served by the daemon. `base`
// is relative so the same assets work under the daemon and, later, inlined in
// the single-file export (ADR-002).

import { defineConfig, type ProxyOptions } from 'vite';

const daemonUrl = process.env.DIFFCITY_DAEMON_URL ?? 'http://127.0.0.1:4321';

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The `/api` proxy's `configure` hook. A page served by the dev server sends
 * the dev server's origin in Origin and Referer, which the daemon's
 * same-origin checks treat as cross-site (opening a repo would never mark it
 * seen, writes would be refused). Requests from the dev server's own page are
 * rewritten to the daemon's origin; any other origin is passed on untouched,
 * so a third-party page proxied through the dev server is still cross-site.
 */
export function rewriteOriginToDaemon(target: string): NonNullable<ProxyOptions['configure']> {
  const daemonOrigin = originOf(target);
  return (proxy) => {
    proxy.on('proxyReq', (proxyReq, req) => {
      if (daemonOrigin === null || req.headers.host === undefined) return;
      const devOrigin = originOf(`http://${req.headers.host}`);
      if (devOrigin === null) return;
      const origin = req.headers.origin;
      if (origin !== undefined && origin.toLowerCase() === devOrigin) proxyReq.setHeader('origin', daemonOrigin);
      const referer = req.headers.referer;
      if (referer !== undefined && originOf(referer) === devOrigin) {
        const url = new URL(referer);
        proxyReq.setHeader('referer', `${daemonOrigin}${url.pathname}${url.search}${url.hash}`);
      }
    });
  };
}

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
      '/api': { target: daemonUrl, changeOrigin: true, configure: rewriteOriginToDaemon(daemonUrl) },
    },
  },
  preview: {
    host: '127.0.0.1',
  },
});
