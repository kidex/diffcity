// scripts/gen-synthetic-change.mjs (DC-143): an invented repo whose checked
// out branch changes every one of its N files against `main`, in one commit,
// with a clean working tree; it never writes into a directory that exists.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/gen-synthetic-change.mjs', import.meta.url));
const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };

let root = '';

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
  root = '';
});

const git = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();

describe('gen-synthetic-change', () => {
  it('builds a branch that changes every file of main in one commit, checked out and clean', async () => {
    root = await mkdtemp(join(tmpdir(), 'dc-gen-'));
    const repo = join(root, 'acme-cli');
    const run = spawnSync(process.execPath, [SCRIPT, repo, '--files', '6'], { env, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);

    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/sweep');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-list', '--count', 'main..feature/sweep')).toBe('1');
    const changed = git(repo, 'diff', '--name-only', 'main', 'feature/sweep').split('\n');
    expect(changed).toEqual(['src/app/m0.ts', 'src/app/m1.ts', 'src/app/m2.ts', 'src/core/m3.ts', 'src/core/m4.ts', 'src/core/m5.ts']);
    // Each file calls into the next ones, across the two directories.
    expect(git(repo, 'show', 'feature/sweep:src/app/m2.ts')).toContain("from '../core/m3'");
  });

  it('refuses a directory that exists', async () => {
    root = await mkdtemp(join(tmpdir(), 'dc-gen-'));
    const run = spawnSync(process.execPath, [SCRIPT, root], { env, encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('already exists');
  });
});
