// The temp-repo helper must not depend on, or be affected by, the machine's git setup.
// A hostile global config and inherited GIT_* variables are planted, then the helper is used.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTHOR_EMAIL, AUTHOR_NAME, createRepo, type TempRepo } from '../helpers/repo.js';

const PLANTED_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG_GLOBAL',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_EMAIL',
] as const;

let saved: Record<string, string | undefined> = {};
let hostile = '';
let marker = '';
const repos: TempRepo[] = [];

beforeEach(async () => {
  saved = Object.fromEntries(PLANTED_KEYS.map((key) => [key, process.env[key]]));
  hostile = await mkdtemp(join(tmpdir(), 'diffcity-hostile-'));
  marker = join(hostile, 'hook-ran');

  const hooks = join(hostile, 'hooks');
  await mkdir(hooks);
  const hook = join(hooks, 'post-commit');
  await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`, 'utf8');
  await chmod(hook, 0o755);

  const config = [
    '[user]',
    '\tname = Leaked Person',
    '\temail = leaked@wrong.invalid',
    '[commit]',
    '\tgpgsign = true',
    '[gpg]',
    '\tprogram = false',
    '[init]',
    '\tdefaultBranch = trunk',
    '[core]',
    `\thooksPath = ${hooks}`,
    '\tautocrlf = true',
    '',
  ].join('\n');
  const globalFile = join(hostile, 'gitconfig');
  await writeFile(globalFile, config, 'utf8');
  await writeFile(join(hostile, '.gitconfig'), config, 'utf8');
  await mkdir(join(hostile, 'xdg', 'git'), { recursive: true });
  await writeFile(join(hostile, 'xdg', 'git', 'config'), config, 'utf8');

  // A decoy repository that inherited GIT_DIR would point at.
  const decoy = join(hostile, 'decoy');
  await mkdir(decoy);

  process.env.HOME = hostile;
  process.env.XDG_CONFIG_HOME = join(hostile, 'xdg');
  process.env.GIT_CONFIG_GLOBAL = globalFile;
  process.env.GIT_DIR = join(decoy, '.git');
  process.env.GIT_WORK_TREE = decoy;
  process.env.GIT_AUTHOR_NAME = 'Leaked Person';
  process.env.GIT_AUTHOR_EMAIL = 'leaked@wrong.invalid';
  process.env.GIT_COMMITTER_EMAIL = 'leaked@wrong.invalid';
});

afterEach(async () => {
  for (const key of PLANTED_KEYS) {
    const value = saved[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  while (repos.length > 0) await repos.pop()?.cleanup();
  await rm(hostile, { recursive: true, force: true });
});

describe('test/helpers/repo.ts isolation from the machine git setup', { timeout: 30_000 }, () => {
  it('ignores a hostile global config and inherited GIT_* variables', async () => {
    const repo = await createRepo({ files: { 'ledger/entry.txt': 'line one\r\nline two\n' } });
    repos.push(repo);
    await repo.branch('feature/rounding');
    await repo.commit('second', { 'ledger/entry.txt': 'line three\n' });

    // Identity is the invented one, on both commits.
    const identities = (await repo.git('log', '--format=%an <%ae>|%cn <%ce>')).split('\n');
    const expected = `${AUTHOR_NAME} <${AUTHOR_EMAIL}>|${AUTHOR_NAME} <${AUTHOR_EMAIL}>`;
    expect(identities).toEqual([expected, expected]);

    // init.defaultBranch from the global config is not used.
    expect(await repo.git('rev-parse', '--abbrev-ref', 'main')).toBe('main');

    // Global hooks did not run, commits are unsigned (gpg.program=false would have failed).
    expect(existsSync(marker)).toBe(false);
    expect(await repo.git('log', '-1', '--format=%G?')).toBe('N');

    // core.autocrlf=true from the global config did not rewrite content.
    expect(await repo.git('show', 'main:ledger/entry.txt')).toBe('line one\r\nline two');

    // The decoy that GIT_DIR pointed at was never initialised.
    expect(existsSync(join(hostile, 'decoy', '.git'))).toBe(false);
  });

  it('leaves the hostile global config file untouched', async () => {
    const before = await readFile(join(hostile, 'gitconfig'), 'utf8');
    const repo = await createRepo({ files: { 'a.txt': 'a\n' } });
    repos.push(repo);
    expect(await readFile(join(hostile, 'gitconfig'), 'utf8')).toBe(before);
  });
});
