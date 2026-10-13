// Whether the daemon's HTTP port is in use (DC-117), checked by the CLI before
// it starts a daemon (`up`, `start`, `import`) and by the daemon before it
// binds 127.0.0.1. macOS lets a process bind 127.0.0.1 on a port another
// process holds on 0.0.0.0 or ::, so a 127.0.0.1 bind alone does not tell.
// The check connects to the loopback addresses instead: a listener on
// 127.0.0.1, 0.0.0.0, :: (dual stack or IPv6 only) or ::1 accepts the
// connection. It never binds anything, so it touches loopback only and does not
// trigger the macOS firewall prompt. The module stays light: node:net only.

import { connect } from 'node:net';

/** The addresses probed, in order. */
export const PROBE_HOSTS = ['127.0.0.1', '::1'] as const;
export type ProbeHost = (typeof PROBE_HOSTS)[number];

/** How long a probe connection may take before it counts as not proven in use. */
export const PROBE_TIMEOUT_MS = 250;

/**
 * The outcome of one probe connection: `connected` (something listens),
 * `timeout`, or the connect error code (ECONNREFUSED, EADDRNOTAVAIL, ...).
 */
export type ProbeResult = string;

/** Connects to <host>:<port> and closes at once; resolves the outcome. */
export type ProbeConnect = (port: number, host: ProbeHost) => Promise<ProbeResult>;

/**
 * Connects to <host>:<port> with a PROBE_TIMEOUT_MS deadline. The socket is
 * destroyed and the timer cleared on every path, so nothing keeps the
 * process alive.
 */
export function connectProbe(port: number, host: ProbeHost, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const finish = (result: ProbeResult): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      // An error after destroy() must not become an uncaught 'error' event.
      socket.on('error', () => undefined);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish('timeout');
    }, timeoutMs);
    socket.once('connect', () => {
      finish('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code ?? 'EUNKNOWN');
    });
  });
}

/**
 * True unless something accepts a connection on <port> at 127.0.0.1 or ::1.
 * Only a connection proves the port in use: ECONNREFUSED is free on that
 * address, and anything else (EADDRNOTAVAIL, EAFNOSUPPORT, ENETUNREACH on a
 * host without IPv6, a timeout) is not proven in use; the daemon's own
 * 127.0.0.1 bind decides then.
 */
export async function isPortFree(port: number, probe: ProbeConnect = connectProbe): Promise<boolean> {
  for (const host of PROBE_HOSTS) {
    if ((await probe(port, host)) === 'connected') return false;
  }
  return true;
}
