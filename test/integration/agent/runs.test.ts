// Agent runs (ADR-029): the run log, the agent-run event, the limits, the
// timeout and the daemon's shutdown, all through the ADR-032 runner, against
// a stub claude only.

import { lstat, readFile, readdir, realpath, utimes, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../../src/core/db/index.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { waitFor } from '../../helpers/daemon.js';
import { alive, createToolStubs, eventually, type ToolStubs } from '../../helpers/tool-stub.js';
import {
  DAEMON_ONLY,
  FAKE_KEY,
  REWRITE_NOTE,
  RESULT_SESSION,
  SESSION,
  agentRunEvents,
  claudeResult,
  enabled,
  linkSession,
  preview,
  run,
  seedChange,
  startAgentDaemon,
  type AgentDaemon,
} from './agent-helpers.js';

let stubs: ToolStubs;
let claude: string;
let test: AgentDaemon | null = null;

beforeAll(async () => {
  stubs = await createToolStubs(['claude'], { stdin: true });
  await stubs.warm();
  claude = await realpath(stubs.path('claude'));
}, 120_000);

afterAll(async () => {
  await stubs.cleanup();
});

beforeEach(async () => {
  await stubs.clear();
  await stubs.mode('json', { stdout: `starting\n${claudeResult()}` });
});

afterEach(async () => {
  await test?.close();
  test = null;
});

async function started(options: Parameters<typeof startAgentDaemon>[0]['plugin'] = {}): Promise<AgentDaemon> {
  test = await startAgentDaemon({ stubs, plugin: options });
  return test;
}

/** Previews and runs; returns the run id. */
async function launch(daemon: AgentDaemon, changeId: number): Promise<string> {
  const shown = await preview(daemon, changeId);
  expect(shown.refusals).toEqual([]);
  const answer = await run(daemon, changeId, { token: shown.token, summaryHash: shown.summaryHash });
  expect(answer.status).toBe(202);
  return (answer.json() as { runId: string }).runId;
}

const grandchild = (): Promise<number> =>
  waitFor(async () => {
    const text = (await readFile(join(stubs.dir, 'grandchild'), 'utf8').catch(() => '')).trim();
    return text === '' ? undefined : Number(text);
  }, 30_000, 'the stub to start its sleeper');

describe('agent runs', () => {
  it('agent/event-agent-run-recorded: mode, argv, cwd, session, exit code, duration and the result session; the summary only as its hash', async () => {
    const daemon = await started();
    const change = seedChange(daemon);
    await linkSession(daemon, change);
    await daemon.settings(enabled(daemon, stubs));
    const shown = await preview(daemon, change.id);
    const runId = await launch(daemon, change.id);
    await daemon.agent.runs().idle();

    const events = agentRunEvents(daemon);
    expect(events).toHaveLength(1);
    expect(events[0]?.changeId).toBe(change.id);
    expect(events[0]?.payload).toMatchObject({
      runId,
      state: 'done',
      mode: 'resume',
      argv: [claude, '--resume', SESSION, '-p', '--output-format', 'json'],
      summaryHash: shown.summaryHash,
      cwd: daemon.repoDir,
      sessionId: SESSION,
      exitCode: 0,
      durationMs: expect.any(Number) as unknown,
      resultSessionId: RESULT_SESSION,
      logTruncated: false,
      log: `${String(change.id)}-${runId}.log`,
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain(REWRITE_NOTE);
  });

  it('output that is not a JSON result is recorded as failed with no session id, never as success', async () => {
    const daemon = await started();
    const change = seedChange(daemon);
    await daemon.settings(enabled(daemon, stubs));
    await stubs.mode('json', { stdout: 'all done, no JSON\n{"session_id":' });
    await launch(daemon, change.id);
    await daemon.agent.runs().idle();
    expect(agentRunEvents(daemon)[0]?.payload).toMatchObject({ state: 'failed', exitCode: 0, resultSessionId: null });

    await stubs.mode('fail', { stderr: 'quota exceeded', code: 2 });
    await launch(daemon, change.id);
    await daemon.agent.runs().idle();
    expect(agentRunEvents(daemon).map((event) => event.payload['state'])).toEqual(['failed', 'failed']);
  });

  it('agent/log-0600: the run log holds the summary and the output, mode 0600, in a 0700 runs directory', async () => {
    const daemon = await started();
    const change = seedChange(daemon);
    await daemon.settings(enabled(daemon, stubs));
    const shown = await preview(daemon, change.id);
    const runId = await launch(daemon, change.id);
    await daemon.agent.runs().idle();
    const runs = daemon.daemon.context.paths.runs;
    const path = join(runs, `${String(change.id)}-${runId}.log`);
    expect((await lstat(runs)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const text = await readFile(path, 'utf8');
    expect(text).toContain(shown.summary.trimEnd());
    expect(text).toContain(`summary sha256: ${shown.summaryHash}`);
    expect(text).toContain(RESULT_SESSION);
  });

  it('run logs older than 30 days are purged', async () => {
    const daemon = await started();
    const runs = daemon.daemon.context.paths.runs;
    await mkdir(runs, { recursive: true });
    const old = join(runs, '7-00112233445566aa.log');
    const fresh = join(runs, '7-00112233445566bb.log');
    const other = join(runs, 'notes.txt');
    for (const path of [old, fresh, other]) await writeFile(path, 'x');
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);
    await utimes(other, longAgo, longAgo);
    expect(await daemon.agent.runs().purge()).toBe(1);
    expect((await readdir(runs)).sort()).toEqual(['7-00112233445566bb.log', 'notes.txt']);
  });

  it('agent/env-allowlist: the agent sees the allow-list, the claude login variables and the git guards, nothing daemon-only', async () => {
    const daemon = await started();
    const change = seedChange(daemon);
    await daemon.settings(enabled(daemon, stubs));
    await launch(daemon, change.id);
    await daemon.agent.runs().idle();
    const [record] = await stubs.records();
    const env = record?.env ?? {};
    expect(env[DAEMON_ONLY]).toBeUndefined();
    expect(Object.keys(env).filter((name) => name.startsWith('DIFFCITY_'))).toEqual([]);
    expect(env['ANTHROPIC_API_KEY']).toBe(FAKE_KEY);
    expect(env['CLAUDE_CONFIG_DIR']).toBe(process.env['CLAUDE_CONFIG_DIR']);
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['GIT_ALLOW_PROTOCOL']).toBe('');
    expect(env['PATH']).toContain(stubs.bin);
  });

  it('agent/one-run-per-change: one run per change and two in the daemon; the third is refused at preview and at run', async () => {
    await stubs.mode('sleep');
    const daemon = await started();
    await daemon.settings(enabled(daemon, stubs));
    const first = seedChange(daemon, { name: 'first' });
    const second = seedChange(daemon, { name: 'second' });
    const third = seedChange(daemon, { name: 'third' });

    const thirdEarly = await preview(daemon, third.id);
    await launch(daemon, first.id);
    const again = await preview(daemon, first.id);
    expect(again.refusals.map((refusal) => refusal.code)).toEqual(['run-in-progress']);
    expect(again.token).toBeNull();

    await launch(daemon, second.id);
    expect((await preview(daemon, third.id)).refusals.map((refusal) => refusal.code)).toEqual(['run-in-progress']);
    // A token issued before the daemon was full is refused at run.
    const answer = await run(daemon, third.id, { token: thirdEarly.token, summaryHash: thirdEarly.summaryHash });
    expect(answer.json()).toMatchObject({ error: { code: 'run-in-progress' } });
    expect(daemon.agent.runs().active).toBe(2);
    await daemon.agent.runs().stopAll();
    expect(agentRunEvents(daemon).map((event) => event.payload['state'])).toEqual(['stopped', 'stopped']);
  }, 60_000);

  it('agent/timeout-kills-group: at timeoutMinutes the whole group gets SIGTERM, then SIGKILL', async () => {
    await stubs.mode('sleep-ignore-term');
    const daemon = await started({ minuteMs: 5000 });
    const change = seedChange(daemon);
    await daemon.settings(enabled(daemon, stubs, { timeoutMinutes: 1 }));
    const runId = await launch(daemon, change.id);
    const sleeper = await grandchild();
    await daemon.agent.runs().idle();
    expect(await eventually(() => !alive(sleeper), 10_000)).toBe(true);
    expect(agentRunEvents(daemon)[0]?.payload).toMatchObject({ runId, state: 'timeout', exitCode: null });
    const states = (): unknown[] => daemon.events().filter((event) => event.event === 'agent-run').map((event) => event.data['state']);
    await waitFor(() => states().length === 2, 10_000, 'the timeout signal');
    expect(states()).toEqual(['running', 'timeout']);
  }, 60_000);

  it('agent/stop-terminates-runs: the shutdown request (diffcity stop) stops running agents and records them', async () => {
    await stubs.mode('sleep-ignore-term');
    const daemon = await started();
    const change = seedChange(daemon);
    await daemon.settings(enabled(daemon, stubs));
    const runId = await launch(daemon, change.id);
    const sleeper = await grandchild();
    const [record] = await waitFor(async () => {
      const records = await stubs.records();
      return records.length > 0 ? records : undefined;
    }, 10_000, 'the stub record');
    const response = await sendRequest(daemon.daemon.info.socket, { v: 1, type: 'shutdown' });
    expect(response.ok).toBe(true);
    await daemon.daemon.closed;
    expect(daemon.daemon.forced).toBe(false);
    expect(await eventually(() => !alive(sleeper) && !alive(record?.pid ?? 0), 10_000)).toBe(true);
    const db = openDb(daemon.daemon.context.paths.db);
    try {
      const events = db.events.listForRepo(change.repoId).filter((event) => event.type === 'agent-run');
      expect(events.map((event) => (event.payload as Record<string, unknown>)['state'])).toEqual(['stopped']);
      expect((events[0]?.payload as Record<string, unknown>)['runId']).toBe(runId);
    } finally {
      db.close();
    }
  }, 60_000);
});
