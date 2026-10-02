// gh runs `git` inside the collected repo with whatever environment it was given.
// The runner used for gh must hand it the ADR-024 guards, so a hostile repo config
// cannot run code through gh (ADR-032).

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultRunner } from '../../../src/core/git/index.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

let scratch: string;
let markers: string;
let repo: TempRepo | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'diffcity-gh-guards-'));
  markers = join(scratch, 'markers');
  await mkdir(markers);
  await mkdir(join(scratch, 'bin'));
  await mkdir(join(scratch, 'home'));
  vi.stubEnv('HOME', join(scratch, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', join(scratch, 'home', '.config'));
  vi.stubEnv('GIT_CONFIG_GLOBAL', devNull);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('PATH', `${join(scratch, 'bin')}:${process.env.PATH ?? ''}`);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await repo?.cleanup();
  repo = undefined;
  await rm(scratch, { recursive: true, force: true });
});

async function script(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
}

/** A repo whose own config names a fsmonitor command, a hooks directory and a pager, all recording a marker. */
async function hostileRepo(): Promise<TempRepo> {
  const created = await createRepo({ name: 'sample-shop', files: { 'src/app.ts': 'export const a = 1;\n' } });
  repo = created;
  const hook = join(scratch, 'bin-hook');
  await script(hook, `: > "${join(markers, 'hook')}"`);
  const hooksDir = join(scratch, 'hooks');
  await mkdir(hooksDir);
  for (const name of ['post-index-change', 'pre-auto-gc', 'post-checkout']) await script(join(hooksDir, name), `exec "${hook}"`);
  await writeFile(
    join(created.dir, '.git', 'config'),
    `[core]\n\thooksPath = ${hooksDir}\n\tfsmonitor = ${hook}\n\tpager = ${hook}\n`,
    { encoding: 'utf8', flag: 'a' },
  );
  // A stat-dirty file so status has reason to refresh the index.
  await writeFile(join(created.dir, 'src', 'app.ts'), 'export const a = 2;\n', 'utf8');
  return created;
}

/** The stand-in for gh: does what gh does inside a repo, reading it through git. */
async function stubGh(): Promise<void> {
  await script(join(scratch, 'bin', 'gh'), 'git status >/dev/null 2>&1\ngit config --get-regexp . >/dev/null 2>&1\nexit 0');
}

const markersSeen = async (): Promise<string[]> => (await readdir(markers)).sort();

describe('tool/git-guards-inherited', () => {
  it('fires no repo-configured command when the stub gh runs git through the gh runner', { timeout: 60_000 }, async () => {
    const hostile = await hostileRepo();
    await stubGh();
    await defaultRunner('gh', ['repo', 'view'], { cwd: hostile.dir, timeoutMs: 30_000 });
    expect(await markersSeen()).toEqual([]);
  });

  it('control: the same stub without the guards does fire the marker', { timeout: 60_000 }, async () => {
    const hostile = await hostileRepo();
    await stubGh();
    await new Promise<void>((resolve, reject) => {
      execFile('gh', [], { cwd: hostile.dir, env: process.env, timeout: 30_000 }, (error) => {
        if (error === null) resolve();
        else reject(new Error('stub gh failed', { cause: error }));
      });
    });
    expect(await markersSeen()).toContain('hook');
  });
});
