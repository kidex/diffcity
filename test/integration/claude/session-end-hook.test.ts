// The SessionEnd hook setup-claude writes (DC-128), run as Claude Code runs it:
// the command from the written settings.json through a shell, with the hook
// JSON on stdin, against a real daemon the built CLI starts in a temporary
// DIFFCITY_HOME. The Claude Code configuration (settings and transcripts) is a
// temporary CLAUDE_CONFIG_DIR; no Claude Code session is ever started, the
// hook inputs are invented in the shape Claude Code 2.1.296 sends.

import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetupClaude } from '../../../src/cli/setup-claude.js';
import { CLAUDE_CONFIG_DIR_ENV } from '../../../src/core/claude/config-dir.js';
import { homePaths } from '../../../src/core/home.js';
import type { ChangeSummary, RepoSummary, SessionView, SessionsResponse } from '../../../src/core/model/types.js';
import { subagentsDir } from '../../../src/core/session/index.js';
import { readDaemonInfo, writeState } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { CLI_DIST, DaemonTracker, waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';
import { transcript } from '../../helpers/transcript.js';

isolateGitConfig();

const SESSION = '0a1b2c3d-0000-4000-8000-000000000128';

let temp: TempHome;
let claude: string;
let env: NodeJS.ProcessEnv;
let repo: TempRepo;
const daemons = new DaemonTracker();

/** A port that was free a moment ago, so the autostarted daemon never takes 4321. */
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
  daemons.track(temp.home);
  Reflect.deleteProperty(temp.env, 'npm_command');
  claude = join(await realpath(temp.root), 'claude-config');
  env = { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude };
  await mkdir(temp.home, { recursive: true, mode: 0o700 });
  await writeState(homePaths(temp.home), { port: await freePort() });
  repo = await createRepo({ name: 'sample-depot', files: { 'src/crates.ts': 'export const crates = 1;\n' } });
  await repo.branch('feature/crates');
  await repo.commit('count the crates', { 'src/count.ts': 'export const count = (crates: number[]): number => crates.length;\n' });
});
afterEach(async () => {
  await daemons.cleanup();
  await repo.cleanup();
  await temp.cleanup();
});

/** The hook commands setup-claude wrote, by event. */
async function writtenHooks(): Promise<Record<string, string>> {
  const settings = JSON.parse(await readFile(join(claude, 'settings.json'), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  return Object.fromEntries(Object.entries(settings.hooks).map(([event, entries]) => [event, entries[0]?.hooks[0]?.command ?? '']));
}

/** Runs a hook command through a shell, as Claude Code does, with `input` on stdin. */
async function runHook(command: string, cwd: string, input: Record<string, unknown>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { code, stdout, stderr };
}

async function getJson<T>(port: number, path: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

/** The session as the change's Session tab gets it, once it is linked and read. */
async function sessionOf(port: number): Promise<SessionView | undefined> {
  const repos = await getJson<RepoSummary[]>(port, '/api/repos');
  for (const listed of repos) {
    const changes = await getJson<ChangeSummary[]>(port, `/api/repos/${String(listed.id)}/changes`);
    for (const change of changes) {
      const { sessions } = await getJson<SessionsResponse>(port, `/api/changes/${String(change.id)}/sessions`);
      const found = sessions.find((session) => session.sessionId === SESSION && session.digest !== null);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

describe('the SessionEnd hook through the built CLI', () => {
  it('cli/session-end-marks-ended: after Stop the session is active and its run running; after SessionEnd it is ended and the run unknown', async () => {
    const dir = await realpath(repo.dir);
    let out = '';
    const code = await runSetupClaude({}, {
      io: { stdout: (text) => (out += text), stderr: (text) => (out += text) },
      env: { ...env, PATH: join(temp.root, 'no-bin') },
      cwd: temp.userHome,
      nodePath: process.execPath,
      cliEntry: CLI_DIST,
    });
    expect(code, out).toBe(0);
    const hooks = await writtenHooks();
    const command = `"${process.execPath}" "${CLI_DIST}" track --agent`;
    expect(hooks).toEqual({ Stop: command, SessionEnd: command });

    // An invented transcript in the temporary configuration: one prompt and a background run with no outcome yet.
    const projects = join(claude, 'projects', '-work-sample-depot');
    await mkdir(projects, { recursive: true });
    const transcriptPath = join(projects, `${SESSION}.jsonl`);
    const main = transcript({ sessionId: SESSION, cwd: dir, branch: 'feature/crates' }).prompt('Count the crates');
    main.agent({ agentId: 'bgcount', type: 'dev' });
    await writeFile(transcriptPath, main.jsonl());
    const sidechains = subagentsDir(transcriptPath);
    await mkdir(sidechains, { recursive: true });
    await writeFile(join(sidechains, 'agent-bgcount.jsonl'), transcript({ sessionId: SESSION, agentId: 'bgcount', cwd: dir }).text('Counting').jsonl());
    const base = { session_id: SESSION, transcript_path: transcriptPath, cwd: dir, permission_mode: 'default' };

    const stop = await runHook(hooks.Stop ?? '', dir, { ...base, hook_event_name: 'Stop', stop_hook_active: false });
    expect(stop).toEqual({ code: 0, stdout: 'tracked sample-depot\n', stderr: '' });
    const info = await readDaemonInfo(homePaths(temp.home));
    if (info === null) throw new Error('the hook did not start the daemon');
    const running = await waitFor(() => sessionOf(info.port), 45_000, 'the session after Stop');
    expect(running.active).toBe(true);
    expect(running.digest?.runs.map((run) => [run.agentId, run.status])).toEqual([['bgcount', 'running']]);

    const end = await runHook(hooks.SessionEnd ?? '', dir, { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    expect(end).toEqual({ code: 0, stdout: 'session ended in sample-depot\n', stderr: '' });
    const ended = await waitFor(async () => {
      const current = await sessionOf(info.port);
      return current?.active === false ? current : undefined;
    }, 45_000, 'the session to read as ended');
    expect(ended.digest?.runs.map((run) => [run.agentId, run.status])).toEqual([['bgcount', 'unknown']]);
  });

  it('cli/session-end-never-fails: outside a repo, or with input it cannot use, the SessionEnd hook exits 0', async () => {
    const command = `"${process.execPath}" "${CLI_DIST}" track --agent`;
    const outside = join(temp.root, 'plain-notes');
    await mkdir(outside);
    const input = { session_id: SESSION, transcript_path: join(claude, 'projects', 'x', `${SESSION}.jsonl`), cwd: outside, hook_event_name: 'SessionEnd', reason: 'logout' };
    const run = await runHook(command, outside, input);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr.split('\n').filter((line) => line !== '')).toHaveLength(1);
    // Invalid input is ignored and the cwd tracked: still exit 0.
    const garbled = await runHook(command, outside, { hook_event_name: 'SessionEnd' });
    expect(garbled.code).toBe(0);
  });

  it('cli/session-end-unusable-no-daemon: in a repo with no daemon running, a SessionEnd it cannot use exits 0 and starts no daemon', async () => {
    const command = `"${process.execPath}" "${CLI_DIST}" track --agent`;
    const dir = await realpath(repo.dir);
    for (const input of [
      { hook_event_name: 'SessionEnd', cwd: dir, reason: 'prompt_input_exit' },
      { hook_event_name: 'SessionEnd', session_id: SESSION, transcript_path: 'relative.jsonl', cwd: dir, reason: 'logout' },
    ]) {
      const run = await runHook(command, dir, input);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toMatch(/^diffcity track: ignoring SessionEnd: hook input: \S.*\n$/);
    }
    expect(await readDaemonInfo(homePaths(temp.home))).toBeNull();
  });

  it('cli/session-end-unusable-input: a SessionEnd whose fields cannot be used sends nothing: no repo row, no collection, exit 0 with one line', async () => {
    const command = `"${process.execPath}" "${CLI_DIST}" track --agent`;
    const dir = await realpath(repo.dir);
    // A running daemon that knows another repo only.
    const other = await createRepo({ name: 'sample-yard', files: { 'src/yard.ts': 'export const yard = 1;\n' } });
    try {
      const started = await runHook(`"${process.execPath}" "${CLI_DIST}" track "${await realpath(other.dir)}"`, temp.userHome, {});
      expect(started).toMatchObject({ code: 0, stdout: 'tracked sample-yard\n' });
      const info = await readDaemonInfo(homePaths(temp.home));
      if (info === null) throw new Error('track did not start the daemon');
      const names = async (): Promise<string[]> => (await getJson<RepoSummary[]>(info.port, '/api/repos')).map((listed) => listed.name);
      expect(await names()).toEqual(['sample-yard']);

      for (const input of [
        { hook_event_name: 'SessionEnd', cwd: dir },
        { hook_event_name: 'SessionEnd', session_id: SESSION, transcript_path: 'relative.jsonl', cwd: dir, reason: 'clear' },
        { hook_event_name: 'SessionEnd', session_id: SESSION, transcript_path: join(claude, 'projects', 'x', `${SESSION}.jsonl`), cwd: 'relative/dir' },
      ]) {
        const run = await runHook(command, dir, input);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe('');
        expect(run.stderr).toMatch(/^diffcity track: ignoring SessionEnd: hook input: \S.*\n$/);
      }
      // Long enough for a stray track to register and collect sample-depot.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await names()).toEqual(['sample-yard']);
    } finally {
      await other.cleanup();
    }
  });
});
