// Validating the session of a `track` request (ADR-038) before any read, and
// the reader's own checks on the files it derives. Everything lives under a
// temporary Claude config directory; the real one is never touched.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectsDir, readSessionDigest, SESSION_ID_PATTERN, subagentsDir, validateSession } from '../../../src/core/session/index.js';
import { agentMeta, transcript } from '../../helpers/transcript.js';

const SESSION = '0a1b2c3d-1111-4222-8333-444455556666';

let root: string;
let claudeDir: string;
let projects: string;
let project: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'diffcity-validate-')));
  claudeDir = join(root, 'claude');
  projects = claudeProjectsDir(claudeDir);
  project = join(projects, '-work-shopfront');
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const message = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: SESSION,
  transcriptPath: join(project, `${SESSION}.jsonl`),
  cwd: '/work/shopfront',
  event: 'Stop',
  ...overrides,
});

async function writeTranscript(path = join(project, `${SESSION}.jsonl`)): Promise<string> {
  await writeFile(path, transcript({ sessionId: SESSION }).prompt('Ship the cart badge').jsonl());
  return path;
}

describe('session validation', () => {
  it('accepts a transcript under the projects directory named after the session', async () => {
    const path = await writeTranscript();
    expect(claudeProjectsDir('/claude')).toBe('/claude/projects');
    expect(await validateSession(message(), projects)).toEqual({
      ok: true,
      session: { sessionId: SESSION, transcriptPath: path, cwd: '/work/shopfront', event: 'Stop' },
    });
  });

  it('refuses ids that are not hex and dashes, 8 to 64 long', async () => {
    await writeTranscript();
    for (const id of ['../../etc', 'abc', 'g'.repeat(8), 'a'.repeat(65), 'abcdef01/..', '']) {
      expect(SESSION_ID_PATTERN.test(id)).toBe(false);
      expect(await validateSession(message({ sessionId: id }), projects)).toEqual({ ok: false, code: 'bad-session-id' });
    }
  });

  it('refuses a malformed message, a bad event and a relative cwd', async () => {
    await writeTranscript();
    expect(await validateSession(null, projects)).toEqual({ ok: false, code: 'malformed' });
    expect(await validateSession(message({ transcriptPath: 7 }), projects)).toEqual({ ok: false, code: 'malformed' });
    expect(await validateSession(message({ event: 'Stop now' }), projects)).toEqual({ ok: false, code: 'bad-event' });
    expect(await validateSession(message({ cwd: 'work/shopfront' }), projects)).toEqual({ ok: false, code: 'bad-cwd' });
  });

  it('session/path-outside-projects-refused: a transcript elsewhere, relative, not normalized or not .jsonl is refused', async () => {
    const outside = join(root, 'elsewhere');
    await mkdir(outside);
    await writeTranscript(join(outside, `${SESSION}.jsonl`));
    expect(await validateSession(message({ transcriptPath: join(outside, `${SESSION}.jsonl`) }), projects)).toEqual({ ok: false, code: 'outside-projects' });
    expect(await validateSession(message({ transcriptPath: `${SESSION}.jsonl` }), projects)).toEqual({ ok: false, code: 'bad-transcript-path' });
    expect(await validateSession(message({ transcriptPath: `${project}/../../elsewhere/${SESSION}.jsonl` }), projects)).toEqual({ ok: false, code: 'bad-transcript-path' });
    expect(await validateSession(message({ transcriptPath: join(project, `${SESSION}.json`) }), projects)).toEqual({ ok: false, code: 'bad-transcript-path' });
    // The projects directory itself is not a transcript, and a missing one refuses everything.
    expect(await validateSession(message(), join(root, 'missing', 'projects'))).toEqual({ ok: false, code: 'no-projects-dir' });
    expect(await validateSession(message(), projects)).toEqual({ ok: false, code: 'transcript-missing' });
  });

  it('session/path-symlink-escape-refused: a link named like the transcript, or a project directory linked outside, is refused', async () => {
    const outside = join(root, 'elsewhere');
    await mkdir(outside);
    const secret = join(outside, `${SESSION}.jsonl`);
    await writeTranscript(secret);
    // The file itself is a link.
    await symlink(secret, join(project, `${SESSION}.jsonl`));
    expect(await validateSession(message(), projects)).toEqual({ ok: false, code: 'symlink' });
    // A directory under projects that links outside: lstat sees a file, realpath leaves the projects directory.
    await symlink(outside, join(projects, '-linked'));
    expect(await validateSession(message({ transcriptPath: join(projects, '-linked', `${SESSION}.jsonl`) }), projects)).toEqual({
      ok: false,
      code: 'outside-projects',
    });
  });

  it('session/basename-must-match-session-id: another session file, or a link to one, is refused', async () => {
    const other = '99999999-1111-4222-8333-444455556666';
    await writeTranscript(join(project, `${other}.jsonl`));
    expect(await validateSession(message({ transcriptPath: join(project, `${other}.jsonl`) }), projects)).toEqual({ ok: false, code: 'basename-mismatch' });
    // A directory link inside projects whose target has the right name nowhere: the realpath keeps the name check.
    await mkdir(join(projects, '-real'));
    await writeTranscript(join(projects, '-real', `${SESSION}.jsonl`));
    await symlink(join(projects, '-real'), join(projects, '-alias'));
    const viaAlias = await validateSession(message({ transcriptPath: join(projects, '-alias', `${SESSION}.jsonl`) }), projects);
    expect(viaAlias).toEqual({ ok: true, session: expect.objectContaining({ transcriptPath: join(projects, '-real', `${SESSION}.jsonl`) }) as unknown });
  });

  it('session/subagent-paths-derived-not-taken: extra message fields are ignored; linked subagent files and directories are never followed', async () => {
    const path = await writeTranscript();
    // Extra fields of the message do not reach the validated session.
    const validated = await validateSession(message({ subagentsDir: join(root, 'elsewhere'), agentFiles: ['/etc/hosts'] }), projects);
    expect(validated).toEqual({ ok: true, session: { sessionId: SESSION, transcriptPath: path, cwd: '/work/shopfront', event: 'Stop' } });

    const main = transcript({ sessionId: SESSION }).prompt('Ship it');
    main.agent({ agentId: 'dev1', type: 'dev' });
    main.agent({ agentId: 'dev2', type: 'dev' });
    await writeFile(path, main.jsonl());
    const outside = join(root, 'elsewhere');
    await mkdir(outside, { recursive: true });
    const secret = transcript({ agentId: 'dev1' }).text('SECRET OUTSIDE REPORT');
    await writeFile(join(outside, 'agent-dev1.jsonl'), secret.jsonl());
    await writeFile(join(outside, 'agent-dev1.meta.json'), JSON.stringify(agentMeta({ agentType: 'outside-type' })));

    // A sidechain file that is a link: not read. A real sibling is.
    const subagents = subagentsDir(path);
    await mkdir(subagents, { recursive: true });
    await symlink(join(outside, 'agent-dev1.jsonl'), join(subagents, 'agent-dev1.jsonl'));
    await symlink(join(outside, 'agent-dev1.meta.json'), join(subagents, 'agent-dev1.meta.json'));
    await writeFile(join(subagents, 'agent-dev2.jsonl'), transcript({ agentId: 'dev2' }).text('Real report').jsonl());
    const digest = await readSessionDigest({ transcriptPath: path, active: true, repoRoot: '/work/shopfront' });
    expect(digest.runs.map((run) => [run.agentId, run.type, run.report])).toEqual([
      ['dev1', 'dev', null],
      ['dev2', 'dev', 'Real report'],
    ]);
    expect(JSON.stringify(digest)).not.toContain('SECRET OUTSIDE REPORT');

    // The subagents directory itself a link: nothing under it is read.
    await rm(join(path.slice(0, -'.jsonl'.length)), { recursive: true });
    await mkdir(path.slice(0, -'.jsonl'.length));
    await writeFile(join(outside, 'agent-dev2.jsonl'), transcript({ agentId: 'dev2' }).text('SECRET OUTSIDE REPORT').jsonl());
    await symlink(outside, subagents);
    const linked = await readSessionDigest({ transcriptPath: path, active: true, repoRoot: '/work/shopfront' });
    expect(linked.runs.map((run) => run.report)).toEqual([null, null]);
    expect(JSON.stringify(linked)).not.toContain('SECRET OUTSIDE REPORT');
  });
});
