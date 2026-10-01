// Guard (ADR-015, CLAUDE.md): under vitest, the diffcity home and the user's
// HOME both resolve inside os.tmpdir(), so no test can reach ~/.config/diffcity.

import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOME_ENV, homePaths, resolveHome } from '../../../src/core/home.js';
import { tempHome } from '../../helpers/config.js';

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

describe('test isolation', () => {
  it('home/tests-under-tmpdir: the resolved home is under os.tmpdir()', () => {
    expect(process.env[HOME_ENV]).toBeDefined();
    expect(isInside(tmpdir(), resolveHome())).toBe(true);
    const paths = homePaths(resolveHome());
    for (const path of [paths.db, paths.lock, paths.daemonJson, paths.socket, paths.log, paths.state]) {
      expect(isInside(tmpdir(), path)).toBe(true);
    }
  });

  it('HOME is under os.tmpdir() too, so the default path is safe as well', () => {
    expect(isInside(tmpdir(), homedir())).toBe(true);
    const withoutOverride = { ...process.env, [HOME_ENV]: undefined };
    expect(isInside(tmpdir(), resolveHome(withoutOverride))).toBe(true);
  });

  it('the setup file leaves the diffcity home for the code under test to create', async () => {
    await expect(mkdtemp(join(resolveHome(), 'x-'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('tempHome()', () => {
  it('gives a fresh home and HOME under os.tmpdir(), and an env for spawned processes', async () => {
    const first = await tempHome();
    const second = await tempHome();
    try {
      expect(first.home).not.toBe(second.home);
      expect(isInside(tmpdir(), first.home)).toBe(true);
      expect(isInside(tmpdir(), first.userHome)).toBe(true);
      expect(first.env[HOME_ENV]).toBe(first.home);
      expect(first.env.HOME).toBe(first.userHome);
      expect(resolveHome(first.env)).toBe(first.home);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it('cleanup removes everything it created', async () => {
    const temp = await tempHome();
    await temp.cleanup();
    await expect(mkdtemp(join(temp.userHome, 'x-'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(temp.root, { recursive: true, force: true });
  });
});
