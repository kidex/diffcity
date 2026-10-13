// With no git on an absolute PATH entry (DC-143), `diffcity diff` says so,
// rather than calling the directory "not a git repository"; a repo's own
// bin/git, reachable only through a relative entry, never runs.

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_DIST } from '../../helpers/daemon.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI_DIST, ...args], { cwd, env, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') {
        reject(new Error(`could not run the CLI: ${error.message}`, { cause: error }));
        return;
      }
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

describe.skipIf(process.platform === 'win32')('diffcity diff without git on the PATH', () => {
  it('exits 1 with `git not found on PATH`', async () => {
    const repo: TempRepo = await createRepo({ name: 'sample-kiosk', files: { 'src/menu.ts': 'export const menu = 1;\n' } });
    cleanups.push(() => repo.cleanup());
    await repo.write({ 'src/menu.ts': 'export const menu = 2;\n' });
    // The repo's own git, behind the relative entry: it would leave a marker if it ran.
    const marker = join(repo.dir, 'ran');
    await mkdir(join(repo.dir, 'bin'));
    await writeFile(join(repo.dir, 'bin', 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
    await chmod(join(repo.dir, 'bin', 'git'), 0o755);
    const empty = await mkdtemp(join(tmpdir(), 'dc-no-git-'));
    cleanups.push(() => rm(empty, { recursive: true, force: true }));

    const env = { ...process.env, PATH: ['bin', empty].join(delimiter), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
    const run = await runCli(repo.dir, ['diff'], env);

    expect(run.code).toBe(1);
    expect(run.stderr.trim()).toBe('diffcity diff: git not found on PATH');
    expect(run.stdout).toBe('');
    await expect(import('node:fs/promises').then((fs) => fs.access(marker))).rejects.toThrow();
  });
});
