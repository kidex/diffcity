// Whether the daemon's HTTP port is in use (DC-117), checked by the CLI before
// it starts a daemon (`up`, `start`, `import`) and by the daemon before it
// binds 127.0.0.1. macOS lets a process bind 127.0.0.1 on a port another
// process holds on 0.0.0.0 or ::, so a 127.0.0.1 bind alone does not tell:
// the wildcards are probed too. The daemon itself only ever binds 127.0.0.1.
// The module stays light: node:net only.

import { createServer } from 'node:net';

/** The addresses probed, in order: the daemon's own, then the IPv4 and IPv6 wildcards. */
export const PROBE_HOSTS = ['127.0.0.1', '0.0.0.0', '::'] as const;
export type ProbeHost = (typeof PROBE_HOSTS)[number];

/** Binds <host>:<port> and releases it; resolves the bind error code, or null when the bind succeeded. */
export type ProbeBind = (port: number, host: ProbeHost) => Promise<string | null>;

/**
 * Listens on <host>:<port> and closes at once. A wildcard probe listens for
 * that instant only and drops any connection it receives. :: is bound
 * IPv6-only, so it tests the IPv6 wildcard alone.
 */
export const bindAndRelease: ProbeBind = (port, host) =>
  new Promise((resolve) => {
    const probe = createServer((socket) => socket.destroy());
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.close(() => {
        resolve(error.code ?? 'EUNKNOWN');
      });
    });
    probe.listen({ port, host, ipv6Only: host === '::' }, () => {
      probe.close(() => {
        resolve(null);
      });
    });
  });

/**
 * True unless something already listens on <port> at 127.0.0.1, 0.0.0.0 or ::.
 * Only EADDRINUSE means in use: a host without IPv6 (EAFNOSUPPORT,
 * EADDRNOTAVAIL on ::) passes, and other bind errors are left to the daemon's
 * own bind. The probes run one after the other, each closed before the next.
 */
export async function isPortFree(port: number, bind: ProbeBind = bindAndRelease): Promise<boolean> {
  for (const host of PROBE_HOSTS) {
    if ((await bind(port, host)) === 'EADDRINUSE') return false;
  }
  return true;
}
