// Listeners held by "another process" for the port checks (DC-117): on
// 127.0.0.1, on the IPv4 wildcard and on the IPv6 wildcard. Every port is an
// ephemeral one picked by the system.

import { createServer, type Server } from 'node:net';

export type BlockerHost = '127.0.0.1' | '0.0.0.0' | '::';

export interface Blocker {
  port: number;
  close(): Promise<void>;
}

/** A listener on <host>, on a free ephemeral port or on <port>. Connections are dropped at once. */
export async function listenOn(host: BlockerHost, port = 0, ipv6Only = false): Promise<Blocker> {
  const server: Server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, ipv6Only }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => { resolve(); })),
  };
}

/** Whether this host can listen on the IPv6 wildcard; the :: cases are skipped otherwise. */
export async function canListenOnIpv6(): Promise<boolean> {
  try {
    const blocker = await listenOn('::', 0, true);
    await blocker.close();
    return true;
  } catch {
    return false;
  }
}
