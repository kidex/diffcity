// scripts/measure-collect.mjs prints repos by index only (DC-35): its output
// goes into the phase report as it is, so no repo name or path may appear in
// it, neither for a repo it measures nor for a directory track refuses.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findHomeProcesses, registerHome, sweepHomes } from '../../helpers/daemons.js';
import { waitFor } from '../../helpers/daemon.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';
import { ghStubEnv } from '../../e2e/support/acceptance.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/measure-collect.mjs', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Started {
  readonly child: ChildProcess;
  readonly done: Promise<Run>;
}

/** Every script a test started; the afterEach kills the ones still running. */
const started: ChildProcess[] = [];

function runScript(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return startScript(args, env).done;
}

function startScript(args: string[], env: NodeJS.ProcessEnv): Started {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  started.push(child);
  const done = new Promise<Run>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
  return { child, done };
}

/** A registered `dc-*` scratch directory the script's TMPDIR points at, so its `dc-measure-*` home lies below it. */
async function scratchDir(cleanups: (() => Promise<void>)[]): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'dc-'));
  cleanups.push(() => rm(scratch, { recursive: true, force: true }));
  registerHome(scratch);
  return scratch;
}

describe('measure-collect output', () => {
  const cleanups: (() => Promise<void>)[] = [];
  const scratches: string[] = [];
  afterEach(async () => {
    // A test that timed out or failed leaves its script running: stop it first.
    for (const child of started.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    // The check of DC-81: no daemon the script started may outlive the test.
    const homes = scratches.splice(0);
    const alive = (): number => findHomeProcesses(homes).length;
    const leaked = await waitFor(() => (alive() === 0 ? true : undefined), 3000, 'no daemon left').then(() => 0, alive);
    if (leaked > 0) await sweepHomes(homes);
    for (const cleanup of cleanups.splice(0)) await cleanup();
    expect(leaked, 'daemons left running by measure-collect').toBe(0);
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

    // The script's DIFFCITY_HOME goes below TMPDIR: a short, registered directory
    // (the socket path limit), so the daemon is stopped even if the script is not.
    const scratch = await scratchDir(cleanups);
    scratches.push(scratch);
    const env = await ghStubEnv(root, { ...process.env, HOME: user, TMPDIR: scratch }, []);
    // --import (DC-143): the findings go to the Draft checked out in the repo; the CLI's output names it and is never printed.
    const findings = join(root, 'findings.json');
    await writeFile(
      findings,
      JSON.stringify([{ source: 'claude', file: 'src/trees/plum.ts', line: 1, severity: 'low', category: 'style', title: 'Plums are counted by hand', message: 'The count is a literal.' }]),
    );
    const run = await runScript([orchard.dir, shed, '--timeout', '60', '--import', findings], env);
    const output = run.stdout + run.stderr;

    expect(run.stdout).toMatch(/^measure-collect: 2 repo\(s\), one at a time$/m);
    expect(run.stdout).toMatch(
      /^repo 1: track answered in \d+ ms; last snapshot at \d+ ms; collect done at \d+ ms; 2 changes, 2 snapshots, \d+ bytes total, largest \d+ bytes; import done in \d+ ms$/m,
    );
    expect(run.stdout).toMatch(/^repo 2: /m);
    // No name, no path: not the repo's, not the refused directory's, not the temp root's.
    for (const secret of ['sample-orchard', 'sample-garden-shed', 'plum', orchard.dir, shed, root, user, tmpdir()]) {
      expect(output).not.toContain(secret);
    }
    // The refused directory makes the run fail; the measured repo does not.
    expect(run.code).toBe(1);
  });

  it('stops its daemon when it is terminated while measuring', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-measure-test-')));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const user = join(root, 'user');
    await mkdir(user);
    const scratch = await scratchDir(cleanups);
    scratches.push(scratch);
    const env = await ghStubEnv(root, { ...process.env, HOME: user, TMPDIR: scratch }, []);
    // A directory that is not a repo: the script is already past starting the daemon when it answers.
    const run = startScript([join(root, 'user'), '--timeout', '60'], env);
    await waitFor(() => (findHomeProcesses([scratch]).length > 0 ? true : undefined), 45_000, 'the script daemon');
    run.child.kill('SIGTERM');
    await run.done;
    // No sweep here: the script itself must have stopped the daemon.
    await waitFor(() => (findHomeProcesses([scratch]).length === 0 ? true : undefined), 15_000, 'the daemon to stop');
  });
});
