// scripts/measure-collect.mjs prints repos by index only (DC-35): its output
// goes into the phase report as it is, so no repo name or path may appear in
// it, neither for a repo it measures nor for a directory track refuses.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepo, type TempRepo } from '../../helpers/repo.js';
import { ghStubEnv } from '../../e2e/support/acceptance.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/measure-collect.mjs', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('measure-collect output', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('names a measured repo and a refused directory by index only', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-measure-test-')));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const user = join(root, 'user');
    await mkdir(user);
    // A directory that is not a git repo: track refuses it.
    const shed = join(root, 'sample-garden-shed');
    await mkdir(shed);

    const orchard: TempRepo = await createRepo({
      name: 'sample-orchard',
      files: { 'src/trees/apple.ts': 'export const apples = 3;\n' },
    });
    cleanups.push(() => orchard.cleanup());
    await orchard.branch('feature/pears');
    await orchard.commit('plant the pears', { 'src/trees/pear.ts': 'export const pears = 2;\n' });
    await orchard.checkout('main');
    await orchard.write({ 'src/trees/plum.ts': 'export const plums = 1;\n' });

    const env = await ghStubEnv(root, { ...process.env, HOME: user }, []);
    const run = await runScript([orchard.dir, shed, '--timeout', '60'], env);
    const output = run.stdout + run.stderr;

    expect(run.stdout).toMatch(/^measure-collect: 2 repo\(s\), one at a time$/m);
    expect(run.stdout).toMatch(
      /^repo 1: track answered in \d+ ms; last snapshot at \d+ ms; collect done at \d+ ms; 2 changes, 2 snapshots, \d+ bytes total, largest \d+ bytes$/m,
    );
    expect(run.stdout).toMatch(/^repo 2: /m);
    // No name, no path: not the repo's, not the refused directory's, not the temp root's.
    for (const secret of ['sample-orchard', 'sample-garden-shed', orchard.dir, shed, root, user, tmpdir()]) {
      expect(output).not.toContain(secret);
    }
    // The refused directory makes the run fail; the measured repo does not.
    expect(run.code).toBe(1);
  });
});
