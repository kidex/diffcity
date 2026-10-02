import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registeredHere, registerHome } from '../../helpers/daemons.js';

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('DC-58 registerHome guard', () => {
  it('registers a dc-* temporary home that does not exist yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dc-'));
    cleanups.push(root);
    const home = join(root, 'home');
    registerHome(home);
    expect(registeredHere().homes).toContain(home);
    expect(registeredHere().homes).toContain(join(await realpath(root), 'home'));
  });

  it('registers the dc-* root itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dc-'));
    cleanups.push(root);
    registerHome(root);
    expect(registeredHere().homes).toContain(root);
  });

  it('refuses a path outside os.tmpdir()', () => {
    expect(() => { registerHome('/usr/local/share/sample-app'); }).toThrow(/refusing/);
  });

  it('refuses the default per-user diffcity home', () => {
    const real = join(userInfo().homedir, '.config', ['diff', 'city'].join(''));
    expect(() => { registerHome(real); }).toThrow(/refusing/);
    expect(registeredHere().homes).not.toContain(real);
  });

  it('refuses os.tmpdir() itself, a root without the dc- prefix and a path escaping with ..', async () => {
    expect(() => { registerHome(tmpdir()); }).toThrow(/refusing/);
    const other = await mkdtemp(join(tmpdir(), 'other-'));
    cleanups.push(other);
    expect(() => { registerHome(join(other, 'home')); }).toThrow(/refusing/);
    expect(() => { registerHome(join(tmpdir(), 'dc-x', '..', '..', 'etc')); }).toThrow(/refusing/);
  });

  it('refuses a dc-* directory that is not under os.tmpdir()', () => {
    expect(() => { registerHome(join(userInfo().homedir, 'dc-fake', 'home')); }).toThrow(/refusing/);
  });
});
