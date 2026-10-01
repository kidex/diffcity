// `diffcity scan <dir>` (SPEC.md section 3, ADR-016): discoverRepos, then a
// `register` request with the roots, against a fake daemon that speaks socket
// protocol v1. The real daemon is covered by track-daemon.test.ts.

import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerBatches, runScan, type ScanDeps } from '../../../src/cli/scan.js';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import { readDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { fakeSpawner, startFakeDaemon, type FakeDaemon } from '../../helpers/fake-daemon.js';

let temp: TempHome;
let paths: HomePaths;
let projects: string;
const fakes: FakeDaemon[] = [];

/** A directory that looks like a repo to discoverRepos (only the `.git` entry matters). */
async function fakeRepo(...segments: string[]): Promise<string> {
  const dir = join(projects, ...segments);
  await mkdir(join(dir, '.git'), { recursive: true });
  return realpath(dir);
}

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
  projects = join(temp.root, 'projects');
  await mkdir(projects);
});
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  await temp.cleanup();
});

const noSpawn: NonNullable<ScanDeps['spawnDaemon']> = () => {
  throw new Error('scan must not start a daemon here');
};

async function scan(dir: string, deps: Partial<ScanDeps> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = { stdout: '', stderr: '' };
  const code = await runScan(dir, {
    io: { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    env: temp.env,
    cwd: temp.root,
    spawnDaemon: noSpawn,
    ...deps,
  });
  return { code, ...out };
}

async function running(): Promise<FakeDaemon> {
  const fake = await startFakeDaemon(paths);
  fakes.push(fake);
  return fake;
}

describe('diffcity scan', () => {
  it('cli/scan-registers: sends register with the discovered roots and prints the counts', async () => {
    const shop = await fakeRepo('sample-shop');
    const orders = await fakeRepo('team', 'order-service');
    await fakeRepo('node_modules', 'some-package');
    await fakeRepo('.hidden', 'docs-site');
    const fake = await running();

    expect(await scan(projects)).toEqual({ code: 0, stdout: 'registered 2 repos (0 already known)\n', stderr: '' });
    expect(fake.requests).toEqual([{ v: 1, type: 'register', dirs: [shop, orders].sort() }]);

    expect(await scan(projects)).toEqual({ code: 0, stdout: 'registered 0 repos (2 already known)\n', stderr: '' });
  });

  it('a relative <dir> is resolved against the working directory; one repo reads "1 repo"', async () => {
    const shop = await fakeRepo('sample-shop');
    const fake = await running();
    expect(await scan('projects')).toEqual({ code: 0, stdout: 'registered 1 repo (0 already known)\n', stderr: '' });
    expect(fake.requests).toEqual([{ v: 1, type: 'register', dirs: [shop] }]);
  });

  it('no repo under <dir>: says so, exits 0 and starts no daemon', async () => {
    await mkdir(join(projects, 'notes'));
    expect(await scan(projects)).toEqual({ code: 0, stdout: `no repos found under ${projects}\n`, stderr: '' });
    expect(await readDaemonInfo(paths)).toBeNull();
  });

  it('a missing <dir>: exit 1 with the reason', async () => {
    const missing = join(temp.root, 'missing');
    const result = await scan(missing);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`^diffcity scan: cannot scan ${missing}: .*ENOENT`));
  });

  it('a file as <dir>: exit 1, not a directory', async () => {
    const file = join(temp.root, 'notes.txt');
    await writeFile(file, 'sample\n');
    expect(await scan(file)).toEqual({ code: 1, stdout: '', stderr: `diffcity scan: not a directory: ${file}\n` });
  });

  it('starts the daemon when none runs', async () => {
    const shop = await fakeRepo('sample-shop');
    const spawner = fakeSpawner();
    const result = await scan(projects, { spawnDaemon: spawner.spawn });
    fakes.push(await spawner.started());
    expect(result).toEqual({ code: 0, stdout: 'registered 1 repo (0 already known)\n', stderr: '' });
    expect((await spawner.started()).requests).toEqual([{ v: 1, type: 'register', dirs: [shop] }]);
  });

  it('splits the roots over several requests so each stays under the request limit, and sums the counts', async () => {
    const repos = [];
    for (let index = 0; index < 12; index++) repos.push(await fakeRepo(`repo-${String(index).padStart(2, '0')}`));
    const fake = await running();
    const result = await scan(projects, { maxRequestBytes: 4 * (repos[0]?.length ?? 0) + 64 });
    expect(result).toEqual({ code: 0, stdout: 'registered 12 repos (0 already known)\n', stderr: '' });
    expect(fake.requests.length).toBeGreaterThan(1);
    expect(fake.requests.flatMap((request) => (request.type === 'register' ? request.dirs : []))).toEqual(repos);
  });

  it('an error response: its message on stderr, exit 1', async () => {
    await fakeRepo('sample-shop');
    fakes.push(await startFakeDaemon(paths, { register: () => ({ ok: false, error: 'sample failure' }) }));
    expect(await scan(projects)).toEqual({ code: 1, stdout: '', stderr: 'diffcity scan: sample failure\n' });
  });
});

describe('registerBatches', () => {
  it('keeps every request line within the limit and the order of the roots', () => {
    const dirs = Array.from({ length: 50 }, (_, index) => `/work/sample-${String(index)}/"quoted" dir`);
    const limit = 400;
    const batches = registerBatches(dirs, limit);
    expect(batches.flat()).toEqual(dirs);
    for (const batch of batches) {
      expect(Buffer.byteLength(JSON.stringify({ v: 1, type: 'register', dirs: batch }), 'utf8')).toBeLessThanOrEqual(limit);
    }
  });

  it('a single root longer than the limit still goes alone (the daemon refuses it with a message)', () => {
    expect(registerBatches(['/x'.repeat(100), '/y'], 50)).toEqual([['/x'.repeat(100)], ['/y']]);
  });
});
