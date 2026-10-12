// `diffcity diff --json --with-sessions` and the separation of session data
// from the Report (ADR-038, ADR-002): sessions come only from the daemon and
// only with the flag; `diff --json`, the served Report and the export path
// never carry them. Invented repos and transcripts in temporary directories.

import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { NO_DAEMON_FOR_SESSIONS, runDiff, sessionsFromDaemon, type DiffDeps } from '../../../src/cli/diff.js';
import { homePaths } from '../../../src/core/home.js';
import type { Report } from '../../../src/core/report/types.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { startFakeDaemon } from '../../helpers/fake-daemon.js';
import { transcript } from '../../helpers/transcript.js';
import { cleanupAfterEach, sampleRepo } from '../collect/collect-helpers.js';
import { claudeDir, sessionDaemon, sessionId, type ClaudeDir } from './session-helpers.js';

cleanupAfterEach();

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SECRET_PROMPT = 'Prompt that must stay out of reports';
/** Every key a Report may have (`checks` only when rules ran). */
const REPORT_KEYS = ['checks', 'findings', 'meta', 'packages', 'specNotice', 'steps', 'summary'];

const claudes: ClaudeDir[] = [];
const homes: TempHome[] = [];
afterEach(async () => {
  for (const claude of claudes.splice(0)) await claude.cleanup();
  for (const home of homes.splice(0)) await home.cleanup();
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function diff(cwd: string, options: Parameters<typeof runDiff>[0], sessions?: DiffDeps['sessions']): Promise<Run> {
  const out = { stdout: '', stderr: '' };
  const code = await runDiff(options, {
    cwd,
    io: { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    now: '2026-09-01T12:00:00Z',
    sessions,
  });
  return { code, ...out };
}

/** A repo on `feature/cart` with a session linked to its change, in a running in-process daemon. */
async function linkedScenario(): Promise<{ dir: string; env: NodeJS.ProcessEnv; changeId: number; get: (path: string) => Promise<Response> }> {
  const repo = await sampleRepo();
  await repo.branch('feature/cart');
  await repo.commit('count the cart', { 'src/cart/count.ts': 'export const count = (items: number[]): number => items.length;\n' });
  const dir = await realpath(repo.dir);
  const claude = await claudeDir();
  claudes.push(claude);
  const daemon = await sessionDaemon(claude);
  const id = sessionId(41);
  const main = transcript({ sessionId: id, cwd: dir }).prompt(SECRET_PROMPT);
  main.agent({ agentId: 'dev1', type: 'dev', foreground: { report: 'Agent report text', durationMs: 1, toolUses: 1 } });
  await claude.write(id, main);
  await daemon.hook(dir, { sessionId: id, transcriptPath: claude.transcriptPath(id), cwd: dir, event: 'Stop' });
  const row = await daemon.until(id, (current) => current.digest !== null && daemon.db.sessions.links(current.id).length === 1);
  const changeId = daemon.db.sessions.links(row.id)[0]?.changeId ?? 0;
  await daemon.test.idle();
  return { dir, env: daemon.test.home.env, changeId, get: (path) => daemon.get(path) };
}

describe('diff --with-sessions', () => {
  it('session/diff-with-sessions-needs-daemon: no daemon, a daemon that predates sessions, or no --json: a clear error and exit 1', async () => {
    const repo = await sampleRepo();
    const home = await tempHome();
    homes.push(home);
    const noDaemon = await diff(repo.dir, { json: true, withSessions: true }, () => sessionsFromDaemon(repo.dir, home.env));
    expect(noDaemon).toEqual({ code: 1, stdout: '', stderr: `diffcity diff: ${NO_DAEMON_FOR_SESSIONS}\n` });
    // No fetcher at all is the same error, never a silent Report without sessions.
    expect((await diff(repo.dir, { json: true, withSessions: true })).stderr).toBe(`diffcity diff: ${NO_DAEMON_FOR_SESSIONS}\n`);

    const fake = await startFakeDaemon(homePaths(home.home));
    try {
      const old = await diff(repo.dir, { json: true, withSessions: true }, () => sessionsFromDaemon(repo.dir, home.env));
      expect(old.code).toBe(1);
      expect(old.stdout).toBe('');
      expect(old.stderr).toMatch(/^diffcity diff: the running daemon \(v[^)]+\) predates --with-sessions; restart it with diffcity stop and diffcity up\n$/);
    } finally {
      await fake.close();
    }
    expect(await diff(repo.dir, { withSessions: true }, () => Promise.resolve({ ok: true, sessions: [] }))).toEqual({
      code: 1,
      stdout: '',
      stderr: 'diffcity diff: --with-sessions needs --json\n',
    });
  });

  it('adds the sessions the daemon serves for the change under a sessions key next to the Report keys', async () => {
    const { dir, env, changeId, get } = await linkedScenario();
    const run = await diff(dir, { json: true, withSessions: true }, () => sessionsFromDaemon(dir, env));
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const output = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(Object.keys(output)).toContain('sessions');
    expect(Object.keys(output).filter((key) => key !== 'sessions').every((key) => REPORT_KEYS.includes(key))).toBe(true);
    const fromApi = (await (await get(`/api/changes/${String(changeId)}/sessions`)).json()) as { sessions: unknown };
    expect(output.sessions).toEqual(fromApi.sessions);
    expect(JSON.stringify(output.sessions)).toContain(SECRET_PROMPT);
  });
});

describe('session data stays out of the Report', () => {
  it('session/diff-json-has-no-session-data: diff --json, the served Report and the export path carry no session data', async () => {
    const { dir, changeId, get } = await linkedScenario();

    // diff --json without the flag: the Report's keys only, no session content, and the daemon is not asked.
    let asked = false;
    const plain = await diff(dir, { json: true }, () => {
      asked = true;
      return Promise.resolve({ ok: true, sessions: [] });
    });
    expect(plain.code).toBe(0);
    expect(asked).toBe(false);
    expect(Object.keys(JSON.parse(plain.stdout) as object).every((key) => REPORT_KEYS.includes(key))).toBe(true);
    expect(plain.stdout).not.toContain(SECRET_PROMPT);
    expect(plain.stdout).not.toContain('Agent report text');

    // The Report the daemon serves, which the change screen and the export render, has none either.
    const served = await get(`/api/changes/${String(changeId)}/report`);
    expect(served.status).toBe(200);
    const body = await served.text();
    expect(Object.keys(JSON.parse(body) as object).every((key) => REPORT_KEYS.includes(key))).toBe(true);
    expect(body).not.toContain(SECRET_PROMPT);
    expect(body).not.toContain('Agent report text');

    // No key of the Report type can hold a session.
    expectTypeOf<keyof Report>().toEqualTypeOf<'meta' | 'packages' | 'steps' | 'findings' | 'checks' | 'specNotice' | 'summary'>();

    // The export path (the standalone page, built from a Report alone) and the Report builder import nothing of sessions.
    for (const folder of ['src/ui/standalone', 'src/core/report']) {
      for (const name of await readdir(join(repoRoot, folder))) {
        if (!name.endsWith('.ts')) continue;
        const source = await readFile(join(repoRoot, folder, name), 'utf8');
        expect(source, `${folder}/${name}`).not.toMatch(/core\/session|SessionView|from '\.\.\/session\//);
      }
    }
  });
});
