// The port check before a start (DC-117): a port held on 127.0.0.1, on 0.0.0.0
// or on :: is in use, in the CLI's pre-start check and in the daemon's own
// check before it binds 127.0.0.1. macOS lets a second process bind
// 127.0.0.1 on a port held on a wildcard, so the bind alone does not tell.

import { stat } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import { startDaemon } from '../../../src/daemon/daemon.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import { isPortFree, PROBE_HOSTS, type ProbeBind } from '../../../src/daemon/port.js';
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

/** A port that was free on every probed address a moment ago. */
async function freePort(): Promise<number> {
  for (;;) {
    const blocker = await listenOn('127.0.0.1');
    await blocker.close();
    if (await isPortFree(blocker.port)) return blocker.port;
  }
}

const quietLog = () => createStreamLogger(new PassThrough());

const holders: { name: string; host: BlockerHost; ipv6Only?: boolean; skip?: boolean }[] = [
  { name: '127.0.0.1', host: '127.0.0.1' },
  { name: '0.0.0.0', host: '0.0.0.0' },
  { name: ':: (dual stack)', host: '::', skip: !ipv6 },
  { name: ':: (IPv6 only)', host: '::', ipv6Only: true, skip: !ipv6 },
];

describe('isPortFree', () => {
  it('probes 127.0.0.1, then the IPv4 and IPv6 wildcards', () => {
    expect(PROBE_HOSTS).toEqual(['127.0.0.1', '0.0.0.0', '::']);
  });

  it('a free port is free, and the probe leaves no socket behind', async () => {
    const port = await freePort();
    expect(await isPortFree(port)).toBe(true);
    // Every probe socket is closed: the port can be held on each address again.
    for (const host of ['127.0.0.1', '0.0.0.0'] as const) {
      const blocker = await listenOn(host, port);
      await blocker.close();
    }
    if (ipv6) await (await listenOn('::', port, true)).close();
  });

  for (const holder of holders) {
    it.skipIf(holder.skip === true)(`a port held on ${holder.name} is in use`, async () => {
      const port = await hold(holder.host, holder.ipv6Only);
      expect(await isPortFree(port)).toBe(false);
    });
  }

  it('a port held on 0.0.0.0 is in use even though 127.0.0.1 can be bound (the macOS case)', async () => {
    const port = await hold('0.0.0.0');
    const calls: string[] = [];
    const bind: ProbeBind = (probePort, host) => {
      calls.push(host);
      return Promise.resolve(host === '0.0.0.0' && probePort === port ? 'EADDRINUSE' : null);
    };
    expect(await isPortFree(port, bind)).toBe(false);
    expect(calls).toEqual(['127.0.0.1', '0.0.0.0']);
  });

  it('a host without IPv6 does not fail the check: EAFNOSUPPORT and EADDRNOTAVAIL on :: mean not in use', async () => {
    for (const code of ['EAFNOSUPPORT', 'EADDRNOTAVAIL']) {
      const bind: ProbeBind = (_port, host) => Promise.resolve(host === '::' ? code : null);
      expect(await isPortFree(4321, bind)).toBe(true);
    }
  });

  it('other bind errors are left to the daemon', async () => {
    const bind: ProbeBind = () => Promise.resolve('EACCES');
    expect(await isPortFree(80, bind)).toBe(true);
  });

  it('EADDRINUSE on any probed address means in use', async () => {
    for (const busy of PROBE_HOSTS) {
      const bind: ProbeBind = (_port, host) => Promise.resolve(host === busy ? 'EADDRINUSE' : null);
      expect(await isPortFree(4321, bind)).toBe(false);
    }
  });
});

describe('startDaemon on a port held on a wildcard', () => {
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
