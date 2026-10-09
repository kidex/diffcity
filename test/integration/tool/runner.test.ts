// The hardened tool runner (ADR-032), against stub binaries on a temporary
// PATH. Nothing here reaches a real tool or the network.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GH_PROFILE, createLimiter, runTool, toolArgs, type Limiter, type ToolContext, type ToolOutcome } from '../../../src/core/exec/index.js';
import { readToolSetting } from '../../../src/core/settings/index.js';
import { alive, createToolStubs, eventually, type ToolStubs } from '../../helpers/tool-stub.js';

let stubs: ToolStubs;
let scratch: string;
let repo: string;

const SYSTEM_PATH = '/usr/bin:/bin';
const any = (json: unknown): unknown => json;

beforeAll(async () => {
  stubs = await createToolStubs(['gh']);
  await stubs.warm();
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'diffcity-tool-runner-')));
  repo = join(scratch, 'sample-shop');
  await mkdir(repo);
}, 120_000);

afterAll(async () => {
  await stubs.cleanup();
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  await stubs.clear();
  await stubs.mode('json', { stdout: '{"ok":true}' });
});

interface GhOptions<T> {
  parse?: (json: unknown) => T | undefined;
  env?: Record<string, string | undefined>;
  context?: ToolContext;
  timeoutMs?: number;
}

/** Runs gh with the stub first on PATH; `env` adds to (or overrides) a minimal environment. */
function gh<T = unknown>(argv: readonly string[], options: GhOptions<T> = {}): Promise<ToolOutcome<T>> {
  const parse = (options.parse ?? any) as (json: unknown) => T | undefined;
  return runTool(
    GH_PROFILE,
    toolArgs(GH_PROFILE, argv),
    { cwd: repo, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), parse },
    { env: { PATH: `${stubs.bin}:${SYSTEM_PATH}`, HOME: scratch, ...options.env }, limiter: createLimiter(), ...options.context },
  );
}

const shim = (path: string, body: string): Promise<void> => writeFile(path, `#!/bin/sh\n${body}\n`, { encoding: 'utf8', mode: 0o755 });

describe('tool runner', () => {
  it('tool/argv-no-shell: every argument reaches the tool as one argv entry, never through a shell', async () => {
    const argv = ['a b', '$(touch injected)', ';', 'touch injected', '|', '`touch injected`', "'quoted'", '*', '--json'];
    const outcome = await gh(argv);
    expect(outcome).toEqual({ kind: 'ok', value: { ok: true } });
    const [record] = await stubs.records();
    expect(record?.argv).toEqual(argv);
    expect(record?.cwd).toBe(repo);
    expect(existsSync(join(repo, 'injected'))).toBe(false);
  });

  it('tool/binary-in-repo-refused: a binary inside a registered repo or the call repo never runs', async () => {
    const shims = join(repo, 'node_modules', '.bin');
    await mkdir(shims, { recursive: true });
    await shim(join(shims, 'gh'), 'echo "{}"');
    const other = join(scratch, 'other-repo');
    await mkdir(join(other, 'bin'), { recursive: true });
    await shim(join(other, 'bin', 'gh'), 'echo "{}"');

    const inCallRepo = await gh(['pr', 'list'], { env: { PATH: `${shims}:${stubs.bin}:${SYSTEM_PATH}` } });
    expect(inCallRepo).toMatchObject({ kind: 'error', message: expect.stringContaining('inside the repo') as unknown });

    const inRegistered = await gh(['pr', 'list'], {
      env: { PATH: `${join(other, 'bin')}:${stubs.bin}:${SYSTEM_PATH}` },
      context: { repoRoots: () => [other] },
    });
    expect(inRegistered).toMatchObject({ kind: 'error', message: expect.stringContaining(`inside the repo ${other}`) as unknown });

    const fromSettings = await gh(['pr', 'list'], { context: { toolSetting: () => Promise.resolve({ kind: 'path', path: join(shims, 'gh') }) } });
    expect(fromSettings).toMatchObject({ kind: 'error', message: expect.stringContaining('inside the repo') as unknown });

    expect(await stubs.records()).toEqual([]);
    await rm(join(repo, 'node_modules'), { recursive: true, force: true });
  });

  it('tool/relative-path-entry-skipped: empty, `.` and relative PATH entries are never searched', async () => {
    await mkdir(join(repo, 'bin'), { recursive: true });
    for (const path of [join(repo, 'gh'), join(repo, 'bin', 'gh')]) await shim(path, `echo '{"shim":true}'`);
    const outcome = await gh(['pr', 'list'], { env: { PATH: `::.:bin:./bin:${stubs.bin}:${SYSTEM_PATH}` } });
    expect(outcome).toEqual({ kind: 'ok', value: { ok: true } });
    expect(await stubs.records()).toHaveLength(1);

    expect((await gh(['pr', 'list'], { env: { PATH: '.:bin' } })).kind).toBe('missing');
    await rm(join(repo, 'bin'), { recursive: true, force: true });
    await rm(join(repo, 'gh'), { force: true });
  });

  it('tool/env-allowlist: only the allowed variables pass, and the guards are added', async () => {
    const outcome = await gh(['pr', 'list'], {
      env: {
        USER: 'sample-user',
        LANG: 'C',
        LC_ALL: 'C',
        TMPDIR: scratch,
        HTTPS_PROXY: 'http://proxy.invalid:3128',
        GH_TOKEN: 'tok-1',
        GH_HOST: 'github.invalid',
        // Not allowed: dropped.
        AWS_SECRET_ACCESS_KEY: 'sec-1',
        GIT_DIR: '/elsewhere',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: '/elsewhere/hook',
        npm_config_userconfig: '/elsewhere/npmrc',
        NODE_OPTIONS: '--require /elsewhere/hook.js',
        DIFFCITY_HOME: '/elsewhere/home',
      },
    });
    expect(outcome.kind).toBe('ok');
    const [record] = await stubs.records();
    const env = { ...record?.env };
    // Set by the shell itself.
    for (const name of ['PWD', 'SHLVL', '_', 'OLDPWD']) Reflect.deleteProperty(env, name);
    expect(env).toEqual({
      PATH: `${stubs.bin}:${SYSTEM_PATH}`,
      HOME: scratch,
      USER: 'sample-user',
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: scratch,
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      GH_TOKEN: 'tok-1',
      GH_HOST: 'github.invalid',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: devNull,
      GIT_ALLOW_PROTOCOL: '',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_ignore_scripts: 'true',
    });
  });

  it('tool/stdout-cap: more than 16 MiB on stdout is an error, not a result', async () => {
    await stubs.mode('flood-stdout');
    expect(await gh(['pr', 'list'])).toMatchObject({ kind: 'error', message: expect.stringContaining('16 MiB') as unknown });
  });

  it('tool/stdout-cap: more than 64 KiB on stderr is an error too', async () => {
    await stubs.mode('flood-stderr');
    expect(await gh(['pr', 'list'])).toMatchObject({ kind: 'error', message: expect.stringContaining('64 KiB') as unknown });
  });

  it('tool/bad-json-is-error: unparseable output is an error, never a pass', async () => {
    await stubs.mode('json', { stdout: 'all good\n' });
    expect(await gh(['pr', 'list'])).toMatchObject({ kind: 'error', message: expect.stringContaining('not JSON') as unknown });
    await stubs.mode('json', { stdout: '' });
    expect((await gh(['pr', 'list'])).kind).toBe('error');
  });

  it('tool/bad-json-is-error: JSON the schema rejects is an error too', async () => {
    await stubs.mode('json', { stdout: '{"state":"SOMETHING"}' });
    const outcome = await gh(['pr', 'view', '7', '--json', 'state'], {
      parse: (json) => (typeof json === 'object' && json !== null && 'state' in json && json.state === 'OPEN' ? 'OPEN' : undefined),
    });
    expect(outcome).toMatchObject({ kind: 'error', message: expect.stringContaining('unexpected JSON') as unknown });
  });

  // These PATHs hold only a test directory: a machine whose /usr/bin has a real gh must still answer `missing`.
  it('tool/missing-binary: no binary on the PATH is `missing`', async () => {
    const empty = join(scratch, 'empty-bin');
    await mkdir(empty, { recursive: true });
    expect(await gh(['pr', 'list'], { env: { PATH: empty } })).toMatchObject({ kind: 'missing' });
  });

  it('tool/missing-binary: a non-executable file on the PATH is not a binary', async () => {
    const dir = join(scratch, 'plain');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'gh'), '#!/bin/sh\n', 'utf8');
    await chmod(join(dir, 'gh'), 0o644);
    expect((await gh(['pr', 'list'], { env: { PATH: dir } })).kind).toBe('missing');
  });

  it('tool/missing-binary: a settings.tools path that does not exist stops the tool, with no PATH fallback', async () => {
    const settings = join(scratch, 'settings.json');
    await writeFile(settings, JSON.stringify({ v: 1, trustedRepos: [], tools: { gh: join(scratch, 'no-such-gh') } }), 'utf8');
    const outcome = await gh(['pr', 'list'], { context: { toolSetting: (name) => readToolSetting(settings, name) } });
    expect(outcome).toMatchObject({ kind: 'error', message: expect.stringContaining('does not exist') as unknown });
    expect(await stubs.records()).toEqual([]);
  });

  it('settings.tools names the binary to run, wherever the PATH points', async () => {
    const settings = join(scratch, 'settings-ok.json');
    await writeFile(settings, JSON.stringify({ v: 1, trustedRepos: [], tools: { gh: stubs.path('gh') } }), 'utf8');
    const outcome = await gh(['pr', 'list'], { env: { PATH: SYSTEM_PATH }, context: { toolSetting: (name) => readToolSetting(settings, name) } });
    expect(outcome.kind).toBe('ok');
    expect(await stubs.records()).toHaveLength(1);
  });

  it('classifies a failing gh and redacts its stderr in the outcome and the log', async () => {
    const leaked = ['gh', 'p_', 'aB3dE5fG7hJ9kL2mN4pQ6rS8tV0wX1yZaB3d'].join('');
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(`info ${m}`), warn: (m: string) => lines.push(`warn ${m}`) };

    await stubs.mode('fail', { stderr: `To get started with GitHub CLI, please run:  gh auth login\nusing ${leaked}\n`, code: 4 });
    const unavailable = await gh(['pr', 'list'], { context: { log } });
    expect(unavailable.kind).toBe('unavailable');
    expect(JSON.stringify(unavailable)).not.toContain(leaked);
    expect(JSON.stringify(unavailable)).toContain('[redacted:github-token]');

    await stubs.mode('fail', { stderr: 'error connecting to api.github.com\n' });
    expect((await gh(['pr', 'list'], { context: { log } })).kind).toBe('offline');

    await stubs.mode('fail', { stderr: 'HTTP 502: something odd\n' });
    expect((await gh(['pr', 'list'], { context: { log } })).kind).toBe('error');

    await stubs.mode('json', { stdout: '[]' });
    expect((await gh(['pr', 'list'], { context: { log } })).kind).toBe('ok');

    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).not.toContain(leaked);
    expect(lines[0]).toContain(`warn tool gh argv=["pr","list"] cwd=${repo} outcome=unavailable exit=4 duration=`);
    expect(lines[0]).toContain('[redacted:github-token]');
    expect(lines[3]).toMatch(/^info tool gh argv=\["pr","list"\] cwd=\S+ outcome=ok exit=0 duration=\d+ms$/);
  });

  it('refuses input for a profile whose stdin is closed', async () => {
    const outcome = await runTool(GH_PROFILE, toolArgs(GH_PROFILE, ['pr', 'list']), { cwd: repo, input: 'hello', parse: any }, { env: { PATH: `${stubs.bin}:${SYSTEM_PATH}` } });
    expect(outcome).toMatchObject({ kind: 'error', message: 'gh takes no input' });
    expect(await stubs.records()).toEqual([]);
  });

  it('runs one tool process per repo at a time', async () => {
    const limiter = createLimiter();
    const seen: number[] = [];
    const counting: Limiter = {
      get active() {
        return limiter.active;
      },
      run: (key, task) =>
        limiter.run(key, () => {
          seen.push(limiter.active);
          return task();
        }),
    };
    const outcomes = await Promise.all([1, 2, 3].map(() => gh(['pr', 'list'], { context: { limiter: counting } })));
    expect(outcomes.map((o) => o.kind)).toEqual(['ok', 'ok', 'ok']);
    expect(seen).toEqual([1, 1, 1]);
  });

  // Last in the file: on a machine where macOS stalls process starts, the calls
  // after a killed group can stall too, and nothing runs after these.
  // The stub sleeps 600 s; the call's timeout is 3 s. Only "the group is gone" is asserted, never a duration.
  it.each(['sleep', 'sleep-ignore-term'] as const)('tool/timeout-kills-group: on timeout the tool and what it started are gone (%s)', async (mode) => {
    await stubs.mode(mode);
    const outcome = await gh(['pr', 'list'], { timeoutMs: 3000, context: { killGraceMs: 200 } });
    expect(outcome.kind).toBe('timeout');
    const [record] = await stubs.records();
    expect(record, 'the stub never started within the timeout (a stalled exec?); rerun this file alone').toBeDefined();
    const grandchild = Number((await readFile(join(stubs.dir, 'grandchild'), 'utf8')).trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await eventually(() => !alive(grandchild) && !alive(record?.pid ?? 0), 10_000)).toBe(true);
  });

  it('tool/timeout-kills-group: a caller that would exit right after the timeout still kills the group first', async () => {
    await stubs.mode('orphan-ignore-term');
    // A separate node process plays a CLI: it runs one gh call through the built runner and then has nothing left
    // to do. Only the runner's own SIGKILL timer may keep it alive until the group is gone.
    const runner = fileURLToPath(new URL('../../../dist/core/exec/index.js', import.meta.url));
    const script = [
      `const { GH_PROFILE, createLimiter, runTool, toolArgs } = await import(${JSON.stringify(runner)});`,
      `const outcome = await runTool(GH_PROFILE, toolArgs(GH_PROFILE, ['pr', 'list']), { cwd: ${JSON.stringify(repo)}, timeoutMs: 3000, parse: (j) => j },`,
      `  { env: { PATH: ${JSON.stringify(`${stubs.bin}:${SYSTEM_PATH}`)}, HOME: ${JSON.stringify(scratch)} }, limiter: createLimiter(), killGraceMs: 1000 });`,
      'console.log(outcome.kind);',
    ].join('\n');
    const printed = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 60_000 }, (error, stdout) => {
        if (error === null) resolve(stdout.trim());
        else reject(new Error("the caller process failed", { cause: error }));
      });
    });
    expect(printed).toBe('timeout');
    const [record] = await stubs.records();
    expect(record, 'the stub never started within the timeout (a stalled exec?); rerun this file alone').toBeDefined();
    const grandchild = Number((await readFile(join(stubs.dir, 'grandchild'), 'utf8')).trim());
    expect(grandchild).toBeGreaterThan(0);
    try {
      // Reaping by launchd may take a moment; an orphan would live for its full 600 s.
      expect(await eventually(() => !alive(grandchild), 3000)).toBe(true);
    } finally {
      if (alive(grandchild)) process.kill(grandchild, 'SIGKILL');
    }
  });
});
