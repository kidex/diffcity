// The Claude Code Stop hook command, `diffcity track --agent` (SPEC.md section
// 7.2, ADR-037), through the built CLI with the hook JSON on stdin. It never
// blocks the agent: every failure prints one line on stderr and exits 0. It
// never opens the browser: the UI updates live over SSE.

import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths } from '../../../src/core/home.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { CLI_DIST, DaemonTracker } from '../../helpers/daemon.js';
import { startFakeDaemon, type FakeDaemon } from '../../helpers/fake-daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const recorder = fileURLToPath(new URL('../../helpers/import-recorder.mjs', import.meta.url));

let temp: TempHome;
let repo: TempRepo;
const fakes: FakeDaemon[] = [];
const daemons = new DaemonTracker();

beforeEach(async () => {
  temp = await tempHome();
  // A failing case must not leave a real daemon behind: the tracker stops any.
  daemons.track(temp.home);
  repo = await createRepo({ name: 'sample-depot', files: { 'src/crates.ts': 'export const crates = 1;\n' } });
});
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  await daemons.cleanup();
  await repo.cleanup();
  await temp.cleanup();
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const stopInput = (cwd: string): string =>
  JSON.stringify({ session_id: 'session-0107', transcript_path: '/work/transcripts/session-0107.jsonl', cwd, hook_event_name: 'Stop', stop_hook_active: false });

/** Runs the built CLI with `args`, the hook JSON on stdin, in `cwd`. */
async function runCli(args: string[], input: string, options: { cwd: string; env?: NodeJS.ProcessEnv; nodeArgs?: string[] }): Promise<Run> {
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), CLI_DIST, ...args], {
    cwd: options.cwd,
    env: options.env ?? temp.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { code, stdout, stderr };
}

describe('hook/never-fails-the-agent: the Stop hook exits 0 with one line on stderr on every failure', () => {
  it('the hook cwd is not inside a repo', async () => {
    const outside = join(await realpath(temp.root), 'plain-notes');
    await mkdir(outside);
    const run = await runCli(['track', '--agent'], stopInput(outside), { cwd: outside });
    expect(run).toEqual({ code: 0, stdout: '', stderr: `diffcity track: not a git repository: ${outside}\n` });
  });

  it('the daemon cannot be started (its home is a file)', async () => {
    await writeFile(temp.home, 'not a directory\n');
    const run = await runCli(['track', '--agent'], stopInput(repo.dir), { cwd: repo.dir });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/^diffcity track: [^\n]+\n$/);
  });

  it('the daemon refuses the repo', async () => {
    fakes.push(await startFakeDaemon(homePaths(temp.home), { track: () => ({ ok: false, error: 'repo is not registered' }) }));
    const run = await runCli(['track', '--agent'], stopInput(repo.dir), { cwd: repo.dir });
    expect(run).toEqual({ code: 0, stdout: '', stderr: 'diffcity track: repo is not registered\n' });
  });

  it('without --agent the same failure still exits 1 (only the hook is forgiving)', async () => {
    fakes.push(await startFakeDaemon(homePaths(temp.home), { track: () => ({ ok: false, error: 'repo is not registered' }) }));
    const run = await runCli(['track'], '', { cwd: repo.dir });
    expect(run).toEqual({ code: 1, stdout: '', stderr: 'diffcity track: repo is not registered\n' });
  });

  it('a working hook tracks the change as agent work, exit 0', async () => {
    const fake = await startFakeDaemon(homePaths(temp.home));
    fakes.push(fake);
    const run = await runCli(['track', '--agent'], stopInput(repo.dir), { cwd: repo.dir });
    expect(run).toEqual({ code: 0, stdout: 'tracked sample-depot\n', stderr: '' });
    expect(fake.requests).toMatchObject([{ type: 'track', dir: repo.dir, agent: true }]);
  });
});

describe('hook/no-browser-opened', () => {
  /** A bin directory whose `open` and `xdg-open` write the URL they get to `marker`. */
  async function trapBrowser(): Promise<{ env: NodeJS.ProcessEnv; marker: string }> {
    const bin = join(temp.root, 'trap-bin');
    const marker = join(temp.root, 'browser-opened.txt');
    await mkdir(bin, { recursive: true });
    for (const name of ['open', 'xdg-open']) {
      await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${marker}'\n`);
      await chmod(join(bin, name), 0o755);
    }
    return { env: { ...temp.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, marker };
  }

  const opened = async (marker: string): Promise<string> => readFile(marker, 'utf8').catch(() => '');

  it('track --agent never runs the browser opener and never loads the opener module', async () => {
    const fake = await startFakeDaemon(homePaths(temp.home));
    fakes.push(fake);
    const { env, marker } = await trapBrowser();
    const log = join(temp.root, 'imports.log');
    const run = await runCli(['track', '--agent'], stopInput(repo.dir), {
      cwd: repo.dir,
      env: { ...env, DIFFCITY_TEST_IMPORT_LOG: log },
      nodeArgs: ['--import', recorder],
    });
    expect(run).toEqual({ code: 0, stdout: 'tracked sample-depot\n', stderr: '' });
    expect(fake.requests).toHaveLength(1);
    expect(await opened(marker)).toBe('');
    const urls = (await readFile(log, 'utf8')).split('\n');
    expect(urls.some((url) => url.endsWith('/dist/cli/track.js'))).toBe(true);
    expect(urls.filter((url) => url.endsWith('/dist/cli/open.js'))).toEqual([]);
  });

  it('control: the trap does catch an opener (import --open opens the change)', async () => {
    fakes.push(await startFakeDaemon(homePaths(temp.home)));
    const { env, marker } = await trapBrowser();
    await writeFile(join(repo.dir, 'findings.json'), '[]\n');
    const run = await runCli(['import', 'findings.json', '--open'], '', { cwd: repo.dir, env });
    expect(run.code).toBe(0);
    expect(await opened(marker)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  });
});
