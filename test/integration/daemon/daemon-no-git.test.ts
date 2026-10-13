// A daemon whose PATH has git on no absolute entry (DC-143): a repo it already
// tracks gets `git not found on PATH` as its collection error and in
// daemon.log, a new `track` is refused with the same message, and the repo's
// own bin/git, reachable only through the relative PATH entry `bin` from the
// daemon's working directory, never runs.

import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { homePaths } from '../../../src/core/home.js';
import type { DaemonInfo, RepoSummary } from '../../../src/core/model/types.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { readDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome } from '../../helpers/config.js';
import { DAEMON_MAIN_DIST, DaemonTracker, stopDaemonIn, waitFor } from '../../helpers/daemon.js';
import { createRepo } from '../../helpers/repo.js';

const daemons = new DaemonTracker();
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await daemons.cleanup();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startedDaemon(home: string, pid: number | undefined): Promise<DaemonInfo> {
  return waitFor(
    () => readDaemonInfo(homePaths(home)).then((info) => (info !== null && info.pid === pid ? info : undefined)),
    45_000,
    'daemon.json of the new daemon',
  );
}

async function repos(info: DaemonInfo): Promise<RepoSummary[]> {
  return (await (await fetch(`http://127.0.0.1:${String(info.port)}/api/repos`)).json()) as RepoSummary[];
}

describe.skipIf(process.platform === 'win32')('daemon without git on the PATH', () => {
  it('records `git not found on PATH` for a tracked repo, refuses a new track, and never runs the repo bin/git', async () => {
    const temp = await tempHome();
    cleanups.push(() => temp.cleanup());
    const repo = await createRepo({ name: 'sample-kiosk', files: { 'src/menu.ts': 'export const menu = 1;\n' } });
    cleanups.push(() => repo.cleanup());
    await repo.write({ 'src/menu.ts': 'export const menu = 2;\n' });
    const marker = join(temp.root, 'fake-git-ran');
    await mkdir(join(repo.dir, 'bin'));
    await writeFile(join(repo.dir, 'bin', 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
    await chmod(join(repo.dir, 'bin', 'git'), 0o755);
    const empty = await mkdtemp(join(tmpdir(), 'dc-no-git-'));
    cleanups.push(() => rm(empty, { recursive: true, force: true }));
    const base = { ...temp.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };

    // Tracked and collected with the normal PATH first.
    const normal = daemons.spawn(DAEMON_MAIN_DIST, ['--port', '0'], base, repo.dir);
    const first = await startedDaemon(temp.home, normal.child.pid);
    const tracked = await sendRequest(first.socket, { v: 1, type: 'track', dir: repo.dir, agent: false, at: new Date().toISOString() });
    expect(tracked.ok).toBe(true);
    await waitFor(async () => {
      const [only] = await repos(first);
      return only !== undefined && !only.collecting && only.counts.draft === 1 && only.error === null;
    }, 45_000, 'the first collection');
    await stopDaemonIn(temp.home);

    // Restarted from the repo directory with PATH=bin:<dir without git>.
    const bad = daemons.spawn(DAEMON_MAIN_DIST, ['--port', '0'], { ...base, PATH: ['bin', empty].join(delimiter) }, repo.dir);
    const second = await startedDaemon(temp.home, bad.child.pid);
    const refused = await sendRequest(second.socket, { v: 1, type: 'track', dir: repo.dir, agent: false, at: new Date().toISOString() });
    expect(refused).toEqual({ ok: false, error: 'git not found on PATH' });

    // A change in the working tree makes the watcher collect again.
    await repo.write({ 'src/menu.ts': 'export const menu = 3;\n' });
    const failed = await waitFor(async () => {
      const [only] = await repos(second);
      return only?.error === 'git not found on PATH' ? only : undefined;
    }, 45_000, 'the collection error');
    expect(failed.name).toBe('sample-kiosk');

    const log = await readFile(homePaths(temp.home).log, 'utf8');
    expect(log).toContain('collection of sample-kiosk (repo 1) failed: git not found on PATH');
    expect(log).not.toMatch(/not a git repository/);
    await expect(access(marker)).rejects.toThrow();
  });
});
