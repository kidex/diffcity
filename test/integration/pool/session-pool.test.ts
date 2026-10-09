// The session pool with both runners (ADR-038, ADR-021): the same digest
// inline and in a worker thread loaded from dist/ (built by
// test/global-setup.ts), from an invented transcript in a temporary Claude
// config directory.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionPool, SESSION_WORKER_URL, type SessionPool } from '../../../src/daemon/session/pool.js';
import { transcript } from '../../helpers/transcript.js';

const ID = '0a1b2c3d-0000-4000-8000-000000000031';

const pools: SessionPool[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (pools.length > 0) await pools.pop()?.shutdown();
  while (dirs.length > 0) await rm(dirs.pop() ?? '', { recursive: true, force: true });
});

describe('session pool runners', () => {
  it('pool/session-thread-runner-dist: the worker is the built dist/daemon/session/worker.js and reads like the inline runner', async () => {
    const path = fileURLToPath(SESSION_WORKER_URL);
    expect(path.endsWith(['dist', 'daemon', 'session', 'worker.js'].join('/'))).toBe(true);
    expect(existsSync(path)).toBe(true);

    const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-session-pool-')));
    dirs.push(root);
    const project = join(root, 'projects', '-work-shopfront');
    await mkdir(project, { recursive: true });
    const transcriptPath = join(project, `${ID}.jsonl`);
    await writeFile(transcriptPath, transcript({ sessionId: ID }).prompt('Ship the cart badge').jsonl());

    const job = { sessionId: ID, transcriptPath, projectsDir: join(root, 'projects'), previous: null, repoRoot: '/work/shopfront', active: true, home: '/Users/robin' };
    const inline = createSessionPool({ runner: 'inline' });
    const thread = createSessionPool({ runner: 'thread' });
    pools.push(inline, thread);
    const [a, b] = await Promise.all([inline.submit('s', 'normal', job), thread.submit('s', 'normal', job)]);
    expect(b).toEqual(a);
    expect(a).toMatchObject({ ok: true, title: 'Ship the cart badge', grew: false });

    // A path outside the projects directory is refused in the worker too, by code.
    const refused = await thread.submit('s', 'normal', { ...job, projectsDir: join(root, 'other') });
    expect(refused).toEqual({ ok: false, code: 'no-projects-dir' });
  });
});
