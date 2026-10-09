// The tool runner's sink mode and abort (ADR-032 as extended for agent runs,
// ADR-029): output streamed to a 0600 log with a cap that never stops the
// tool, the result read from the last JSON object of stdout, a caller's abort
// stopping the whole group after the profile's grace, and the binary bound to
// the one the caller confirmed. A stub claude only.

import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_PROFILE, createLimiter, resolveTool, runToolDetailed, sinkTruncatedNote, toolArgs, type ToolContext, type ToolProfile } from '../../../src/core/exec/index.js';
import { alive, createToolStubs, eventually, type ToolStubs } from '../../helpers/tool-stub.js';

let stubs: ToolStubs;
let scratch: string;
let tree: string;
let logs: string;

const SYSTEM_PATH = '/usr/bin:/bin';
const SESSION = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
/** The claude profile with a short grace, so the SIGKILL tests are quick. */
const PROFILE: ToolProfile = { ...CLAUDE_PROFILE, killGraceMs: 300 };
const ARGS = toolArgs(PROFILE, ['-p', '--output-format', 'json']);
const sessionOf = (json: unknown): string | undefined =>
  typeof json === 'object' && json !== null && typeof (json as Record<string, unknown>)['session_id'] === 'string' ? ((json as Record<string, unknown>)['session_id'] as string) : undefined;

const context = (): ToolContext => ({ env: { PATH: `${stubs.bin}:${SYSTEM_PATH}`, HOME: scratch }, limiter: createLimiter() });

let counter = 0;
const logPath = (): string => join(logs, `run-${String(++counter)}.log`);

beforeAll(async () => {
  stubs = await createToolStubs(['claude'], { stdin: true });
  await stubs.warm();
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'diffcity-tool-sink-')));
  tree = join(scratch, 'sample-shop');
  logs = join(scratch, 'runs');
  await mkdir(tree);
  await mkdir(logs);
}, 120_000);

afterAll(async () => {
  await stubs.cleanup();
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  await stubs.clear();
});

describe('tool runner sink mode', () => {
  it('writes stdout and stderr to a 0600 log, gives the stdin input, and reads the last JSON object', async () => {
    await stubs.mode('json', { stdout: `working...\n{"type":"result","session_id":"${SESSION}"}` });
    const path = logPath();
    const run = await runToolDetailed(PROFILE, ARGS, { cwd: tree, input: '# Review\n\n- fix it\n', parse: sessionOf, sink: { path, capBytes: 1024 * 1024 } }, context());
    expect(run.outcome).toEqual({ kind: 'ok', value: SESSION });
    expect(run).toMatchObject({ exitCode: 0, stopped: null, truncated: false, result: SESSION });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toContain(`"session_id":"${SESSION}"`);
    const [record] = await stubs.records();
    expect(record?.stdin).toBe('# Review\n\n- fix it\n');
    expect(record?.cwd).toBe(tree);
  });

  it('unparseable output is an error and gives no result, never a success', async () => {
    await stubs.mode('json', { stdout: 'no json here\n{"half":' });
    const run = await runToolDetailed(PROFILE, ARGS, { cwd: tree, input: 'x', parse: sessionOf, sink: { path: logPath(), capBytes: 1024 * 1024 } }, context());
    expect(run.outcome).toMatchObject({ kind: 'error', message: expect.stringContaining('no JSON result') as unknown });
    expect(run.result).toBeUndefined();
    expect(run.exitCode).toBe(0);
  });

  it('past the cap the log stops with a note while the tool runs to its end; the 16 MiB stdout cap does not apply', async () => {
    await stubs.mode('flood-stdout');
    const path = logPath();
    const cap = 64 * 1024;
    const run = await runToolDetailed(PROFILE, ARGS, { cwd: tree, input: 'x', parse: sessionOf, sink: { path, capBytes: cap } }, context());
    expect(run.exitCode).toBe(0);
    expect(run.stopped).toBeNull();
    expect(run.truncated).toBe(true);
    const text = await readFile(path, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(cap);
    expect(text.endsWith(sinkTruncatedNote(cap))).toBe(true);
  }, 120_000);

  it('a log path that is a symbolic link is refused before the tool starts', async () => {
    await stubs.mode('json', { stdout: '{}' });
    const target = join(scratch, 'elsewhere.txt');
    await writeFile(target, 'keep\n');
    const path = logPath();
    await symlink(target, path);
    const run = await runToolDetailed(PROFILE, ARGS, { cwd: tree, input: 'x', parse: sessionOf, sink: { path, capBytes: 1024 } }, context());
    expect(run.outcome).toMatchObject({ kind: 'error', message: expect.stringContaining('cannot open its log') as unknown });
    expect(await readFile(target, 'utf8')).toBe('keep\n');
    expect(await stubs.records()).toEqual([]);
  });
});

describe('tool runner abort and binding', () => {
  it('an abort stops the group: SIGTERM, then SIGKILL after the profile grace for what ignores it', async () => {
    await stubs.mode('sleep-ignore-term');
    const controller = new AbortController();
    let pid: number | undefined;
    const running = runToolDetailed(
      PROFILE,
      ARGS,
      {
        cwd: tree,
        input: 'x',
        parse: sessionOf,
        sink: { path: logPath(), capBytes: 1024 },
        signal: controller.signal,
        onSpawn: (spawned) => {
          pid = spawned;
        },
      },
      context(),
    );
    const grandchild = join(stubs.dir, 'grandchild');
    expect(await eventually(async () => (await readFile(grandchild, 'utf8').catch(() => '')).trim() !== '', 30_000)).toBe(true);
    const sleeper = Number((await readFile(grandchild, 'utf8')).trim());
    controller.abort();
    const run = await running;
    expect(run.stopped).toBe('aborted');
    expect(run.outcome).toMatchObject({ kind: 'error', message: expect.stringContaining('was stopped') as unknown });
    expect(pid).toBeGreaterThan(0);
    expect(await eventually(() => !alive(sleeper) && pid !== undefined && !alive(pid), 10_000)).toBe(true);
  }, 60_000);

  it('a call already aborted never starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runToolDetailed(PROFILE, ARGS, { cwd: tree, input: 'x', parse: sessionOf, signal: controller.signal }, context());
    expect(run.outcome.kind).toBe('error');
    expect(await stubs.records()).toEqual([]);
  });

  it('a binary other than the confirmed one is refused', async () => {
    await stubs.mode('json', { stdout: '{}' });
    const run = await runToolDetailed(PROFILE, ARGS, { cwd: tree, input: 'x', parse: sessionOf, binary: '/opt/elsewhere/claude' }, context());
    expect(run.outcome).toMatchObject({ kind: 'error', message: expect.stringContaining('as confirmed') as unknown });
    expect(await stubs.records()).toEqual([]);
  });

  it('resolveTool tells a binary inside a repo from a missing one', async () => {
    const resolved = await resolveTool(PROFILE, tree, context());
    expect(resolved).toEqual({ ok: true, binary: await realpath(stubs.path('claude')) });
    expect(await resolveTool(PROFILE, tree, { env: { PATH: SYSTEM_PATH } })).toMatchObject({ ok: false, why: 'missing' });
    expect(await resolveTool(PROFILE, tree, { ...context(), repoRoots: () => [stubs.dir] })).toMatchObject({ ok: false, why: 'in-repo' });
  });
});
