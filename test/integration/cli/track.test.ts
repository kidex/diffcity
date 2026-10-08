// `diffcity track [<dir>] [--agent]` (SPEC.md section 3, 3a C2/C3, ADR-016,
// ADR-001) against a fake daemon that speaks socket protocol v1. The real
// daemon's track handler is covered by track-daemon.test.ts.

import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTrack, type TrackDeps, type TrackStdin } from '../../../src/cli/track.js';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import type { SocketRequest } from '../../../src/core/model/types.js';
import { readDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { fakeSpawner, startFakeDaemon, type FakeDaemon } from '../../helpers/fake-daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

let temp: TempHome;
let paths: HomePaths;
let repo: TempRepo;
const fakes: FakeDaemon[] = [];

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
  repo = await createRepo({ name: 'sample-shop', files: { 'src/cart.ts': 'export const cart = 1;\n' } });
});
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  await repo.cleanup();
  await temp.cleanup();
});

const AT = new Date('2026-03-04T05:06:07.000Z');

interface Output {
  stdout: string;
  stderr: string;
}

/** A spawner that fails the test if track ever tries to start a daemon. */
const noSpawn: NonNullable<TrackDeps['spawnDaemon']> = () => {
  throw new Error('track must not start a daemon here');
};

async function track(
  dir: string | undefined,
  options: { agent?: boolean },
  deps: Partial<TrackDeps> = {},
): Promise<Output & { code: number }> {
  const out: Output = { stdout: '', stderr: '' };
  const code = await runTrack(dir, options, {
    io: { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    env: temp.env,
    cwd: repo.dir,
    now: () => AT,
    stdin: { isTTY: true, read: () => Promise.reject(new Error('stdin must not be read')) },
    spawnDaemon: noSpawn,
    ...deps,
  });
  return { code, ...out };
}

async function running(handlers?: Parameters<typeof startFakeDaemon>[1]): Promise<FakeDaemon> {
  const fake = await startFakeDaemon(paths, handlers);
  fakes.push(fake);
  return fake;
}

const trackRequest = (dir: string, agent = false, session?: Record<string, string>): SocketRequest => ({
  v: 1,
  type: 'track',
  dir,
  agent,
  at: AT.toISOString(),
  ...(session === undefined ? {} : { session: { sessionId: session.sessionId ?? '', transcriptPath: session.transcriptPath ?? '', cwd: session.cwd ?? '', event: session.event ?? '' } }),
});

describe('diffcity track', () => {
  it('cli/track-registers-repo: sends track for the directory and exits 0 on { ok, repo }', async () => {
    const fake = await running();
    const result = await track(repo.dir, {});
    expect(result).toEqual({ code: 0, stdout: 'tracked sample-shop\n', stderr: '' });
    expect(fake.requests).toEqual([trackRequest(repo.dir)]);
  });

  it('defaults <dir> to the working directory and makes a relative <dir> absolute', async () => {
    const fake = await running();
    await mkdir(join(repo.dir, 'src', 'deep'), { recursive: true });
    expect((await track(undefined, {}, { cwd: join(repo.dir, 'src') })).code).toBe(0);
    expect((await track('deep', {}, { cwd: join(repo.dir, 'src') })).code).toBe(0);
    expect(fake.requests).toEqual([trackRequest(join(repo.dir, 'src')), trackRequest(join(repo.dir, 'src', 'deep'))]);
  });

  it('cli/track-agent-flag: --agent reaches the request', async () => {
    const fake = await running();
    expect((await track(repo.dir, { agent: true })).code).toBe(0);
    expect(fake.requests).toEqual([trackRequest(repo.dir, true)]);
  });

  it('cli/track-not-a-repo: outside a repo prints the error, exits 1 and starts no daemon', async () => {
    const outside = join(temp.root, 'not-a-repo');
    await mkdir(outside);
    const result = await track(outside, {});
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`diffcity track: not a git repository: ${outside}\n`);
    expect(await readDaemonInfo(paths)).toBeNull();
  });

  it('a missing directory is reported the same way', async () => {
    const missing = join(temp.root, 'missing');
    const result = await track(missing, {});
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`diffcity track: not a git repository: ${missing}\n`);
  });

  it('cli/track-autostarts-daemon: with no daemon, starts one and the request goes through', async () => {
    const spawner = fakeSpawner();
    const result = await track(repo.dir, {}, { spawnDaemon: spawner.spawn });
    fakes.push(await spawner.started());
    expect(result).toEqual({ code: 0, stdout: 'tracked sample-shop\n', stderr: '' });
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.paths).toEqual(paths);
    // No --port: the daemon picks state.json or the default itself.
    expect(spawner.calls[0]?.port).toBeUndefined();
    expect((await spawner.started()).requests).toEqual([trackRequest(repo.dir)]);
  });

  it('a daemon that does not start in time: exit 1 with the wait and the log path', async () => {
    const result = await track(repo.dir, {}, {
      spawnDaemon: () => ({ pid: undefined, exited: new Promise(() => undefined) }),
      startTimeoutMs: 200,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`diffcity track: the daemon did not start within 0.2 s; see ${paths.log}\n`);
  });

  it('a daemon that exits while starting: exit 1 with its exit code', async () => {
    const result = await track(repo.dir, {}, { spawnDaemon: () => ({ pid: undefined, exited: Promise.resolve(1) }) });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`diffcity track: the daemon exited with code 1; see ${paths.log}\n`);
  });

  it('a daemon whose port is taken: exit 1 telling to pick a port with up', async () => {
    const result = await track(repo.dir, {}, { spawnDaemon: () => ({ pid: undefined, exited: Promise.resolve(3) }) });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('diffcity track: port 4321 is in use; pass --port to diffcity up\n');
  });

  it('an error response from the daemon: its message on stderr, exit 1', async () => {
    await running({ track: () => ({ ok: false, error: 'sample failure' }) });
    expect(await track(repo.dir, {})).toEqual({ code: 1, stdout: '', stderr: 'diffcity track: sample failure\n' });
  });
});

describe('diffcity track --agent with the Claude Code Stop hook on stdin', () => {
  const hookJson = (cwd: string): string =>
    JSON.stringify({
      session_id: 'session-0001',
      transcript_path: '/work/transcripts/session-0001.jsonl',
      cwd,
      hook_event_name: 'Stop',
    });
  const sessionOf = (cwd: string): Record<string, string> => ({
    sessionId: 'session-0001',
    transcriptPath: '/work/transcripts/session-0001.jsonl',
    cwd,
    event: 'Stop',
  });
  const pipe = (text: string): TrackStdin => ({ isTTY: false, read: () => Promise.resolve(text) });

  it('cwd from the hook replaces the default directory', async () => {
    const fake = await running();
    const sub = join(repo.dir, 'src');
    const result = await track(undefined, { agent: true }, { cwd: await realpath(temp.root), stdin: pipe(hookJson(sub)) });
    expect(result).toEqual({ code: 0, stdout: 'tracked sample-shop\n', stderr: '' });
    expect(fake.requests).toEqual([trackRequest(sub, true, sessionOf(sub))]);
  });

  it('track/forwards-session-field: the four hook fields go to the daemon as they came, nothing else', async () => {
    const fake = await running();
    const sub = join(repo.dir, 'src');
    const hook = { session_id: 'deadbeef-0001', transcript_path: '/claude/projects/p/deadbeef-0001.jsonl', cwd: sub, hook_event_name: 'SubagentStop', stop_hook_active: true, extra: { path: '/elsewhere' } };
    expect((await track(undefined, { agent: true }, { stdin: pipe(JSON.stringify(hook)) })).code).toBe(0);
    expect(fake.requests).toEqual([
      trackRequest(sub, true, { sessionId: 'deadbeef-0001', transcriptPath: '/claude/projects/p/deadbeef-0001.jsonl', cwd: sub, event: 'SubagentStop' }),
    ]);
  });

  it('an explicit <dir> wins over the hook cwd', async () => {
    const fake = await running();
    expect((await track(repo.dir, { agent: true }, { cwd: temp.root, stdin: pipe(hookJson('/elsewhere')) })).code).toBe(0);
    expect(fake.requests).toEqual([trackRequest(repo.dir, true, sessionOf('/elsewhere'))]);
  });

  it('empty stdin (as from /dev/null) is no hook input and no warning', async () => {
    const fake = await running();
    expect(await track(undefined, { agent: true }, { stdin: pipe('') })).toEqual({ code: 0, stdout: 'tracked sample-shop\n', stderr: '' });
    expect(fake.requests).toEqual([trackRequest(repo.dir, true)]);
  });

  it('track/invalid-hook-json-agent-mark-still-happens: invalid hook input is reported and ignored; the agent track still goes out, without a session', async () => {
    const fake = await running();
    const result = await track(undefined, { agent: true }, { stdin: pipe('{"session_id": 1}') });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('diffcity track: ignoring stdin: hook input: session_id must be a non-empty string\n');
    expect(fake.requests).toEqual([trackRequest(repo.dir, true)]);
  });

  it('a hook cwd outside a repo: the not-a-repo error on one line, exit 0 so the agent is never blocked (ADR-037)', async () => {
    const result = await track(undefined, { agent: true }, { stdin: pipe(hookJson(temp.root)) });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(`diffcity track: not a git repository: ${temp.root}\n`);
  });

  it('stdin is not read when it is a TTY (the default stdin rejects if read)', async () => {
    await running();
    expect((await track(undefined, { agent: true })).code).toBe(0);
  });

  it('stdin is not read without --agent', async () => {
    await running();
    const result = await track(undefined, {}, { stdin: { isTTY: false, read: () => Promise.reject(new Error('read')) } });
    expect(result.code).toBe(0);
  });
});
