// gh runs `git` inside the collected repo with whatever environment it was given.
// The runner used for gh (the hardened tool runner) must hand it the ADR-024 guards, so a hostile repo config
// cannot run code through gh (ADR-032).

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GH_REPO_VIEW_ARGV } from '../../../src/core/exec/index.js';
import { defaultRunner } from '../../../src/core/git/index.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

let scratch: string;
let markers: string;
let hook: string;
let hooksDir: string;
let repo: TempRepo | undefined;

/**
 * macOS vets the first exec of every freshly written file (syspolicyd), and
 * under load each check can take seconds. So the files git and gh exec are
 * written once per file, kept to a few tiny `#!/bin/sh` shims, and exec'd once
 * in beforeAll; the per-test work only reads them.
 */
async function script(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
}

const run = (file: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, [], { env: { ...process.env, PATH: `${join(scratch, 'bin')}:${process.env.PATH ?? ''}` }, cwd: scratch }, (error) => {
      if (error === null) resolve();
      else reject(new Error(`warming ${file} failed`, { cause: error }));
    });
  });

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'diffcity-gh-guards-'));
  markers = join(scratch, 'markers');
  await mkdir(markers);
  await mkdir(join(scratch, 'bin'));
  await mkdir(join(scratch, 'home'));
  // The hook records a marker; the repo config points fsmonitor, the pager and the hooks at it.
  hook = join(scratch, 'bin-hook');
  await script(hook, `: > "${join(markers, 'hook')}"`);
  hooksDir = join(scratch, 'hooks');
  await mkdir(hooksDir);
  for (const name of ['post-index-change', 'pre-auto-gc', 'post-checkout']) await script(join(hooksDir, name), `exec "${hook}"`);
  // The stand-in for gh, the one file the test execs directly through defaultRunner: it does what gh does
  // inside a repo, reading it through git. The body is a plain file run by /bin/sh, not a second fresh exec.
  // It answers JSON, as the runner accepts nothing else.
  await writeFile(join(scratch, 'gh-body.sh'), 'git status >/dev/null 2>&1\ngit config --get-regexp . >/dev/null 2>&1\necho "{}"\nexit 0\n', 'utf8');
  await script(join(scratch, 'bin', 'gh'), `exec /bin/sh "${join(scratch, 'gh-body.sh')}"`);
  // Warm every fresh executable once, then forget the marker the warming left.
  await run(hook);
  for (const name of ['post-index-change', 'pre-auto-gc', 'post-checkout']) await run(join(hooksDir, name));
  await run(join(scratch, 'bin', 'gh'));
  await rm(join(markers, 'hook'), { force: true });
  // Each first exec of a fresh script pays macOS's provenance check, which a loaded machine stretches.
}, 180_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(() => {
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
  await rm(join(markers, 'hook'), { force: true });
});

/** A repo whose own config names a fsmonitor command, a hooks directory and a pager, all recording a marker. */
async function hostileRepo(): Promise<TempRepo> {
  const created = await createRepo({ name: 'sample-shop', files: { 'src/app.ts': 'export const a = 1;\n' } });
  repo = created;
  await writeFile(
    join(created.dir, '.git', 'config'),
    `[core]\n\thooksPath = ${hooksDir}\n\tfsmonitor = ${hook}\n\tpager = ${hook}\n`,
    { encoding: 'utf8', flag: 'a' },
  );
  // A stat-dirty file so status has reason to refresh the index.
  await writeFile(join(created.dir, 'src', 'app.ts'), 'export const a = 2;\n', 'utf8');
  return created;
}

const markersSeen = async (): Promise<string[]> => (await readdir(markers)).sort();

describe('tool/git-guards-inherited', () => {
  it('fires no repo-configured command when the stub gh runs git through the gh runner', { timeout: 60_000 }, async () => {
    const hostile = await hostileRepo();
    await defaultRunner('gh', GH_REPO_VIEW_ARGV, { cwd: hostile.dir, timeoutMs: 30_000 });
    expect(await markersSeen()).toEqual([]);
  });

  it('control: the same stub without the guards does fire the marker', { timeout: 60_000 }, async () => {
    const hostile = await hostileRepo();
    await new Promise<void>((resolve, reject) => {
      execFile('gh', [], { cwd: hostile.dir, env: process.env, timeout: 50_000 }, (error) => {
        if (error === null) resolve();
        else reject(new Error('stub gh failed', { cause: error }));
      });
    });
    expect(await markersSeen()).toContain('hook');
  });
});
