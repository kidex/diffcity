// The real chain from the shell hook to the daemon socket (SPEC.md section 3,
// 3a C1, ADR-016): the hook printed by the built `diffcity shell-init`, loaded
// in a real shell, runs the built `diffcity track`, whose requests reach a fake
// daemon listening on the temporary home's socket. hook.test.ts proves the
// hook logic with a stub CLI; this file proves the wiring with the real one.
// It also runs `track --agent` with the real process stdin (pipe held open,
// invalid JSON, empty), which track.test.ts covers only through injected stdin.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quotePosix } from '../../../src/cli/shell-init.js';
import { homePaths } from '../../../src/core/home.js';
import type { SocketRequest } from '../../../src/core/model/types.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { CLI_DIST, DaemonTracker, waitFor } from '../../helpers/daemon.js';
import { startFakeDaemon, type FakeDaemon } from '../../helpers/fake-daemon.js';

let temp: TempHome;
let fake: FakeDaemon;
let work: string;
const daemons = new DaemonTracker();

/** A git repo (an empty `git init`) at `dir`. */
function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', dir]);
}

beforeEach(async () => {
  temp = await tempHome();
  // A stray track after the fake daemon closed would autostart a real one: the tracker stops it.
  daemons.track(temp.home);
  fake = await startFakeDaemon(homePaths(temp.home));
  work = join(await realpath(temp.root), `work it's "here"`);
  for (const name of ['north-yard', `south's "depot"`, 'east lab']) {
    await mkdir(join(work, name, 'src', 'deep'), { recursive: true });
    gitInit(join(work, name));
  }
  await mkdir(join(work, 'plain notes'), { recursive: true });
});
afterEach(async () => {
  await fake.close();
  await daemons.cleanup();
  await temp.cleanup();
});

const trackedDirs = (requests: SocketRequest[]): string[] =>
  requests.map((request) => (request.type === 'track' ? `${request.dir} agent=${String(request.agent)}` : request.type)).sort();

// ---------------------------------------------------------------------------

const shells = [
  { shell: 'zsh', bin: '/bin/zsh', args: ['-f', '-i'] },
  { shell: 'bash', bin: ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash'].find((bin) => existsSync(bin)), args: ['--norc', '--noprofile', '-i'] },
  { shell: 'fish', bin: ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'].find((bin) => existsSync(bin)), args: ['--no-config'] },
].filter((entry): entry is { shell: string; bin: string; args: string[] } => entry.bin !== undefined && existsSync(entry.bin));

describe.each(shells)('built shell-init hook in $shell', ({ shell, bin, args }) => {
  it('shell/real-cli-one-track-per-entry: the built track reaches the daemon once per repo entry, never for a plain folder', async () => {
    const script = execFileSync(process.execPath, [CLI_DIST, 'shell-init', shell], { env: temp.env, encoding: 'utf8' });
    const hookFile = join(temp.root, `hook.${shell}`);
    await writeFile(hookFile, script);
    const load = shell === 'fish' ? `source ${quotePosix(hookFile)}` : `eval "$(cat ${quotePosix(hookFile)})"`;
    const q = (...parts: string[]): string => quotePosix(join(work, ...parts));
    const lines = [
      ...(shell === 'fish' ? [] : [`PS1=''`]),
      load,
      `cd ${q('north-yard')}`,
      `cd ${q('north-yard', 'src', 'deep')}`,
      `cd ${q()}`,
      `cd ${q(`south's "depot"`)}`,
      `cd ${q('east lab', 'src')}`,
      `cd ${q('plain notes')}`,
      `cd ${q('north-yard', 'src')}`,
      `cd ${q()}`,
      'exit',
    ];
    const child = spawn(bin, args, { cwd: work, env: { ...temp.env, TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stdin.end(`${lines.join('\n')}\n`);
    expect(await new Promise((resolve) => child.once('exit', resolve))).toBe(0);

    await waitFor(() => fake.requests.length >= 4, 30_000, 'four track requests');
    // A little longer, so a stray extra request would show up.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(trackedDirs(fake.requests)).toEqual(
      [join(work, 'north-yard'), join(work, `south's "depot"`), join(work, 'east lab'), join(work, 'north-yard')].map((dir) => `${dir} agent=false`).sort(),
    );
    expect(output).not.toMatch(/\[\d+\]/);
    expect(output).not.toContain('tracked');
  });
});

// ---------------------------------------------------------------------------

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** The built `track --agent` in `cwd`; `stdin` is written and closed, or left open when null. */
async function trackAgent(cwd: string, stdin: string | null): Promise<Run> {
  const started = Date.now();
  const child = spawn(process.execPath, [CLI_DIST, 'track', '--agent'], { cwd, env: temp.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  if (stdin !== null) child.stdin.end(stdin);
  const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  clearTimeout(killer);
  child.stdin.destroy();
  return { code, stdout, stderr, ms: Date.now() - started };
}

describe('built track --agent with the process stdin', () => {
  it('cli/track-agent-stdin-open: a writer that never closes stdin is given up on after the timeout; the cwd is tracked', async () => {
    const cwd = join(work, 'east lab', 'src');
    const run = await trackAgent(cwd, null);
    expect(run).toMatchObject({ code: 0, stdout: 'tracked east lab\n', stderr: 'diffcity track: ignoring stdin: stdin was not closed within 2 s\n' });
    // STDIN_TIMEOUT_MS is 2 s; the process must exit soon after, not wait for the pipe.
    expect(run.ms).toBeLessThan(15_000);
    expect(trackedDirs(fake.requests)).toEqual([`${cwd} agent=true`]);
  });

  it('cli/track-agent-stdin-invalid: invalid JSON is reported and ignored; the cwd is tracked', async () => {
    const cwd = join(work, 'north-yard');
    expect(await trackAgent(cwd, '{"session_id": ')).toMatchObject({
      code: 0,
      stdout: 'tracked north-yard\n',
      stderr: 'diffcity track: ignoring stdin: hook input is not valid JSON\n',
    });
    expect(trackedDirs(fake.requests)).toEqual([`${cwd} agent=true`]);
  });

  it('cli/track-agent-stdin-empty: empty stdin is no hook input and no warning', async () => {
    const cwd = join(work, `south's "depot"`);
    expect(await trackAgent(cwd, '')).toMatchObject({ code: 0, stdout: `tracked south's "depot"\n`, stderr: '' });
    expect(trackedDirs(fake.requests)).toEqual([`${cwd} agent=true`]);
  });

  it('cli/track-agent-stdin-valid: the hook cwd replaces the working directory', async () => {
    const hookCwd = join(work, 'east lab', 'src', 'deep');
    const input = JSON.stringify({ session_id: 'session-0042', transcript_path: '/work/transcripts/session-0042.jsonl', cwd: hookCwd, hook_event_name: 'Stop' });
    expect(await trackAgent(join(work, 'plain notes'), input)).toMatchObject({ code: 0, stdout: 'tracked east lab\n', stderr: '' });
    expect(trackedDirs(fake.requests)).toEqual([`${hookCwd} agent=true`]);
  });
});
