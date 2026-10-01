// The built CLI's track, scan and shell-init against a real daemon started from
// dist/ in a temporary DIFFCITY_HOME (ADR-015, ADR-016). Every daemon is
// stopped in afterEach. The fake-daemon tests (track.test.ts, scan.test.ts)
// cover the protocol details; this file proves the wiring end to end.

import { spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quoteFish } from '../../../src/cli/shell-init.js';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import { findRunningDaemon } from '../../../src/daemon/client.js';
import { readDaemonInfo, writeState } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { CLI_DIST, DaemonTracker } from '../../helpers/daemon.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

// The daemon's track and register handlers arrive with DC-29. Until then the
// daemon answers "<type> is not supported by this daemon yet", which the CLI
// must report cleanly. Set this to true once DC-29 is merged.
const DAEMON_HANDLES_TRACK_AND_REGISTER = false as boolean;

let temp: TempHome;
let paths: HomePaths;
let repo: TempRepo;
const daemons = new DaemonTracker();

/** A port that was free a moment ago, so an autostarted daemon never takes 4321. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
  daemons.track(temp.home);
  await mkdir(temp.home, { recursive: true, mode: 0o700 });
  await writeState(paths, { port: await freePort() });
  repo = await createRepo({ name: 'sample-shop', files: { 'src/cart.ts': 'export const cart = 1;\n' } });
});
afterEach(async () => {
  await daemons.cleanup();
  await repo.cleanup();
  await temp.cleanup();
});

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], cwd = temp.userHome): Promise<CliRun> {
  const run = daemons.cli(args, temp.env, cwd);
  const code = await run.exited;
  return { code, stdout: run.stdout(), stderr: run.stderr() };
}

/** Runs the built CLI with `stdin` piped in, as the Claude Code Stop hook does. */
async function cliWithStdin(args: string[], stdin: string): Promise<CliRun> {
  const child = spawn(process.execPath, [CLI_DIST, ...args], { env: temp.env, cwd: temp.userHome, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { code, stdout, stderr };
}

function expectHandled(run: CliRun, command: 'track' | 'scan', success: string): void {
  const type = command === 'track' ? 'track' : 'register';
  if (DAEMON_HANDLES_TRACK_AND_REGISTER) {
    expect(run).toEqual({ code: 0, stdout: success, stderr: '' });
  } else {
    expect(run).toEqual({ code: 1, stdout: '', stderr: `diffcity ${command}: ${type} is not supported by this daemon yet\n` });
  }
}

describe('track, scan and shell-init with the built CLI and a real daemon', () => {
  it('cli/track-autostarts-daemon: track starts the daemon, which answers the request', async () => {
    expect(await readDaemonInfo(paths)).toBeNull();
    expectHandled(await cli(['track', repo.dir]), 'track', 'tracked sample-shop\n');
    expect(await findRunningDaemon(paths)).not.toBeNull();
  });

  it('track --agent with the Stop hook JSON on stdin uses its cwd', async () => {
    const hook = (cwd: string): string =>
      JSON.stringify({ session_id: 'session-0001', transcript_path: '/work/transcripts/session-0001.jsonl', cwd, hook_event_name: 'Stop' });

    const outside = await cliWithStdin(['track', '--agent'], hook(temp.root));
    expect(outside).toEqual({ code: 1, stdout: '', stderr: `diffcity track: not a git repository: ${temp.root}\n` });

    expectHandled(await cliWithStdin(['track', '--agent'], hook(join(repo.dir, 'src'))), 'track', 'tracked sample-shop\n');
  });

  it('cli/track-not-a-repo: exit 1 with the message and no daemon started', async () => {
    const run = await cli(['track']);
    // The default <dir> is process.cwd(), which resolves symbolic links (os.tmpdir() is one on macOS).
    expect(run).toEqual({ code: 1, stdout: '', stderr: `diffcity track: not a git repository: ${await realpath(temp.userHome)}\n` });
    expect(await readDaemonInfo(paths)).toBeNull();
  });

  it('scan registers the repos it finds through the daemon', async () => {
    expectHandled(await cli(['scan', repo.dir]), 'scan', 'registered 1 repo (0 already known)\n');
  });

  it('shell-init prints the hook with this node and the built CLI', async () => {
    const run = await cli(['shell-init', 'fish']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`${quoteFish(process.execPath)} ${quoteFish(CLI_DIST)} track $root`);
  });

  it('cli/shell-init-unknown-shell: exit 1', async () => {
    expect(await cli(['shell-init', 'tcsh'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'diffcity shell-init: unsupported shell: tcsh (supported: zsh, bash, fish)\n',
    });
  });
});
