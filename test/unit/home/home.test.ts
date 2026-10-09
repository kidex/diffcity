// DIFFCITY_HOME resolution and the files that live under it (ADR-015).

import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOME_ENV,
  MAX_SOCKET_PATH_BYTES,
  ensureHome,
  homePaths,
  resolveHome,
  socketPathFor,
} from '../../../src/core/home.js';

describe('resolveHome', () => {
  it('home/env-override: an absolute DIFFCITY_HOME wins', () => {
    expect(resolveHome({ [HOME_ENV]: '/srv/sample-shop/state' })).toBe('/srv/sample-shop/state');
  });

  it('normalizes the override, dropping a trailing slash and dot segments', () => {
    expect(resolveHome({ [HOME_ENV]: '/srv/sample-shop/./state/' })).toBe('/srv/sample-shop/state');
  });

  it('home/default-path: without the variable the home is ~/.config/diffcity', () => {
    expect(resolveHome({})).toBe(join(homedir(), '.config', 'diffcity'));
  });

  it.each(['state/diffcity', './diffcity', '~/diffcity', ''])(
    'home/relative-rejected: %j is an error that names the variable',
    (value) => {
      expect(() => resolveHome({ [HOME_ENV]: value })).toThrow(/DIFFCITY_HOME/);
      expect(() => resolveHome({ [HOME_ENV]: value })).toThrow(/absolute path/);
    },
  );

  it('reads process.env when no environment is passed', () => {
    expect(resolveHome()).toBe(resolveHome(process.env));
  });
});

describe('homePaths', () => {
  it('places every daemon file in the home directory', () => {
    const home = '/srv/order-service';
    expect(homePaths(home)).toEqual({
      home,
      db: '/srv/order-service/diffcity.db',
      lock: '/srv/order-service/daemon.lock',
      daemonJson: '/srv/order-service/daemon.json',
      socket: '/srv/order-service/daemon.sock',
      log: '/srv/order-service/daemon.log',
      state: '/srv/order-service/state.json',
      settings: '/srv/order-service/settings.json',
      runs: '/srv/order-service/runs',
    });
  });

  it('keeps the socket in the home at exactly the byte limit', () => {
    const suffix = '/daemon.sock';
    const home = `/${'a'.repeat(MAX_SOCKET_PATH_BYTES - suffix.length - 1)}`;
    expect(Buffer.byteLength(join(home, 'daemon.sock'))).toBe(MAX_SOCKET_PATH_BYTES);
    expect(socketPathFor(home)).toBe(join(home, 'daemon.sock'));
  });

  it('home/long-home-socket-path: over 100 bytes the socket moves to os.tmpdir()', () => {
    const home = `/${'b'.repeat(MAX_SOCKET_PATH_BYTES - 'daemon.sock'.length - 1)}`;
    expect(Buffer.byteLength(join(home, 'daemon.sock'))).toBe(MAX_SOCKET_PATH_BYTES + 1);
    const digest = createHash('sha256').update(home).digest('hex').slice(0, 12);
    expect(homePaths(home).socket).toBe(join(tmpdir(), `diffcity-${digest}.sock`));
  });

  it('counts bytes, not characters, against the limit', () => {
    // 30 three-byte characters (U+20AC): 43 characters but 103 bytes once joined.
    const home = `/${'€'.repeat(30)}`;
    expect(join(home, 'daemon.sock').length).toBeLessThan(MAX_SOCKET_PATH_BYTES);
    expect(Buffer.byteLength(join(home, 'daemon.sock'))).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
    expect(homePaths(home).socket.startsWith(tmpdir())).toBe(true);
  });

  it('gives two long homes two different sockets', () => {
    const long = 'c'.repeat(120);
    expect(socketPathFor(`/one/${long}`)).not.toBe(socketPathFor(`/two/${long}`));
  });
});

describe('ensureHome', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('creates the home and its parents with mode 0700', async () => {
    root = await mkdtemp(join(tmpdir(), 'dc-ensure-'));
    const home = join(root, 'nested', 'diffcity');
    await ensureHome(home);
    const info = await stat(home);
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o777).toBe(0o700);
    // A second call on an existing home is a no-op.
    await expect(ensureHome(home)).resolves.toBeUndefined();
  });
});
