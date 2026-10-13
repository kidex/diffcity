// The port check before a start (DC-117): a port held on 127.0.0.1, ::1,
// 0.0.0.0 or :: is in use, in the CLI's pre-start check and in the daemon's own
// check before it binds 127.0.0.1. macOS lets a second process bind
// 127.0.0.1 on a port held on a wildcard, so the bind alone does not tell; the
// check connects to loopback instead and never binds.

import { stat } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import { startDaemon } from '../../../src/daemon/daemon.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import { connectProbe, isPortFree, PROBE_HOSTS, type ProbeConnect } from '../../../src/daemon/port.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { canListenOnIpv6, listenOn, type Blocker, type BlockerHost } from '../../helpers/port.js';

const ipv6 = await canListenOnIpv6();

let temp: TempHome;
let paths: HomePaths;
const blockers: Blocker[] = [];

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
});
afterEach(async () => {
  for (const blocker of blockers.splice(0)) await blocker.close();
  await temp.cleanup();
});

async function hold(host: BlockerHost, ipv6Only = false): Promise<number> {
  const blocker = await listenOn(host, 0, ipv6Only);
  blockers.push(blocker);
  return blocker.port;
}

/** A port that was free on every probed address a moment ago; a few tries at most. */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const blocker = await listenOn('127.0.0.1');
    await blocker.close();
    if (await isPortFree(blocker.port)) return blocker.port;
  }
  throw new Error('no free port in 10 tries');
}

const quietLog = () => createStreamLogger(new PassThrough());

/** The TCP sockets the process holds; a probe must leave none behind. */
const openSockets = (): number => process.getActiveResourcesInfo().filter((name) => name === 'TCPSocketWrap').length;

const holders: { name: string; host: BlockerHost; ipv6Only?: boolean; skip?: boolean }[] = [
  { name: '127.0.0.1', host: '127.0.0.1' },
  { name: '0.0.0.0', host: '0.0.0.0' },
  { name: ':: (dual stack)', host: '::', skip: !ipv6 },
  { name: ':: (IPv6 only)', host: '::', ipv6Only: true, skip: !ipv6 },
  { name: '::1', host: '::1', skip: !ipv6 },
];

describe('isPortFree', () => {
  it('connects to 127.0.0.1, then ::1, and never binds', () => {
    expect(PROBE_HOSTS).toEqual(['127.0.0.1', '::1']);
  });

  it('a free port is free', async () => {
    expect(await isPortFree(await freePort())).toBe(true);
  });

  for (const holder of holders) {
    it.skipIf(holder.skip === true)(`a port held on ${holder.name} is in use`, async () => {
      const port = await hold(holder.host, holder.ipv6Only);
      expect(await isPortFree(port)).toBe(false);
    });
  }

  it('the probe leaves no socket behind, connected or refused', async () => {
    const held = await hold('127.0.0.1');
    const refused = await freePort();
    const before = openSockets();
    expect(await connectProbe(held, '127.0.0.1')).toBe('connected');
    expect(await connectProbe(refused, '127.0.0.1')).toBe('ECONNREFUSED');
    // A deadline of 0 ms: whichever path wins, the socket goes.
    for (let i = 0; i < 5; i++) await connectProbe(held, '127.0.0.1', 0);
    await expect.poll(openSockets, { timeout: 2000 }).toBe(before);
  });

  it('the probe clears its deadline timer, connected or refused', async () => {
    const held = await hold('127.0.0.1');
    const refused = await freePort();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(vi.getTimerCount()).toBe(0);
      expect(await connectProbe(held, '127.0.0.1')).toBe('connected');
      expect(vi.getTimerCount()).toBe(0);
      expect(await connectProbe(refused, '127.0.0.1')).toBe('ECONNREFUSED');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only a connection proves the port in use; the probes stop at the first one', async () => {
    const calls: string[] = [];
    const probe: ProbeConnect = (_port, host) => {
      calls.push(host);
      return Promise.resolve('connected');
    };
    expect(await isPortFree(4321, probe)).toBe(false);
    expect(calls).toEqual(['127.0.0.1']);

    for (const busy of PROBE_HOSTS) {
      const only: ProbeConnect = (_port, host) => Promise.resolve(host === busy ? 'connected' : 'ECONNREFUSED');
      expect(await isPortFree(4321, only)).toBe(false);
    }
  });

  it('refused, a host without IPv6, an unreachable network or a timeout is not proven in use', async () => {
    for (const result of ['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH', 'timeout']) {
      const probe: ProbeConnect = (_port, host) => Promise.resolve(host === '::1' ? result : 'ECONNREFUSED');
      expect(await isPortFree(4321, probe)).toBe(true);
      const both: ProbeConnect = () => Promise.resolve(result);
      expect(await isPortFree(4321, both)).toBe(true);
    }
  });
});

describe('startDaemon on a port held on another loopback or wildcard address', () => {
  for (const holder of holders.filter((entry) => entry.host !== '127.0.0.1')) {
    it.skipIf(holder.skip === true)(`a port held on ${holder.name} reports port-in-use and leaves nothing behind`, async () => {
      const port = await hold(holder.host, holder.ipv6Only);
      const result = await startDaemon({ env: temp.env, port, plugins: [], log: quietLog() });
      if (result.status === 'started') await result.daemon.shutdown('test cleanup');
      expect(result).toEqual({ status: 'port-in-use', port });
      for (const file of [paths.daemonJson, paths.lock, paths.socket]) await expect(stat(file)).rejects.toThrow(/ENOENT/);
    });
  }
});
