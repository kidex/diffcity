import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitRaw } from '../../src/core/git/exec.js';
import { isolateGitConfig } from '../helpers/git-env.js';

isolateGitConfig();

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe('gitRaw stdin', { timeout: 60_000 }, () => {
  it('reports the exit code when git exits before reading a large input (no EPIPE crash)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'diffcity-stdin-'));
    dirs.push(dir);
    // Not a repo: git fails at startup and never reads stdin, so the write hits a closed pipe.
    const input = 'x'.repeat(32 * 1024 * 1024);
    for (let round = 0; round < 3; round++) {
      const result = await gitRaw(dir, ['add', '--intent-to-add', '--pathspec-from-file=-'], { input });
      expect(result.exitCode).not.toBe(0);
    }
  });
});
