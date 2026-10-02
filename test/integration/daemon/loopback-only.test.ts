// daemon/http-loopback-only (ADR-017): the real daemon's HTTP port is bound
// to 127.0.0.1 alone. It answers there, and the same port refuses connections
// on IPv6 loopback and on every non-loopback IPv4 address of this machine.

import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import type { DaemonInfo } from '../../../src/core/model/types.js';
import { readDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { DaemonTracker, waitFor } from '../../helpers/daemon.js';

let temp: TempHome;
let paths: HomePaths;
const daemons = new DaemonTracker();

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
});
afterEach(async () => {
  await daemons.cleanup();
  await temp.cleanup();
});

/** 'connected' or the error code of a TCP connect to host:port. */
function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 2000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('ETIMEDOUT');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? 'error');
    });
  });
}

function externalIpv4(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => address.address);
}

describe('daemon HTTP binding', () => {
  it('daemon/http-loopback-only: the port answers on 127.0.0.1 and is closed on ::1 and on external addresses', async () => {
    daemons.spawnDaemon(temp.env);
    const info = await waitFor<DaemonInfo>(() => readDaemonInfo(paths).then((value) => value ?? undefined), 45_000, 'daemon.json');

    expect(await tryConnect('127.0.0.1', info.port)).toBe('connected');
    expect(await tryConnect('::1', info.port)).not.toBe('connected');
    for (const address of externalIpv4()) {
      expect(await tryConnect(address, info.port), address).not.toBe('connected');
    }
  });
});
